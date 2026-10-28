# Configuration

The server reads its settings from environment variables. These settings control where the server listens, where it keeps its data, and who owns it. There is no configuration file.

## Local mode and server mode

Both modes require PostgreSQL 18. The Local product layer has ended; local mode remains a development authentication option. Running the code elsewhere is possible but not yet supported. The mode decides how a request proves who sent it.

In local mode you are the owner. The server listens on the loopback address, and a request from this machine needs no token. The web UI opens signed in, and commands run without `--token`. A request counts as yours when three conditions hold:

- Its `Host` header is a loopback name: `localhost`, `127.0.0.1` or `[::1]`.
- The connection comes from a loopback address.
- It carries none of these proxy or tunnel headers: `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`, `CF-Connecting-IP`.

Any other request needs a token or signed-in session. Both modes refuse browser requests made from another site's page when signing in or using a session cookie.

In server mode every request to a project needs a token or a browser that is signed in. A few addresses answer without either, including `/health`, `/docs` and the sign-in endpoints. See [What answers without a token](#what-answers-without-a-token). The web UI shows a sign-in page, and a command needs `--token` or `MAINWORTHY_TOKEN`. [People, agents and pipelines](./access.md#sign-in-to-the-web-ui) explains tokens and signing in.

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
| `MAINWORTHY_DATA` | `~/.mainworthy` | Local attachment storage in `blobs/` and archive staging in `spool/`. PostgreSQL stores structured records separately. |
| `MAINWORTHY_MODE` | none | `server` selects server mode. |
| `MAINWORTHY_OWNER` | `USER`, else `owner` | The name of the owner, who holds every capability on every project. |
| `MAINWORTHY_OWNER_WAS` | none | The name the owner has now, when `MAINWORTHY_OWNER` holds a new name for the same person. The start renames them. See [rename the owner](#rename-the-owner). |
| `MAINWORTHY_OWNER_TOKEN` | none | An optional token for the owner, 20 to 512 visible ASCII characters without spaces. Without it, server mode generates one when the owner has no working token. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. The same form. |
| `MAINWORTHY_OIDC_ISSUER` | none | The issuer address of the OpenID Connect identity provider people sign in through, such as `https://accounts.google.com`. Set it with `MAINWORTHY_OIDC_CLIENT_ID`, `MAINWORTHY_OIDC_CLIENT_SECRET`, `MAINWORTHY_OIDC_NAME` and `MAINWORTHY_PUBLIC_URL`. See [sign in through an identity provider](#sign-in-through-an-identity-provider). |
| `MAINWORTHY_OIDC_CLIENT_ID` | none | The client id the provider gave this instance. |
| `MAINWORTHY_OIDC_CLIENT_SECRET` | none | The client secret the provider gave this instance. |
| `MAINWORTHY_OIDC_NAME` | none | What the sign-in button calls the provider, such as `Okta`: "Sign in with Okta". |
| `MAINWORTHY_PUBLIC_URL` | none | The address people open the instance at, such as `https://mainworthy.example`. The identity provider sends people back to it, and an invitation link starts with it. Required with an identity provider, and so for any invitation: without a provider the instance makes none. |
| `MAINWORTHY_TRUSTED_PROXY` | none | The addresses or CIDR ranges of the proxy in front, comma-separated. Requires `MAINWORTHY_CLIENT_ADDRESS_HEADER`. Cannot be set with `MAINWORTHY_PROXY_SECRET`. |
| `MAINWORTHY_PROXY_SECRET` | none | A secret of at least 32 characters that the proxy overwrites `x-mainworthy-proxy` with on every request. Requires `MAINWORTHY_CLIENT_ADDRESS_HEADER`. Requests without matching proof receive 403, except `GET /health`. |
| `MAINWORTHY_CLIENT_ADDRESS_HEADER` | none | The header in which the proxy reports one visitor address. Requires either the trusted proxy addresses or the proxy secret. |
| `MAINWORTHY_JOB_AUDIENCE` | none | Set with `MAINWORTHY_JOB_ACCOUNT` to accept `POST /api/job` from a scheduler: the HTTPS audience in its Google OIDC token, the server's own address on Cloud Run. Without both, `/api/job` refuses every caller. |
| `MAINWORTHY_JOB_ACCOUNT` | none | Set with `MAINWORTHY_JOB_AUDIENCE`. The service account email that may call `/api/job`. Tokens must have a valid Google signature, issuer, audience, expiry and verified account email. No shared job secret is used. That call needs no proxy proof (`MAINWORTHY_PROXY_SECRET`): the token is its proof. |
| `MAINWORTHY_JOB_KEY` | none | Base64 encoding of 32 random bytes, shared by every instance that queues or runs private jobs. An invalid value stops startup; a missing value refuses private enqueue. |
| `MAINWORTHY_JOB_RUNNER` | `1` | Set to `0` when a scheduler's `/api/job` calls run the jobs, as on Cloud Run, where the CPU is throttled between requests. The runner polls durable rows on development and hosts with CPU between requests. |
| `MAINWORTHY_DATABASE_URL` | required | PostgreSQL connection URL. `compose.yaml` starts PostgreSQL 18 and sets this for the app. |
| `MAINWORTHY_DB_POOL` | `2` | Read-pool connections, an integer from 1 to 64. |
| `MAINWORTHY_DB_WRITE_POOL` | `4` | Write-pool connections, an integer from 1 to 64. Writes lock their actors and projects; different projects can write concurrently. |
| `MAINWORTHY_DEMO` | none | A marked demo refreshed once per deployed revision after listening. The commit comes from `MAINWORTHY_COMMIT` or `SOURCE_COMMIT`. Same-revision restarts preserve edits and renew featured work. New revisions swap in a fresh demo with existing grants; retired data drains in bounded transactions. Unknown revisions and unmarked projects are refused. See [demo data](./customize.md#a-project-of-demo-data). |
| `MAINWORTHY_COMMIT` | none | The commit this server was built from, which `/health` reports. It must have 40 lower-case hexadecimal characters. If absent or invalid, the server tries `SOURCE_COMMIT`, then reports unknown. |
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
| `MAINWORTHY_HANDOFF_PROJECT` | none | The project whose failure questions can be handed to a coding agent. Set the project, address and secret together. See [hand a failure to a coding agent](./decide.md#hand-a-failure-to-a-coding-agent). |
| `MAINWORTHY_HANDOFF_URL` | none | The address the server posts a hand-off to, for example a T3 Code webhook. It must be `https`, or `http` on `127.0.0.1` or `localhost`. Treat it as a secret when it carries a token, as a T3 Code webhook address does. It is never stored in the database or an archive. |
| `MAINWORTHY_HANDOFF_SECRET` | none | At least 16 characters without whitespace. The server signs each post with it (HMAC-SHA256, hex, in `X-Mainworthy-Signature: sha256=<digest>`). Give the receiver the same secret. Keep it in the server's secret environment. |

An invalid session duration also stops startup with a line that names the variable.

For `MAINWORTHY_PUBLIC_URL`, use `https` and a host name with nothing after it, or `http://localhost` with its optional port. The server refuses plain `http` anywhere else. Paths and queries are refused because the server needs the instance's root address.

The server checks configuration before creating the data directory or taking its lock. A refused public address, owner token length or form, or reserved owner name creates no files.


Reads use pooled PostgreSQL connections. `MAINWORTHY_READERS` is removed. The server starts only with a PostgreSQL URL.

Existing hash-named attachment files are enrolled for pruning at startup with a fresh grace period. Later starts preserve each recorded age. Pruning retains referenced files and removes unreferenced files only after the grace period, including orphans left before the job-based prune was introduced.

PostgreSQL owns its write-ahead log and checkpoints. Back up PostgreSQL and local attachments together; Mainworthy creates no automatic upgrade copy.

GitHub Issues and Jira Cloud are optional. Each supports one destination for one project per instance, through the API and command line. See [create or link a tracker defect](./decide.md#create-or-link-a-tracker-defect). A partial or malformed configuration stops the server with a message that names the variables without quoting credentials. If both trackers name the same Mainworthy project, new defects go to Jira. GitHub remains available for commit statuses and existing defect holds.

Every start gives the owner named by `MAINWORTHY_OWNER` every capability. The owner must be a person. The server refuses to start if the name belongs to an agent, a pipeline or a forgotten person, or starts with `forgotten-`.

Changing the variable to a new name creates a second person with every capability. The previous owner keeps their grant and tokens. Remove their grant with `mainworthy actor ungrant` if you no longer want them to administer the instance. Changing `MAINWORTHY_OWNER_TOKEN` to a new value also revokes earlier tokens issued through that variable. To give the same person a new name instead, [rename the owner](#rename-the-owner).

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
   MAINWORTHY_OWNER_WAS: owner is now robin, with the tokens, identities, sessions and history owner had. robin signs in under the new name. Unset MAINWORTHY_OWNER_WAS.
   ```

3. Unset `MAINWORTHY_OWNER_WAS`. If the variable stays set, the server renames nobody and says so at every start.

The owner's tokens and linked identities keep working. Their browser sessions stay signed in, and history shows their new name. A browser keeps an unrecorded draft for the person, not for their name, so the owner still sees their drafts under the new name.

Startup refuses the rename when `MAINWORTHY_OWNER_WAS` names nobody on the instance, an agent, a pipeline, a forgotten person, or a person without every capability on every project. The error says why. The database has no separate owner marker, so the rename checks the grants that every start gives the owner. An admin granted all of those capabilities also passes that check and becomes the owner under the new name.

The new name follows the rule for every actor name. It uses letters, digits, `.`, `_`, `@` and `-`, starts with a letter or digit, and has at most 64 characters. Any other name stops startup.

When the new name is already somebody's, the start renames nobody and says so. That person becomes an owner, as they do without the variable. When the name is an agent's, a pipeline's or a forgotten person's, the start is refused instead, as it is without the variable.

Nobody else's name can be changed.

A start that is refused for the owner's name or the owner's token changes no actor and no token. If the server is newer than the database, it has already brought the database up to date by then. It also left a copy of the original database beside it, named `mainworthy.db.v<N>.bak`.

For the first server-mode sign-in, use the owner's token. Then link your identity at the provider in Settings, **Your sign-in**. If you set `MAINWORTHY_OWNER_TOKEN`, the server adds that value as a token for the owner. Otherwise, a start on which the owner has no working token prints a generated one. The first start and a start after an import do this.

To replace a lost token, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. The start revokes every token previously issued through that variable, whoever the owner was then. It ends browser sessions opened with those tokens and names each token and actor in one log line. Tokens you made yourself and tokens the server generated keep working.

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

## Run the app and PostgreSQL

The source tree includes a `Dockerfile` and `compose.yaml`. Compose builds the app and starts PostgreSQL 18.
It publishes the app on port 7357, mounts `mainworthy-data` at `/data` for attachments and staging,
and gives PostgreSQL its own `mainworthy-postgres` volume at `/var/lib/postgresql`.

```
$ docker compose up -d
```

The app waits for PostgreSQL health before starting. `MAINWORTHY_POSTGRES_PASSWORD` overrides the development password
in `compose.yaml`; in Coolify the password is generated (`docs/deploy.md`). Running elsewhere is possible but not yet supported.
Compose passes owner, session, proxy, public URL, identity provider and demo settings to the app.

Set `MAINWORTHY_OWNER_TOKEN` to a long random string. If you leave it empty on first start, the server generates one and prints it once in `docker compose logs`. Open `http://localhost:7357` and sign in with it.

The image checks its own health every 30 seconds by running `mainworthy health`. The check calls `/health`, which needs no token:

```
$ curl -s http://127.0.0.1:7357/health
{"ok":true,"version":"0.1.0","apiVersion":1,"commit":null}
$ mainworthy health
healthy: Mainworthy 0.1.0 at http://127.0.0.1:7357
```

`mainworthy health` exits 0 when the server answers and 1 when it does not. Use `/health` for a monitor of your own. Its `apiVersion` is the CLI compatibility contract. `mainworthy health --json` also reports `compatible`, which is false for an older server that advertises no API version. An incompatible healthy server still exits 0. [CLI and server versions](./cli.md#cli-and-server-versions) explains refusal of operations.

During startup, health answers HTTP 503 with `ok: false, state: "upgrading"`, so a probe that reads only the status waits. The health command reads the body, exits 0 and prints `upgrading`, so Docker can start dependent services. Other requests receive HTTP 503 until ready. A readiness monitor must require `ok: true` and, for a deployment, the expected commit. Startup failure closes the listener.

`commit` identifies the server's build when the commit was supplied. To include the commit, build the image with `MAINWORTHY_COMMIT=$(git rev-parse HEAD) docker compose build`. Then `/health` names that commit, and `mainworthy health` prints its first 12 characters. Without a supplied commit, the answer is `null`.

Back up PostgreSQL and the attachment volume. [Your data](./data.md) explains how.

## Run behind a proxy that ends TLS

The server speaks plain HTTP. To serve it over HTTPS, put a proxy in front that ends TLS, and set `MAINWORTHY_MODE=server`. The proxy must do two things:

1. Pass the `Host` header on unchanged, so the server sees the name the browser used.
2. Set `X-Forwarded-Proto: https`. A list such as `https,http` counts as https.

When a browser sends `Origin` while signing in or using a session cookie, the server checks that it has the request's scheme and host. Without `X-Forwarded-Proto`, the server sees `http` and refuses sign-in from the `https` page with `unauthenticated: a token is required`. The error does not name the cause. With the header, the session cookie is marked `Secure`.

The server also reads `Sec-Fetch-Site`, the header that identifies which site made a browser request. The server refuses sign-in and session-cookie requests from another site's page. A browser sends that header only to HTTPS addresses and to this machine. For plain HTTP to a name or address on your network, the browser sends no `Sec-Fetch-Site` header. The server then checks `Origin` alone.

The session cookie still has `SameSite=Strict`, so the browser excludes it from requests made by another site's page. However, plain HTTP sends the token and the cookie without encryption. The cookie also lacks its `__Host-` prefix and `Secure` mark. HTTPS through a proxy is the supported way to serve an instance to anybody but yourself.

The server counts wrong tokens by their source address and first 8 characters, both on authenticated operations and in the sign-in form. `/health`, the API description and the documentation need no sign-in and ignore tokens. The fifth wrong token within 15 minutes blocks that address or token prefix for one second. Each further wrong token doubles the wait, up to 15 minutes. A blocked request gets HTTP 429 with `Retry-After`. Repeated checks and valid sign-ins do not spend the failed-attempt allowance.

Failed-attempt counts and anonymous sign-in start allowances are shared by all instances on the same database. Restarting an instance does not reset them. Session expiry and sign-in-record retention jobs check their lease after waiting for identity and actor locks; an expired worker cannot commit over its successor. A provider sign-in can start on one instance and finish on another; each can be used once. Importing an archive invalidates pending ceremonies on every instance. Token and session last uses are stored during requests, at most once a minute for each credential. The idle check uses that stored time, so an active session can end up to a minute early.

A signed-in browser is unaffected. A correct server-generated token also works while blocked. These include tokens from `mainworthy token new` or Settings and the owner token printed at startup. A token supplied through `MAINWORTHY_OWNER_TOKEN` waits with other user-chosen tokens. Copying an existing server-generated token into that variable keeps its server-generated status. A request that presents a token uses that token's identity, whatever cookie comes with it.

Refused provider answers and invitation codes count by address alone. A valid invitation code still works from a blocked address.

Behind a proxy every connection comes from the proxy, so the server cannot tell visitors apart unless you tell it where to look. Set `MAINWORTHY_TRUSTED_PROXY` to the proxy's address as the server sees it. Set `MAINWORTHY_CLIENT_ADDRESS_HEADER` to the header the proxy writes the visitor's address in. Choose a header that the proxy sets and visitors cannot control. Otherwise, a visitor could choose the address Mainworthy counts. The header must hold one address and nothing else. The server refuses startup if only one variable is set, an address or range is invalid, or the header name is invalid. The startup message identifies the invalid setting.

On a host such as Cloud Run, a direct request and a proxied request arrive from the same front end. Set `MAINWORTHY_PROXY_SECRET` instead of trusted proxy addresses. The proxy must overwrite `x-mainworthy-proxy` with that secret on every request. Set `MAINWORTHY_CLIENT_ADDRESS_HEADER` to its visitor-address header, such as `cf-connecting-ip`. Mainworthy compares the proof in constant time before any request handler runs. Missing or incorrect proof receives a JSON 403, including on sign-in, docs, static files, streams and archives. Only `GET /health` answers without proof, for the startup probe. A missing or malformed visitor address gives a proved request no address. Startup refuses a secret shorter than 32 characters, a secret without an address-header name, or a secret together with trusted proxy addresses.

With no proxy configured, what happens depends on the connection's address. A loopback or private address, such as a proxy on the same machine or the same Docker network, is not counted at all. For those addresses, wrong tokens are counted only by their first 8 characters. A server-mode start says so in one line. A public proxy address has one shared count for every visitor behind it. One visitor's wrong tokens can block your chosen owner token for all visitors until the wait ends. Configuring either proxy trust method fixes both.

After three minutes of silence, the server closes a connection nobody has signed in on. If a sign-in's body has not arrived within five seconds, the server answers with 408. A request with a valid token or session is not timed out, so a long reply is not cut off.

The server accepts a request body of up to 64 MiB for an operation. A proxy with a lower limit rejects a large report. `mainworthy export` and `mainworthy import` stream archives of up to 8 GiB, so give those paths the same room.

## What answers without a token

In server mode everything that reads or changes a project needs a token or a signed-in session. These addresses answer without a session. When a proxy secret is configured, all except `GET /health` still require the proxy's proof:

| Address | What it returns |
| --- | --- |
| `/health` | Whether the server is up, its software and API versions, and the commit it runs when it was told. It needs no proxy proof either, so Cloud Run's startup probe can read it. (Not `/healthz`: Cloud Run's front end answers that path itself.) |
| `/docs` and the pages under it | This documentation, the same for every instance of a version |
| `/api/openapi.json` | The description of the API, built from the list of operations |
| `/` | The web UI's own files. The page then asks you to sign in. `/invite`, the page an invitation link opens, is one of them. |

`/api/login` opens a browser's session and sets its cookie. `/api/logout` ends the session and clears the cookie. `GET /api/login/methods` answers anyone and names the instance's identity provider, if it has one. `/api/login/oidc` gives a browser the provider's address to sign in, accept an invitation, link an identity or confirm it is you. `/api/login/invitation` says, for a valid invitation code, whose invitation it is and when it expires. Without a valid code, it reveals no invitation details.

`/api/login`, `/api/logout`, `/api/login/oidc` and `/api/login/invitation` refuse requests from another site's page. A script, `curl` or the command line can send requests without a site header. If nobody outside your network should see these addresses, keep the server off the public internet or put the proxy's access control in front of it.

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

Everybody but the owner signs in through one OpenID Connect identity provider, such as Google, Microsoft Entra ID,
Okta, Keycloak or Authentik. Mainworthy keeps no password, passkey or second factor and sends no mail: the provider
asks for those, and recovers an account a person cannot get into. Without a provider the instance has one person,
the owner, who signs in with the owner token, plus agents and pipelines, and `mainworthy invite` refuses.

Mainworthy uses the authorization code flow with PKCE and checks the provider's ID token, including its signature.

1. At the provider, register a web application (a "confidential client"). Set its redirect address, also called the callback URL, to the instance's public address followed by `/signin/oidc`, for example `https://mainworthy.example/signin/oidc`. Allow the scopes `openid`, `email` and `profile`.
2. Set `MAINWORTHY_OIDC_ISSUER` to the provider's issuer address. It is the address whose `/.well-known/openid-configuration` the provider publishes, exactly as that document's `issuer` writes it. Set `MAINWORTHY_OIDC_CLIENT_ID` and `MAINWORTHY_OIDC_CLIENT_SECRET` to what the provider gave you, and `MAINWORTHY_OIDC_NAME` to the name the button shows.
3. Make sure `MAINWORTHY_PUBLIC_URL` is set, then restart the instance.
4. Sign in with the owner token, open Settings, **Your sign-in**, and link your identity at the provider. Then invite people.

The four variables are set together or not at all. Startup stops when only some are set, when `MAINWORTHY_PUBLIC_URL` is missing, or when the issuer is not `https`. Plain `http` is accepted only on the loopback address, for a provider on the same machine.

Nobody gets a person from the provider alone. An admin invites each person, and the person accepts through the provider, or a person links it from their settings. See [through the identity provider](./access.md#through-the-identity-provider). The client secret goes to the provider and nowhere else: it is not in an archive, the log or a reply.

To confirm it is somebody before a sign-in change, Mainworthy sends them back to the provider with `max_age=0`, which asks the provider to sign them in again. It also asks for the `auth_time` claim, and takes the proof only when the ID token says the person signed in there after the confirmation began. The proof lasts ten minutes from that sign-in. A provider that leaves the claim out gives no proof, so enable it where the provider offers the choice. [Confirm it is you](./access.md#confirm-it-is-you) has the rest.

An identity is the provider's issuer and its subject for the person. If you change `MAINWORTHY_OIDC_ISSUER`, identities linked at the old issuer sign nobody in: sign in with the owner token, link your new identity, and invite everybody else again.

### Google accounts

To let people sign in with their Google account or Google Workspace account:

1. In the Google Cloud console, open **Google Auth Platform**, then **Clients**, and create a client of type **Web application**.
2. Under **Authorised redirect URIs**, add the instance's public address followed by `/signin/oidc`, for example `https://mainworthy.example/signin/oidc`.
3. Set `MAINWORTHY_OIDC_ISSUER=https://accounts.google.com`, `MAINWORTHY_OIDC_CLIENT_ID` and `MAINWORTHY_OIDC_CLIENT_SECRET` to the client's id and secret, and `MAINWORTHY_OIDC_NAME=Google`.
4. Enable the `auth_time` claim for the client. Google's [OpenID Connect page](https://developers.google.com/identity/openid-connect/openid-connect) says it provides `auth_time` when a request asks for it, which Mainworthy does when confirming it is somebody, and it is enabled in settings. Without it, nobody signed in through Google can confirm it is them, and only token sessions can make sign-in changes.

Google decides who may sign in to the client. Under **Audience** in the same console, choose the users of your
Workspace organisation, or any Google account; an external client that is still in testing admits only the test
users listed there. Either way, Mainworthy admits only an identity somebody invited or linked.

### Container network lockdown

The production Coolify Compose file sets `MAINWORTHY_LOCKDOWN=1` to block new outbound network connections from Mainworthy. The ordinary image defaults to `0`; any other value refuses startup.
Its image entrypoint installs the policy before starting the app without capabilities.
This deployment cannot send webhooks or contact an OIDC provider, so on it only the owner signs in, with the owner token.
The ordinary image and local Compose file leave lockdown off and retain these integrations.
See the repository's `docs/deploy.md` for the Linux startup checks and the trusted-proxy boundary.
