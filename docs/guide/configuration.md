# Configuration

Run a Mainworthy instance on your machine or on a server, and set where it listens, where it keeps its data and who owns it. The server reads its settings from environment variables. There is no configuration file.

## Local mode and server mode

The same program runs in two modes. The mode decides how a request proves who sent it.

In local mode you are the owner. The server listens on the loopback address, and a request from this machine needs no token. The web UI opens signed in, and commands run without `--token`. A request counts as yours when three things hold: its `Host` header is a loopback name (`localhost`, `127.0.0.1` or `[::1]`), the connection comes from a loopback address, and it carries none of the headers a proxy or a tunnel adds (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`, `CF-Connecting-IP`). Any other request needs a token. A request that the browser says another site made is refused in both modes.

In server mode every request to a project needs a token or a browser that is signed in. A few addresses answer without either, such as `/healthz`, `/docs` and the ones a browser signs in with: [they are listed below](#what-answers-without-a-token). The web UI shows a sign-in page, and a command needs `--token` or `MAINWORTHY_TOKEN`. [People, agents and pipelines](./access.md#sign-in-to-the-web-ui) explains tokens and signing in.

Two things choose server mode. One is `MAINWORTHY_MODE=server`. The other is any `MAINWORTHY_HOST` that is not a loopback address. Either one is enough, and setting `MAINWORTHY_MODE=local` does not undo the second. Every other start is local mode. The first line the server prints says which mode it is in:

```
$ mainworthy serve
Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
project "scratch" · you are robin@this-machine · policy: loose
```

> [!WARNING]
> Always set `MAINWORTHY_MODE=server` when anything sits between users and the server. A proxy that adds its headers is not taken for you, but a relay on the same machine that passes bytes on unchanged cannot be told apart from you, and local mode would trust everyone who reaches it as the owner.

## Variables the server reads

`mainworthy` with no command, or `mainworthy serve`, starts the server. These variables change how.

| Variable | Default | What it sets |
| --- | --- | --- |
| `MAINWORTHY_HOST` | `127.0.0.1` | The address to listen on. Use `0.0.0.0` to listen on every interface. A value that is not loopback selects server mode. |
| `MAINWORTHY_PORT` | `PORT`, else `7357` | The port to listen on. |
| `MAINWORTHY_DATA` | `~/.mainworthy` | The data directory. It holds `mainworthy.db`, its WAL and shared-memory files while running, `server.lock` (with `server.lock-journal` while a server holds it), and `spool/` for archive transfers. |
| `MAINWORTHY_LOCK_WAIT_SECONDS` | `30` | Seconds to wait for another server to release the data directory. A finite nonnegative number, including fractions. `0` refuses immediately. |
| `MAINWORTHY_MODE` | none | `server` selects server mode. |
| `MAINWORTHY_OWNER` | `USER`, else `owner` | The name of the owner, who holds every capability on every project. |
| `MAINWORTHY_OWNER_WAS` | none | The name the owner has now, when `MAINWORTHY_OWNER` holds a new name for the same person. The start renames them. See [rename the owner](#rename-the-owner). |
| `MAINWORTHY_OWNER_TOKEN` | none | A token for the owner, 20 to 512 characters. Server mode needs one to sign in. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. The same form. |
| `MAINWORTHY_REQUIRE_ADMIN_MFA` | `false` | `true` requires a second factor for password sign-in by anyone with `admin` on any project. See [require a second factor for admins](#require-a-second-factor-for-admins). Other nonempty values except `false` stop startup. |
| `MAINWORTHY_PUBLIC_URL` | none | The address people open the instance at, such as `https://mainworthy.example`. A passkey belongs to its host name, and an invitation link starts with it. Without it there are no passkeys and `mainworthy invite` prints a link with no host. |
| `MAINWORTHY_APPLE_APPS` | none | The iPhone apps whose sign-in screen the phone may offer the logins it keeps for this site, each as a team id and a bundle identifier (`ABCDE12345.com.mainworthy.app`), separated by commas. The server lists them at `/.well-known/apple-app-site-association`. Without it that address is not found. See [the iPhone app](./iphone.md#sign-in). |
| `MAINWORTHY_TRUSTED_PROXY` | none | The addresses or CIDR ranges of the proxy in front, comma-separated. Set it together with the next one, or neither. |
| `MAINWORTHY_CLIENT_ADDRESS_HEADER` | none | The header in which that proxy reports the visitor's address. Believed only on a connection from a proxy named above. |
| `MAINWORTHY_READERS` | the CPU count minus 2, at least 1 and at most 8 | How many reader threads answer reads, from `0` to `8`. `0` answers them on the main thread. |
| `MAINWORTHY_COMMIT` | none | The commit this server was built from, which `/healthz` reports. 40 lower-case hexadecimal characters, or it reads as unknown. Without it the server reads `SOURCE_COMMIT`. |
| `MAINWORTHY_GITHUB_PROJECT` | none | The project allowed to send defects and optional gate commit statuses to GitHub. Set the project, repository, and token together. |
| `MAINWORTHY_GITHUB_REPOSITORY` | none | The destination on github.com, written `owner/repository`. Requests cannot choose another repository. |
| `MAINWORTHY_GITHUB_TOKEN` | none | A token for that repository. Defect requests need Issues write permission. Gate commit statuses need Commit statuses write permission on a fine-grained personal access token, or the `repo:status` scope on a classic token. Keep it in the server's secret environment, outside the repository. It is never stored in the database or an archive. |
| `MAINWORTHY_GITHUB_STATUSES` | `0` | Set to `1` to publish commit gates as GitHub commit statuses. Requires the three GitHub variables and `MAINWORTHY_PUBLIC_URL`. See [GitHub commit statuses](./changes.md#publish-the-gate-as-a-github-commit-status). |

A value outside the whole numbers `0` through `8` for `MAINWORTHY_READERS` stops the start with `invalid: MAINWORTHY_READERS must be an integer between 0 and 8`. A session lifetime that is not a duration stops the start too, with a line that names the variable. So does an entry of `MAINWORTHY_APPLE_APPS` that is not a team id and a bundle identifier, and a `MAINWORTHY_PUBLIC_URL` that is not such an address: write `https` and a host name with nothing after it, or `http://localhost` with its port. An IP address and plain `http` anywhere else are refused because no browser makes a passkey there. A path and a query are refused because the server wants the root address of the instance.

The server checks configuration before creating the data directory or taking its lock. A refused public address, owner token length or reserved owner name creates no files.

The first start creates the data directory, one owner and a project named `scratch`. It does not need any variable. The server holds `server.lock` in that directory until it stops. Another server using the same directory waits up to `MAINWORTHY_LOCK_WAIT_SECONDS` before it opens the application database. It says once on standard error that it is waiting for another server on the data directory. If the lock is still held at the deadline, startup is refused with `another server is already using this data directory; stop it or choose another MAINWORTHY_DATA`. This permits a replacement to start when the previous server finishes stopping. A deployment must let the previous server stop while the replacement waits; waiting for the replacement to become healthy first prevents that handoff. The operating system releases the lock if the process is killed. The file stays in place; do not delete or replace it while a server runs.

A reader thread that fails to start retries after 100 ms, then doubles the wait up to 30 seconds. A thread that becomes ready resets that wait. Reads use ready threads or run inline when none is ready. The server starts without waiting for the full pool.

With reader threads enabled, a background thread checkpoints the write-ahead log every half second. The writer keeps its 20,000-page automatic checkpoint fallback. After readers move on and a checkpoint completes, log reuse trims the file to at most 4 MiB. This retention limit does not change checkpoint timing or cap growth during active snapshots and large transactions. See [data and backups](./data.md).

GitHub Issues is optional and currently supports one repository for one project per instance. It is available through the API and command line. See [create or link a GitHub defect](./decide.md#create-or-link-a-github-defect). A partial or malformed GitHub configuration stops the server with a message that names the variables without quoting the token.

Every start gives the owner named by `MAINWORTHY_OWNER` every capability. The owner is a person: the server does not start when the name belongs to an agent, a pipeline or a person who was forgotten on this instance, or starts with `forgotten-`. If you change the name later, you get a second owner, and the first one keeps its grant. Remove its grant with `mainworthy actor ungrant`. To give the same person a new name instead, [rename the owner](#rename-the-owner). The first one keeps its tokens too, except the one that came from `MAINWORTHY_OWNER_TOKEN` when you set that variable to a new value: see the next paragraph.

### Rename the owner

The owner's name is the one in `MAINWORTHY_OWNER`, so the owner is renamed where that variable is set. An instance started with the default has an owner named `owner`. To make that person `robin`:

1. Set `MAINWORTHY_OWNER` to the new name and `MAINWORTHY_OWNER_WAS` to the name the owner has now.

   ```
   MAINWORTHY_OWNER=robin
   MAINWORTHY_OWNER_WAS=owner
   ```

2. Start the server again. It says one line:

   ```
   MAINWORTHY_OWNER_WAS: owner is now robin, with the tokens, password, passkeys, sessions and history owner had. robin signs in under the new name. Unset MAINWORTHY_OWNER_WAS.
   ```

3. Unset `MAINWORTHY_OWNER_WAS`. Left in place it renames nobody, and every start says so.

The person is the same one. Their tokens and their passkeys work as before, the browsers they are signed in on stay signed in, and history shows the new name for what they did under the old one. Three things use the name and need a hand:

- A password is typed with the new name. Change the name in your password manager.
- A passkey signs in as before. The device or password manager that holds it still shows the old name for it.
- A browser keeps a draft that is not yet recorded under the name of whoever typed it. Record your drafts before the rename: one kept under the old name is not shown to the new one.

The start is refused, and changes nothing, when `MAINWORTHY_OWNER_WAS` names nobody on the instance, an agent, a pipeline, a person who was forgotten, or a person who is not the owner. The line says which. A mistyped name would otherwise make a second owner. Nothing stores who the owner is, so the start takes a person for the owner when they hold every capability on every project, which every start gives the owner. An admin who was granted all of that passes too, and becomes the owner under the new name.

The new name follows the rule for every name: letters, digits, `.`, `_`, `@` and `-`, starting with a letter or a digit, 64 characters at most. Another one stops the start.

When the new name is already somebody's, the start renames nobody and says so. That person becomes an owner, as they do without the variable. When the name is an agent's, a pipeline's or a forgotten person's, the start is refused instead, as it is without the variable.

Nobody else's name can be changed.

A start that is refused for the owner's name or the owner's token changes no actor and no token. If the server is newer than the database, it has already brought the database up to date by then, and it left a copy of the database as it was beside it, named `mainworthy.db.v<N>.bak`.

In server mode, an owner token is needed to sign in. If you set `MAINWORTHY_OWNER_TOKEN`, the server adds that value as a token for the owner. If you do not, a start on which the owner holds no token that works prints a generated one: the first start, and the start after an import. To get a token after you lost it, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. A new value retires the old one: the start revokes every token that came from this variable before, whoever was the owner then, ends the browser sessions opened with them, and names each token and its actor in one line. A token you made yourself, and one the server generated, keep working, with one exception: a token made by hand before this build and labelled like the variable's own (a label that begins `owner (from `) was marked as the variable's when the database was upgraded, and is retired with it. A value shorter than 20 characters or longer than 512 stops the start; one shorter than 32 starts and warns each time. No token longer than 512 characters works, as a bearer or at sign-in: if an earlier build accepted a longer owner token, set a new value. `openssl rand -hex 32` makes a good one. A value that is already a token retires nothing. If that token was revoked, has reached its end, or is somebody else's, it is not brought back: the server says which in one line on standard error, and you set a new value. Use a long random value and keep it out of version control.

Reader threads let reads continue while a large report is applied. The default suits most machines. Set `0` to turn them off.

## Variables and flags the command line reads

Every command except `serve`, `fmt` and `help` talks to a server. It finds the server in this order: the flag, then the variable, then the default.

| Variable | Flag | Default |
| --- | --- | --- |
| `MAINWORTHY_URL` | `--url` | `http://127.0.0.1:7357` |
| `MAINWORTHY_TOKEN` | `--token` | none |
| `MAINWORTHY_TOKEN_FILE` | `--token-file` | none |
| `MAINWORTHY_PROJECT` | `--project` | the only project, if there is one |

`health`, `fmt` and help output ignore `MAINWORTHY_TOKEN`, `MAINWORTHY_TOKEN_FILE` and their flags. They do not read token files. The server reads its own settings instead of these client token options.

With more than one project and no choice, a command stops with `invalid: choose a project with --project or MAINWORTHY_PROJECT; projects: scratch, checkout`. The `mainworthy health` command, with no `--url` or `MAINWORTHY_URL`, asks the server on this machine at `MAINWORTHY_PORT`.

Prefer `MAINWORTHY_TOKEN` or `--token-file` to `--token`, which the process list and the shell's history show. [Command line](./cli.md#give-the-token-in-the-environment-or-in-a-file) says more. For these variables, a value that is set but empty counts as not set. [Command line](./cli.md) lists every command.

## Variables that describe a CI build

`MAINWORTHY_COMMIT`, `MAINWORTHY_BRANCH`, `MAINWORTHY_PR`, `MAINWORTHY_BASE`, `MAINWORTHY_ATTEMPT`, `MAINWORTHY_JOB`, `MAINWORTHY_BUILD_URL`, `MAINWORTHY_REPO` and `MAINWORTHY_ENV` tell `mainworthy report` which build produced the results. (`MAINWORTHY_COMMIT` means something else to the server: see the table above.) A CI job sets them only when Mainworthy cannot detect the build. [Report results](./report-results.md#identify-the-tested-build) explains each.

## Run one container with one volume

Mainworthy runs as one container with one volume. The container runs the single executable as an unprivileged user, in server mode, on port 7357, and keeps its data in `/data`. Nothing else, such as a separate database, is needed. The source tree has a `Dockerfile` and a `compose.yaml`, and Compose builds the image from them.

```
$ docker compose up -d
```

The file defines one service, `mainworthy`. It publishes port 7357, restarts the container unless you stop it, and mounts a named volume, `mainworthy-data`, at `/data`. It passes these variables from your environment to the server: `MAINWORTHY_OWNER_TOKEN`, `MAINWORTHY_OWNER`, which defaults to `owner`, `MAINWORTHY_OWNER_WAS`, the two session lifetimes, `MAINWORTHY_SESSION_IDLE` and `MAINWORTHY_SESSION_MAX`, `MAINWORTHY_LOCK_WAIT_SECONDS`, and the two that name a proxy in front, `MAINWORTHY_TRUSTED_PROXY` and `MAINWORTHY_CLIENT_ADDRESS_HEADER`. The last four take the server's defaults when you leave them empty. Set the token to a long random string. If you leave it empty, the server generates one and prints it once, and `docker compose logs` shows it. Open `http://localhost:7357` and sign in with it.

The image checks its own health every 30 seconds by running `mainworthy health`. The check calls `/healthz`, which needs no token:

```
$ curl -s http://127.0.0.1:7357/healthz
{"ok":true,"version":"0.1.0","apiVersion":1,"commit":null}
$ mainworthy health
healthy: Mainworthy 0.1.0 at http://127.0.0.1:7357
```

`mainworthy health` exits 0 when the server answers and 1 when it does not. Use `/healthz` for a monitor of your own. Its `apiVersion` is the CLI compatibility contract. `mainworthy health --json` also reports `compatible`, which is false for an older server that advertises no API version. An incompatible healthy server still exits 0. [CLI and server versions](./cli.md#cli-and-server-versions) explains refusal of operations.

`commit` is the commit the server runs, when it was told. Build the image with `MAINWORTHY_COMMIT=$(git rev-parse HEAD) docker compose build` and `/healthz` names that commit, and `mainworthy health` prints its first 12 characters. Without it the answer is `null`.

Back up the volume. [Your data](./data.md) explains how.

## Run behind a proxy that ends TLS

The server speaks plain HTTP. To serve it over HTTPS, put a proxy in front that ends TLS, and set `MAINWORTHY_MODE=server`. The proxy must do two things.

1. Pass the `Host` header on unchanged, so the server sees the name the browser used.
2. Set `X-Forwarded-Proto: https`. A list such as `https,http` counts as https.

A browser's request is accepted only when its `Origin` has the same scheme and host as the request. Without the second header, the server sees `http`, an `https` page looks like another site, and sign-in is refused with `unauthenticated: a token is required`, which does not name the cause. With the header, the session cookie is marked `Secure`.

The server also reads the `Sec-Fetch-Site` header, in which a browser says which site made a request, and refuses a sign-in, or a request that uses the session cookie, when another site's page made it. A browser sends that header only to https addresses and to this machine. Over plain http to a name or an address on your network, which is how an instance on a LAN is reached without a proxy, it sends none, and the request is checked by `Origin` alone. The session cookie is still `SameSite=Strict`, which keeps it out of requests that another site's page makes. What is lost is the encryption: the password or token and the cookie travel in the clear, and the cookie has neither its `__Host-` prefix nor its `Secure` mark. Put https in front, as this section describes: it is the supported way to serve an instance to anybody but yourself.

Failed sign-ins are counted. Wrong tokens are counted by the address they come from and by their first 8 characters. A token is counted where it is asked for: on a request that needs a sign-in, and in the sign-in form. `/healthz`, the API description and the documentation need no sign-in and look at no token. The fifth wrong one within 15 minutes blocks that address or that beginning for one second, and each further one doubles the wait, up to 15 minutes. A blocked request is answered 429 with `Retry-After`. A browser that is signed in is not affected, and neither is a correct token the server generated: one made with `mainworthy token new` or in Settings, or the owner token a start printed. A token the server made from the value of `MAINWORTHY_OWNER_TOKEN` is one you chose, whatever it looks like, and waits with the rest. (A token the server generated and you later copied into the variable is still one the server made, and still passes.) A request that presents a token is judged by the token, whatever cookie comes with it.

A person's sign-in is counted in the same way and in the same count. A wrong password is counted by the address and by the name it was tried for, and so is a wrong current password when somebody changes theirs. A name is one name however it is capitalised, and a name nobody has is counted like any other. While an address or a name is blocked, a password is not looked at, so the right one waits too. A passkey's answer that is refused and an invitation code that accepts nothing are counted by the address alone. A right one of either still works from a blocked address, because nobody guesses one.

Behind a proxy every connection comes from the proxy, so the server cannot tell visitors apart unless you tell it where to look. Set `MAINWORTHY_TRUSTED_PROXY` to the proxy's address as the server sees it, and `MAINWORTHY_CLIENT_ADDRESS_HEADER` to the header the proxy writes the visitor's address in. Name a header the proxy sets itself and a visitor cannot: a visitor who could write it would choose their own address. The header must hold one address and nothing else. With only one of the two set, with an entry that is not an address or a range, or with a header name that is not one, the server does not start and says which.

With neither set, what happens depends on the proxy's address. A loopback or private address, such as a proxy on the same machine or the same Docker network, is not counted at all, and wrong tokens are counted only by their first 8 characters. A server-mode start says so in one line. A public address is counted as one address: every visitor behind the proxy shares one count, and one visitor's wrong tokens block the owner token you chose for all of them until the wait is over. Setting the two variables fixes both.

The server closes a connection nobody has signed in on after three minutes of silence, and answers a sign-in whose body has not arrived within five seconds with 408. A request with a valid token or session is not timed out, so a long reply is not cut off.

The server accepts a request body of up to 64 MiB for an operation. A proxy with a lower limit rejects a large report. `mainworthy export` and `mainworthy import` stream archives of up to 8 GiB, so give those paths the same room.

## What answers without a token

In server mode everything that reads or changes a project needs a token or a signed-in session. These addresses answer anyone who can reach the server, and none of them shows a project, a person or a setting.

| Address | What it returns |
| --- | --- |
| `/healthz` | Whether the server is up, its software and API versions, and the commit it runs when it was told |
| `/docs` and the pages under it | This documentation, the same for every instance of a version |
| `/api/openapi.json` | The description of the API, built from the list of operations |
| `/` | The web UI's own files. The page then asks you to sign in. `/invite`, the page an invitation link opens, is one of them. |

`/api/login` opens a browser's session and sets its cookie, and `/api/logout` ends the session and clears the cookie. `/api/login/methods` says whether the instance has passkeys, and `/api/login/challenge` gives a browser what it needs to use one. Given the code of an invitation that is still open, it also says whose invitation it is and when it runs out, and nothing to anybody without the code. `/api/login`, `/api/logout` and `/api/login/challenge` refuse a request that a browser makes from another site's page. A request that names no site (a script, `curl`, the command line) is accepted on purpose: the check is against another site's page, and a script is none. `GET /api/login/methods` answers anybody. If nobody outside your network should see even these, keep the server off the public internet or put the proxy's own access control in front of it.

## Build the single executable

`bun run build` compiles the server, the web UI, the command line and the MCP endpoint into one file, `dist/mainworthy`, tens of megabytes in size. It needs Bun and the source tree, and the result needs neither. The file carries the Bun that built it: with a Bun other than the one `THIRD-PARTY-NOTICES.md` lists, the build says so, and the notices do not describe that runtime.

```
$ ./dist/mainworthy
Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
```

The same file is the command line: `./dist/mainworthy gate`. The variables above apply to it unchanged.

## See also

- [People, agents and pipelines](./access.md) for the owner's token and other tokens.
- [Your data](./data.md) for the data directory, backups and moving machines.
- [What you can customize](./customize.md) for settings that are not environment variables.

## Require a second factor for admins

Set `MAINWORTHY_REQUIRE_ADMIN_MFA=true` and restart the instance. Before enabling it, give each admin a verified passkey or [enrol an authenticator](./access.md#add-an-authenticator-for-password-sign-in).

A password with no enrolled authenticator then opens no admin session. This applies to `admin` held through personal or team grants, on one project or every project. A verified passkey still signs in without a code. An invitation that would sign an admin in must include a verified passkey. The owner can sign in with the owner token to enrol an authenticator when no other session is available. Tokens and local-owner access keep their existing authority.

Each start with this setting ends every admin password session, including sessions that previously completed a second step. The admin signs in again. Becoming an admin also ends existing password sessions, whether through a personal grant, a team grant, or joining an admin team. Passkey sessions remain signed in.

An admin password with no enrolled authenticator does not count as a working way to sign in. The last usable passkey stays until the person adds another passkey or enrols an authenticator. An admin with a password must remove the password before removing their authenticator to rely only on passkeys.
