# Configuration

The server reads its settings from environment variables. These settings control where the server listens, where it keeps its data, and who owns it. There is no configuration file.

## Local mode and server mode

The same program runs in two modes. The mode decides how a request proves who sent it.

In local mode you are the owner. The server listens on the loopback address, and a request from this machine needs no token. The web UI opens signed in, and commands run without `--token`. A request counts as yours when three conditions hold:

- Its `Host` header is a loopback name: `localhost`, `127.0.0.1` or `[::1]`.
- The connection comes from a loopback address.
- It carries none of these proxy or tunnel headers: `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`, `CF-Connecting-IP`.

Any other request needs a token or signed-in session. Both modes refuse browser requests made from another site's page when signing in or using a session cookie.

In server mode every request to a project needs a token or a browser that is signed in. A few addresses answer without either, including `/healthz`, `/docs` and the sign-in endpoints. See [What answers without a token](#what-answers-without-a-token). The web UI shows a sign-in page, and a command needs `--token` or `MAINWORTHY_TOKEN`. [People, agents and pipelines](./access.md#sign-in-to-the-web-ui) explains tokens and signing in.

Either `MAINWORTHY_MODE=server` or a non-loopback `MAINWORTHY_HOST` selects server mode. Setting `MAINWORTHY_MODE=local` does not override a non-loopback host. Every other start is local mode. The first line the server prints says which mode it is in:

```
$ mainworthy serve
Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
project "scratch" · you are robin@this-machine · policy: loose
```

> [!WARNING]
> When anything sits between users and the server, set `MAINWORTHY_MODE=server`. Local mode does not treat a proxy that adds headers as the owner. However, it cannot distinguish you from a relay on the same machine that forwards bytes unchanged. Local mode trusts everyone who reaches that relay as the owner.

## Variables the server reads

`mainworthy` with no command, or `mainworthy serve`, starts the server. The server reads the following environment variables.

| Variable | Default | What it sets |
| --- | --- | --- |
| `MAINWORTHY_HOST` | `127.0.0.1` | The address to listen on. Use `0.0.0.0` to listen on every interface. A value that is not loopback selects server mode. |
| `MAINWORTHY_PORT` | `PORT`, else `7357` | The port to listen on. |
| `MAINWORTHY_DATA` | `~/.mainworthy` | The data directory. It holds `mainworthy.db`, its WAL and shared-memory files while running, `server.lock` (with `server.lock-journal` while a server holds it), `blobs/` for result attachments, and `spool/` for archive transfers. |
| `MAINWORTHY_LOCK_WAIT_SECONDS` | `30` | Seconds to wait for another server to release the data directory. A finite nonnegative number, including fractions. `0` refuses immediately. |
| `MAINWORTHY_MODE` | none | `server` selects server mode. |
| `MAINWORTHY_OWNER` | `USER`, else `owner` | The name of the owner, who holds every capability on every project. |
| `MAINWORTHY_OWNER_WAS` | none | The name the owner has now, when `MAINWORTHY_OWNER` holds a new name for the same person. The start renames them. See [rename the owner](#rename-the-owner). |
| `MAINWORTHY_OWNER_TOKEN` | none | An optional token for the owner, 20 to 512 visible ASCII characters without spaces. Without it, server mode generates one when the owner has no working token. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. The same form. |
| `MAINWORTHY_REQUIRE_ADMIN_MFA` | `false` | `true` requires a second factor for password sign-in by anyone with `admin` on any project. See [require a second factor for admins](#require-a-second-factor-for-admins). Other nonempty values except `false` stop startup. |
| `MAINWORTHY_OIDC_ISSUER` | none | The issuer address of an OpenID Connect identity provider, such as `https://login.example.com`. Set it with `MAINWORTHY_OIDC_CLIENT_ID`, `MAINWORTHY_OIDC_CLIENT_SECRET`, `MAINWORTHY_OIDC_NAME` and `MAINWORTHY_PUBLIC_URL`. See [sign in through an identity provider](#sign-in-through-an-identity-provider). |
| `MAINWORTHY_OIDC_CLIENT_ID` | none | The client id the provider gave this instance. |
| `MAINWORTHY_OIDC_CLIENT_SECRET` | none | The client secret the provider gave this instance. |
| `MAINWORTHY_OIDC_NAME` | none | What the sign-in button calls the provider, such as `Okta`: "Sign in with Okta". |
| `MAINWORTHY_OIDC_MFA` | `false` | `true` says that the provider requires a second factor of everybody. Only then can an admin sign in through it when `MAINWORTHY_REQUIRE_ADMIN_MFA` is `true`. Other nonempty values stop startup. |
| `MAINWORTHY_PUBLIC_URL` | none | The address people open the instance at, such as `https://mainworthy.example`. A passkey belongs to its host name, and an invitation link starts with it. Without it there are no passkeys and `mainworthy invite` prints a link with no host. |
| `MAINWORTHY_SMTP_HOST` | none | SMTP host. Set it with `MAINWORTHY_MAIL_FROM` and `MAINWORTHY_PUBLIC_URL` to enable mail. |
| `MAINWORTHY_SMTP_PORT` | `587` | SMTP port, from 1 to 65535. |
| `MAINWORTHY_SMTP_TLS` | `starttls` | `starttls` requires an encrypted upgrade. `tls` starts encrypted, usually on port 465. `none` sends without encryption, for a local relay or development server. Certificates are checked in both encrypted modes. |
| `MAINWORTHY_SMTP_USER` | none | SMTP username. Set it with the password, or leave both unset for an unauthenticated relay. |
| `MAINWORTHY_SMTP_PASSWORD` | none | SMTP password, read only from the process environment. It never enters the database, archives, replies or logs. |
| `MAINWORTHY_MAIL_FROM` | none | A single sender email address, such as `mainworthy@example.com`. Display names and address lists are refused. |
| `MAINWORTHY_APPLE_APPS` | none | The iPhone apps whose sign-in screen may offer the logins the phone keeps for this site. List each app as a team id and a bundle identifier (`ABCDE12345.com.mainworthy.app`). Separate the entries with commas. The server lists them at `/.well-known/apple-app-site-association`. Without it that address is not found. See [the iPhone app](./iphone.md#sign-in). |
| `MAINWORTHY_TRUSTED_PROXY` | none | The addresses or CIDR ranges of the proxy in front, comma-separated. Set it together with the next one, or neither. |
| `MAINWORTHY_CLIENT_ADDRESS_HEADER` | none | The header in which that proxy reports the visitor's address. Believed only on a connection from a proxy named above. |
| `MAINWORTHY_READERS` | the CPU count minus 2, at least 1 and at most 8 | How many reader threads answer reads, from `0` to `8`. `0` answers them on the main thread. |
| `MAINWORTHY_DEMO` | none | A demo project the server empties and fills with the demo again on every start, once it listens. The demo shows what this build does. Only a demo project is emptied, a project that `mainworthy seed` made. See [a project of demo data](./customize.md#a-project-of-demo-data). |
| `MAINWORTHY_COMMIT` | none | The commit this server was built from, which `/healthz` reports. It must have 40 lower-case hexadecimal characters. If absent or invalid, the server tries `SOURCE_COMMIT`, then reports unknown. |
| `MAINWORTHY_GITHUB_PROJECT` | none | The project allowed to send defects and optional gate commit statuses to GitHub. Set the project, repository, and token together. |
| `MAINWORTHY_GITHUB_REPOSITORY` | none | The destination on github.com, written `owner/repository`. Requests cannot choose another repository. |
| `MAINWORTHY_GITHUB_TOKEN` | none | A token for that repository. Defect requests need Issues write permission. Gate commit statuses need Commit statuses write permission on a fine-grained personal access token, or the `repo:status` scope on a classic token. Keep it in the server's secret environment, outside the repository. It is never stored in the database or an archive. |
| `MAINWORTHY_GITHUB_STATUSES` | `0` | Set to `1` to publish commit gates as GitHub commit statuses. Requires the three GitHub variables and `MAINWORTHY_PUBLIC_URL`. See [GitHub commit statuses](./changes.md#publish-the-gate-as-a-github-commit-status). |
| `MAINWORTHY_JIRA_PROJECT` | none | The Mainworthy project allowed to send Jira defects. Set all six Jira variables together. |
| `MAINWORTHY_JIRA_SITE` | none | The Jira Cloud site as an HTTPS origin, for example `https://example.atlassian.net`, without a path, query, fragment, or embedded credentials. |
| `MAINWORTHY_JIRA_PROJECT_KEY` | none | The Jira destination project key, for example `QA`. Requests cannot choose another project. |
| `MAINWORTHY_JIRA_ISSUE_TYPE` | none | The issue type name available on that project's create screen, for example `Bug`. |
| `MAINWORTHY_JIRA_EMAIL` | none | The Jira account email. Keep it in process configuration. It is never stored in the database or an archive. |
| `MAINWORTHY_JIRA_TOKEN` | none | An API token for that account with Browse projects and Create issues permission. Keep it in the server's secret environment. It is never stored in the database or an archive. |

A value outside the whole numbers `0` through `8` for `MAINWORTHY_READERS` stops startup with `invalid: MAINWORTHY_READERS must be an integer between 0 and 8`. An invalid session duration also stops startup with a line that names the variable. Each entry in `MAINWORTHY_APPLE_APPS` must have a team id and bundle identifier.

For `MAINWORTHY_PUBLIC_URL`, use `https` and a host name with nothing after it, or `http://localhost` with its optional port. The server refuses IP addresses and plain `http` anywhere else because browsers do not make passkeys there. Paths and queries are refused because the server needs the instance's root address.

The server checks configuration before creating the data directory or taking its lock. A refused public address, owner token length or form, or reserved owner name creates no files.

The first start creates the data directory, one owner and a project named `scratch`. It does not need any variable. The server holds `server.lock` in that directory until it stops. Another server using the same directory waits up to `MAINWORTHY_LOCK_WAIT_SECONDS` before it opens the application database. It says once on standard error that it is waiting for another server on the data directory. If the lock is still held at the deadline, startup is refused with `another server is already using this data directory; stop it or choose another MAINWORTHY_DATA`. This permits a replacement to start when the previous server finishes stopping. A deployment must let the previous server stop while the replacement waits. Waiting for the replacement to become healthy first prevents that handoff. The operating system releases the lock if the process is killed. The file stays in place. Do not delete or replace it while a server runs.

A reader thread that fails to start retries after 100 ms, then doubles the wait up to 30 seconds. A thread that becomes ready resets that wait. Reads use ready threads or run inline when none is ready. The server starts without waiting for the full pool.

With reader threads enabled, a background thread checkpoints the write-ahead log every half second. The writer keeps its 20,000-page automatic checkpoint fallback. After readers move on and a checkpoint completes, log reuse trims the file to at most 4 MiB. This retention limit does not change checkpoint timing or cap growth during active snapshots and large transactions. See [data and backups](./data.md).

GitHub Issues and Jira Cloud are optional. Each supports one destination for one project per instance, through the API and command line. See [create or link a tracker defect](./decide.md#create-or-link-a-tracker-defect). A partial or malformed configuration stops the server with a message that names the variables without quoting credentials. If both trackers name the same Mainworthy project, new defects go to Jira. GitHub remains available for commit statuses and existing defect holds.

Every start gives the owner named by `MAINWORTHY_OWNER` every capability. The owner must be a person. The server refuses to start if the name belongs to an agent, a pipeline or a forgotten person, or starts with `forgotten-`.

Changing the variable to a new name creates a second person with every capability. The previous owner keeps their grant and tokens. Remove their grant with `mainworthy actor ungrant` if you no longer want them to administer the instance. Changing `MAINWORTHY_OWNER_TOKEN` to a new value also revokes earlier tokens issued through that variable. To give the same person a new name instead, [rename the owner](#rename-the-owner).

### Turn on mail

To enable mail, configure the server's environment as follows:

1. Set `MAINWORTHY_SMTP_HOST`, `MAINWORTHY_MAIL_FROM` and `MAINWORTHY_PUBLIC_URL`.
2. If your SMTP server requires authentication, set `MAINWORTHY_SMTP_USER` and `MAINWORTHY_SMTP_PASSWORD` together.
3. Set `MAINWORTHY_SMTP_PORT` and `MAINWORTHY_SMTP_TLS` to the provider's values.
4. Restart the server.

The default is port 587 with required STARTTLS. SMTP authentication uses AUTH PLAIN. The Compose service passes these variables through.

With all mail variables unset, invitations remain links you copy and the sign-in page offers no password reset. Partial or malformed settings stop startup with a generic configuration message that does not repeat their values. These settings are never stored in the database or an archive, and are never returned by an API.

Mail delivery starts after the identity transaction commits. At most 100 messages are in flight per process, and each SMTP exchange has a five-second deadline. A full queue or failed delivery writes a generic log line. No message body, recipient, username, password or transport error is logged. There is no durable queue or automatic retry. Restart loses queued mail and pending verification and reset links. [Access](./access.md#a-lost-password-or-passkey) describes verification, reset and admin recovery.

### Rename the owner

The owner's name comes from `MAINWORTHY_OWNER`. When that variable is unset, the name comes from `USER`. When neither is set, the name is `owner`. To rename an owner currently named `owner` to `robin`:

Follow these steps:

1. Set `MAINWORTHY_OWNER` to the new name and `MAINWORTHY_OWNER_WAS` to the name the owner has now.

   ```
   MAINWORTHY_OWNER=robin
   MAINWORTHY_OWNER_WAS=owner
   ```

2. Start the server again. It says one line:

   ```
   MAINWORTHY_OWNER_WAS: owner is now robin, with the tokens, password, passkeys, sessions and history owner had. robin signs in under the new name. Unset MAINWORTHY_OWNER_WAS.
   ```

3. Unset `MAINWORTHY_OWNER_WAS`. If the variable stays set, the server renames nobody and says so at every start.

The owner's tokens and passkeys keep working. Their browser sessions stay signed in, and history shows their new name. The rename affects sign-in and browser drafts as follows:

- A password is typed with the new name. Change the name in your password manager.
- A passkey signs in as before. The device or password manager that holds it still shows the old name for it.
- A browser keeps an unrecorded draft for the person, not for their name, so the owner still sees their drafts under the new name.

Startup refuses the rename when `MAINWORTHY_OWNER_WAS` names nobody on the instance, an agent, a pipeline, a forgotten person, or a person without every capability on every project. The error says why. The database has no separate owner marker, so the rename checks the grants that every start gives the owner. An admin granted all of those capabilities also passes that check and becomes the owner under the new name.

The new name follows the rule for every actor name. It uses letters, digits, `.`, `_`, `@` and `-`, starts with a letter or digit, and has at most 64 characters. Any other name stops startup.

When the new name is already somebody's, the start renames nobody and says so. That person becomes an owner, as they do without the variable. When the name is an agent's, a pipeline's or a forgotten person's, the start is refused instead, as it is without the variable.

Nobody else's name can be changed.

A start that is refused for the owner's name or the owner's token changes no actor and no token. If the server is newer than the database, it has already brought the database up to date by then. It also left a copy of the original database beside it, named `mainworthy.db.v<N>.bak`.

For the first server-mode sign-in, use the owner's token. Later you can set up a password or passkey. If you set `MAINWORTHY_OWNER_TOKEN`, the server adds that value as a token for the owner. Otherwise, a start on which the owner has no working token prints a generated one. The first start and a start after an import do this.

To replace a lost token, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. The start revokes every token previously issued through that variable, whoever the owner was then. It ends browser sessions opened with those tokens and names each token and actor in one log line. Tokens you made yourself and tokens the server generated keep working. An older manually issued token with a label beginning `owner (from ` is an exception. The database upgrade marked those tokens as issued through the variable, so a new value revokes them too.

A value shorter than 20 characters or longer than 512 stops startup. Only visible ASCII characters are accepted: letters, digits and punctuation, with no spaces, tabs, line breaks, other control characters or non-ASCII characters. The server uses the exact value for browser sign-in and HTTP bearer authentication. An invalid value stops startup before any token is created or revoked, so a refused rotation leaves the previous token and its browser sessions working. If an earlier build accepted an invalid value, replace it. `openssl rand -hex 32` makes a suitable value. Keep it out of version control.

A value shorter than 32 characters starts with a warning each time. No bearer token or sign-in token longer than 512 characters works.

A value already stored as a token revokes nothing. If that token was revoked, expired or belongs to somebody else, the server leaves it unchanged and says why on standard error. Set a new value in that case.

## Variables and flags the command line reads

Commands that talk to a server find its address in this order: the flag, then the variable, then the default. Local commands such as `fmt` and `audit verify` need no server.

| Variable | Flag | Default |
| --- | --- | --- |
| `MAINWORTHY_URL` | `--url` | `http://127.0.0.1:7357` |
| `MAINWORTHY_TOKEN` | `--token` | none |
| `MAINWORTHY_TOKEN_FILE` | `--token-file` | none |
| `MAINWORTHY_PROJECT` | `--project` | the only project, if there is one |

`health`, `fmt` and help output ignore `MAINWORTHY_TOKEN`, `MAINWORTHY_TOKEN_FILE` and their flags. They do not read token files. The server reads its own settings instead of these client token options.

With more than one project and no choice, a command stops with `invalid: choose a project with --project or MAINWORTHY_PROJECT; projects: scratch, checkout`. The `mainworthy health` command, with no `--url` or `MAINWORTHY_URL`, asks the server on this machine at `MAINWORTHY_PORT`.

Prefer `MAINWORTHY_TOKEN` or `--token-file` to `--token`. The process list and the shell's history show the value passed through `--token`. [Command line](./cli.md#give-the-token-in-the-environment-or-in-a-file) says more. For these variables, a value that is set but empty counts as not set. [Command line](./cli.md) lists every command.

## Variables that describe a CI build

`MAINWORTHY_COMMIT`, `MAINWORTHY_BRANCH`, `MAINWORTHY_PR`, `MAINWORTHY_BASE`, `MAINWORTHY_ATTEMPT`, `MAINWORTHY_JOB`, `MAINWORTHY_BUILD_URL`, `MAINWORTHY_REPO` and `MAINWORTHY_ENV` tell `mainworthy report` which build produced the results. The server also reads `MAINWORTHY_COMMIT` to identify its own build, as the table above describes. A CI job sets these variables when Mainworthy cannot detect the build. [Report results](./report-results.md#identify-the-tested-build) explains each.

## Run one container with one volume

Mainworthy runs as one container with one volume. The container runs the single executable as an unprivileged user, in server mode, on port 7357. It keeps its data in `/data`. Nothing else, such as a separate database, is needed. The source tree has a `Dockerfile` and a `compose.yaml`, and Compose builds the image from them.

```
$ docker compose up -d
```

The file defines one service, `mainworthy`. It publishes port 7357, restarts the container unless you stop it, and mounts a named volume, `mainworthy-data`, at `/data`.

Compose passes through the owner token and names, session lifetimes, lock wait, proxy settings, public URL, Apple app identifiers, demo project and mail settings. It defaults `MAINWORTHY_OWNER` to `owner` and `MAINWORTHY_LOCK_WAIT_SECONDS` to `30`. The other passed-through settings take the server's defaults when empty. To pass another server setting, such as `MAINWORTHY_REQUIRE_ADMIN_MFA`, add it to the service's `environment` map.

Set `MAINWORTHY_OWNER_TOKEN` to a long random string. If you leave it empty on first start, the server generates one and prints it once in `docker compose logs`. Open `http://localhost:7357` and sign in with it.

The image checks its own health every 30 seconds by running `mainworthy health`. The check calls `/healthz`, which needs no token:

```
$ curl -s http://127.0.0.1:7357/healthz
{"ok":true,"version":"0.1.0","apiVersion":1,"commit":null}
$ mainworthy health
healthy: Mainworthy 0.1.0 at http://127.0.0.1:7357
```

`mainworthy health` exits 0 when the server answers and 1 when it does not. Use `/healthz` for a monitor of your own. Its `apiVersion` is the CLI compatibility contract. `mainworthy health --json` also reports `compatible`, which is false for an older server that advertises no API version. An incompatible healthy server still exits 0. [CLI and server versions](./cli.md#cli-and-server-versions) explains refusal of operations.

`commit` identifies the server's build when the commit was supplied. To include the commit, build the image with `MAINWORTHY_COMMIT=$(git rev-parse HEAD) docker compose build`. Then `/healthz` names that commit, and `mainworthy health` prints its first 12 characters. Without a supplied commit, the answer is `null`.

Back up the volume. [Your data](./data.md) explains how.

## Run behind a proxy that ends TLS

The server speaks plain HTTP. To serve it over HTTPS, put a proxy in front that ends TLS, and set `MAINWORTHY_MODE=server`. The proxy must do two things:

1. Pass the `Host` header on unchanged, so the server sees the name the browser used.
2. Set `X-Forwarded-Proto: https`. A list such as `https,http` counts as https.

When a browser sends `Origin` while signing in or using a session cookie, the server checks that it has the request's scheme and host. Without `X-Forwarded-Proto`, the server sees `http` and refuses sign-in from the `https` page with `unauthenticated: a token is required`. The error does not name the cause. With the header, the session cookie is marked `Secure`.

The server also reads `Sec-Fetch-Site`, the header that identifies which site made a browser request. The server refuses sign-in and session-cookie requests from another site's page. A browser sends that header only to HTTPS addresses and to this machine. For plain HTTP to a name or address on your network, the browser sends no `Sec-Fetch-Site` header. The server then checks `Origin` alone.

The session cookie still has `SameSite=Strict`, so the browser excludes it from requests made by another site's page. However, plain HTTP sends the password or token and the cookie without encryption. The cookie also lacks its `__Host-` prefix and `Secure` mark. HTTPS through a proxy is the supported way to serve an instance to anybody but yourself.

The server counts wrong tokens by their source address and first 8 characters, both on authenticated operations and in the sign-in form. `/healthz`, the API description and the documentation need no sign-in and ignore tokens. The fifth wrong token within 15 minutes blocks that address or token prefix for one second. Each further wrong token doubles the wait, up to 15 minutes. A blocked request gets HTTP 429 with `Retry-After`.

A signed-in browser is unaffected. A correct server-generated token also works while blocked. These include tokens from `mainworthy token new` or Settings and the owner token printed at startup. A token supplied through `MAINWORTHY_OWNER_TOKEN` waits with other user-chosen tokens. Copying an existing server-generated token into that variable keeps its server-generated status. A request that presents a token uses that token's identity, whatever cookie comes with it.

Password sign-in shares the address count. The server counts a wrong password by the address and account name, including a wrong current password entered when changing it. Names count the same regardless of capitalisation, and unknown names count like existing names. While an address or name is blocked, the server does not check passwords, so the right one waits too. Refused passkey answers and invitation codes count by address alone. Valid passkeys and invitation codes still work from a blocked address.

Behind a proxy every connection comes from the proxy, so the server cannot tell visitors apart unless you tell it where to look. Set `MAINWORTHY_TRUSTED_PROXY` to the proxy's address as the server sees it. Set `MAINWORTHY_CLIENT_ADDRESS_HEADER` to the header the proxy writes the visitor's address in. Choose a header that the proxy sets and visitors cannot control. Otherwise, a visitor could choose the address Mainworthy counts. The header must hold one address and nothing else. The server refuses startup if only one variable is set, an address or range is invalid, or the header name is invalid. The startup message identifies the invalid setting.

With neither set, what happens depends on the proxy's address. A loopback or private address, such as a proxy on the same machine or the same Docker network, is not counted at all. For those addresses, wrong tokens are counted only by their first 8 characters. A server-mode start says so in one line. A public proxy address has one shared count for every visitor behind it. One visitor's wrong tokens can block your chosen owner token for all visitors until the wait ends. Setting the two variables fixes both.

After three minutes of silence, the server closes a connection nobody has signed in on. If a sign-in's body has not arrived within five seconds, the server answers with 408. A request with a valid token or session is not timed out, so a long reply is not cut off.

The server accepts a request body of up to 64 MiB for an operation. A proxy with a lower limit rejects a large report. `mainworthy export` and `mainworthy import` stream archives of up to 8 GiB, so give those paths the same room.

## What answers without a token

In server mode everything that reads or changes a project needs a token or a signed-in session. These addresses answer anyone who can reach the server:

| Address | What it returns |
| --- | --- |
| `/healthz` | Whether the server is up, its software and API versions, and the commit it runs when it was told |
| `/docs` and the pages under it | This documentation, the same for every instance of a version |
| `/api/openapi.json` | The description of the API, built from the list of operations |
| `/` | The web UI's own files. The page then asks you to sign in. `/invite`, the page an invitation link opens, is one of them. |
| `/.well-known/apple-app-site-association` | The app identifiers set in `MAINWORTHY_APPLE_APPS`, when configured |

`/api/login` opens a browser's session and sets its cookie. `/api/logout` ends the session and clears the cookie. `GET /api/login/methods` answers anyone and says whether the instance offers passkeys and mail. `/api/login/challenge` gives a browser what it needs to use a passkey. With a valid invitation code, the challenge route also says whose invitation it is and when it expires. Without a valid code, it reveals no invitation details.

`/api/login`, `/api/logout` and `/api/login/challenge` refuse requests from another site's page. A script, `curl` or the command line can send requests without a site header. If nobody outside your network should see these addresses, keep the server off the public internet or put the proxy's access control in front of it.

## Build the single executable

`bun run build` compiles the server, the web UI, the command line and the MCP endpoint into one file, `dist/mainworthy`, tens of megabytes in size. It needs Bun and the source tree, and the result needs neither. The file carries the Bun that built it. If you build with a Bun other than the one `THIRD-PARTY-NOTICES.md` lists, the build says so. The notices then do not describe that runtime.

```
$ ./dist/mainworthy
Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
```

The same file is the command line: `./dist/mainworthy gate`. The variables above apply to it unchanged.

## See also

- [People, agents and pipelines](./access.md) for the owner's token and other tokens.
- [Your data](./data.md) for the data directory, backups and moving machines.
- [What you can customize](./customize.md) for settings that are not environment variables.

## Sign in through an identity provider

Mainworthy signs people in through one OpenID Connect provider. It uses the authorization code flow with PKCE and checks the provider's ID token, including its signature.

1. At the provider, register a web application (a "confidential client"). Set its redirect address, also called the callback URL, to the instance's public address followed by `/signin/oidc`, for example `https://mainworthy.example/signin/oidc`. Allow the scopes `openid`, `email` and `profile`.
2. Set `MAINWORTHY_OIDC_ISSUER` to the provider's issuer address. It is the address whose `/.well-known/openid-configuration` the provider publishes, exactly as that document's `issuer` writes it. Set `MAINWORTHY_OIDC_CLIENT_ID` and `MAINWORTHY_OIDC_CLIENT_SECRET` to what the provider gave you, and `MAINWORTHY_OIDC_NAME` to the name the button shows.
3. Make sure `MAINWORTHY_PUBLIC_URL` is set, then restart the instance.

The four variables are set together or not at all. Startup stops when only some are set, when `MAINWORTHY_PUBLIC_URL` is missing, or when the issuer is not `https`. Plain `http` is accepted only on the loopback address, for a provider on the same machine.

Nobody gets a person from the provider alone. An admin invites each person, and the person accepts through the provider, or a person links it from their settings. See [through an identity provider](./access.md#through-an-identity-provider). The client secret goes to the provider and nowhere else: it is not in an archive, the log or a reply.

## Require a second factor for admins

Before enabling the requirement, give each admin a verified passkey or [enrol an authenticator](./access.md#add-an-authenticator-for-password-sign-in). Then follow these steps:

1. Set `MAINWORTHY_REQUIRE_ADMIN_MFA=true`.
2. Restart the instance.

A password with no enrolled authenticator then opens no admin session. Neither does the identity provider, unless `MAINWORTHY_OIDC_MFA=true` says that the provider requires a second factor of everybody. This applies to `admin` held through personal or team grants, on one project or every project. A verified passkey still signs in without a code. An invitation that would sign an admin in must include a verified passkey, or be accepted through an identity provider that `MAINWORTHY_OIDC_MFA=true` vouches for. The owner can sign in with the owner token to enrol an authenticator when no other session is available. Tokens and local-owner access keep their existing authority.

Each start with this setting ends every admin password session, including sessions that previously completed a second step, and every admin session opened through an identity provider that `MAINWORTHY_OIDC_MFA` does not vouch for. The admin signs in again. Becoming an admin ends the same sessions, whether through a personal grant, a team grant, or joining an admin team. Passkey sessions remain signed in.

An admin password with no enrolled authenticator does not count as a working way to sign in. The last usable passkey stays until the person adds another passkey or enrols an authenticator. An admin with a password must remove the password before removing their authenticator to rely only on passkeys.
