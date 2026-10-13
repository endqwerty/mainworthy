# Configuration

Run a Mainworthy instance on your machine or on a server, and set where it listens, where it keeps its data and who owns it. The server reads its settings from environment variables. There is no configuration file.

## Local mode and server mode

The same program runs in two modes. The mode decides how a request proves who sent it.

In local mode you are the owner. The server listens on the loopback address, and a request from this machine needs no token. The web UI opens signed in, and commands run without `--token`. A request counts as yours when three things hold: its `Host` header is a loopback name (`localhost`, `127.0.0.1` or `[::1]`), the connection comes from a loopback address, and it carries none of the headers a proxy or a tunnel adds (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`, `CF-Connecting-IP`). Any other request needs a token. A request that the browser says another site made is refused in both modes.

In server mode every request needs a token. The web UI shows a sign-in page, and a command needs `--token` or `MAINWORTHY_TOKEN`. [People, agents and pipelines](./access.md#sign-in-to-the-web-ui) explains tokens and signing in.

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
| `MAINWORTHY_DATA` | `~/.mainworthy` | The data directory. It holds one SQLite file. |
| `MAINWORTHY_MODE` | none | `server` selects server mode. |
| `MAINWORTHY_OWNER` | `USER`, else `owner` | The name of the owner, who holds every capability on every project. |
| `MAINWORTHY_OWNER_TOKEN` | none | A token for the owner, 20 to 512 characters. Server mode needs one to sign in. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. The same form. |
| `MAINWORTHY_PUBLIC_URL` | none | The address people open the instance at, such as `https://mainworthy.example`. A passkey belongs to its host name, and an invitation link starts with it. Without it there are no passkeys and `mainworthy invite` prints a link with no host. |
| `MAINWORTHY_TRUSTED_PROXY` | none | The addresses or CIDR ranges of the proxy in front, comma-separated. Set it together with the next one, or neither. |
| `MAINWORTHY_CLIENT_ADDRESS_HEADER` | none | The header in which that proxy reports the visitor's address. Believed only on a connection from a proxy named above. |
| `MAINWORTHY_READERS` | the CPU count minus 2, at least 1 and at most 8 | How many reader threads answer reads. `0` answers them on the main thread. |
| `MAINWORTHY_COMMIT` | none | The commit this server was built from, which `/healthz` reports. 40 lower-case hexadecimal characters, or it reads as unknown. Without it the server reads `SOURCE_COMMIT`. |

A value that is not a whole number for `MAINWORTHY_READERS` stops the start with `invalid: MAINWORTHY_READERS must be a non-negative integer`. A session lifetime that is not a duration stops the start too, with a line that names the variable. So does a `MAINWORTHY_PUBLIC_URL` that is not such an address: write `https` and a host name with nothing after it, or `http://localhost` with its port. An IP address and plain `http` anywhere else are refused because no browser makes a passkey there. A path and a query are refused because the server wants the root address of the instance.

The first start creates the data directory, one owner and a project named `scratch`. It does not need any variable.

Every start gives the owner named by `MAINWORTHY_OWNER` every capability. The owner is a person: the server does not start when the name belongs to an agent or a pipeline on this instance, or starts with `forgotten-`. If you change the name later, you get a second owner, and the first one keeps its grant. Remove its grant with `mainworthy actor ungrant`. The first one keeps its tokens too, except the one that came from `MAINWORTHY_OWNER_TOKEN` when you set that variable to a new value: see the next paragraph.

A start that is refused for the owner's name or the owner's token changes no actor and no token. If the server is newer than the database, it has already brought the database up to date by then, and it left a copy of the database as it was beside it, named `mainworthy.db.v<N>.bak`.

In server mode, an owner token is needed to sign in. If you set `MAINWORTHY_OWNER_TOKEN`, the server adds that value as a token for the owner. If you do not, a start on which the owner holds no token that works prints a generated one: the first start, and the start after an import. To get a token after you lost it, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. A new value retires the old one: the start revokes every token that came from this variable before, whoever was the owner then, ends the browser sessions opened with them, and names each token and its actor in one line. A token you made yourself, and one the server generated, keep working, with one exception: a token made by hand before this build and labelled like the variable's own (a label that begins `owner (from `) was marked as the variable's when the database was upgraded, and is retired with it. A value shorter than 20 characters or longer than 512 stops the start; one shorter than 32 starts and warns each time. No token longer than 512 characters works, as a bearer or at sign-in: if an earlier build accepted a longer owner token, set a new value. `openssl rand -hex 32` makes a good one. A value that is already a token retires nothing. If that token was revoked, has reached its end, or is somebody else's, it is not brought back: the server says which in one line on standard error, and you set a new value. Use a long random value and keep it out of version control.

Reader threads let reads continue while a large report is applied. The default suits most machines. Set `0` to turn them off.

## Variables and flags the command line reads

Every command except `serve`, `fmt` and `help` talks to a server. It finds the server in this order: the flag, then the variable, then the default.

| Variable | Flag | Default |
| --- | --- | --- |
| `MAINWORTHY_URL` | `--url` | `http://127.0.0.1:7357` |
| `MAINWORTHY_TOKEN` | `--token` | none |
| `MAINWORTHY_PROJECT` | `--project` | the only project, if there is one |

With more than one project and no choice, a command stops with `invalid: choose a project with --project or MAINWORTHY_PROJECT; projects: scratch, checkout`. The `mainworthy health` command, with no `--url` or `MAINWORTHY_URL`, asks the server on this machine at `MAINWORTHY_PORT`.

For these three variables, a value that is set but empty counts as not set. [Command line](./cli.md) lists every command.

## Variables that describe a CI build

`MAINWORTHY_COMMIT`, `MAINWORTHY_BRANCH`, `MAINWORTHY_PR`, `MAINWORTHY_BASE`, `MAINWORTHY_ATTEMPT`, `MAINWORTHY_JOB`, `MAINWORTHY_BUILD_URL`, `MAINWORTHY_REPO` and `MAINWORTHY_ENV` tell `mainworthy report` which build produced the results. (`MAINWORTHY_COMMIT` means something else to the server: see the table above.) A CI job sets them only when Mainworthy cannot detect the build. [Report results](./report-results.md#identify-the-tested-build) explains each.

## Run one container with one volume

Mainworthy runs as one container with one volume. The container runs the single executable as an unprivileged user, in server mode, on port 7357, and keeps its data in `/data`. Nothing else, such as a separate database, is needed. The source tree has a `Dockerfile` and a `compose.yaml`, and Compose builds the image from them.

```
$ docker compose up -d
```

The file defines one service, `mainworthy`. It publishes port 7357, restarts the container unless you stop it, and mounts a named volume, `mainworthy-data`, at `/data`. It passes these variables from your environment to the server: `MAINWORTHY_OWNER_TOKEN`, `MAINWORTHY_OWNER`, which defaults to `owner`, the two session lifetimes, `MAINWORTHY_SESSION_IDLE` and `MAINWORTHY_SESSION_MAX`, and the two that name a proxy in front, `MAINWORTHY_TRUSTED_PROXY` and `MAINWORTHY_CLIENT_ADDRESS_HEADER`. The last four take the server's defaults when you leave them empty. Set the token to a long random string. If you leave it empty, the server generates one and prints it once, and `docker compose logs` shows it. Open `http://localhost:7357` and sign in with it.

The image checks its own health every 30 seconds by running `mainworthy health`. The check calls `/healthz`, which needs no token:

```
$ curl -s http://127.0.0.1:7357/healthz
{"ok":true,"version":"0.1.0","commit":null}
$ mainworthy health
healthy: Mainworthy 0.1.0 at http://127.0.0.1:7357
```

`mainworthy health` exits 0 when the server answers and 1 when it does not. Use `/healthz` for a monitor of your own.

`commit` is the commit the server runs, when it was told. Build the image with `MAINWORTHY_COMMIT=$(git rev-parse HEAD) docker compose build` and `/healthz` names that commit, and `mainworthy health` prints its first 12 characters. Without it the answer is `null`.

Back up the volume. [Your data](./data.md) explains how.

## Run behind a proxy that ends TLS

The server speaks plain HTTP. To serve it over HTTPS, put a proxy in front that ends TLS, and set `MAINWORTHY_MODE=server`. The proxy must do two things.

1. Pass the `Host` header on unchanged, so the server sees the name the browser used.
2. Set `X-Forwarded-Proto: https`. A list such as `https,http` counts as https.

A browser's request is accepted only when its `Origin` has the same scheme and host as the request. Without the second header, the server sees `http`, an `https` page looks like another site, and sign-in is refused with `unauthenticated: a token is required`, which does not name the cause. With the header, the session cookie is marked `Secure`.

Failed sign-ins are counted. Wrong tokens are counted by the address they come from and by their first 8 characters. A token is counted where it is asked for: on a request that needs a sign-in, and in the sign-in form. `/healthz`, the API description and the documentation need no sign-in and look at no token. The fifth wrong one within 15 minutes blocks that address or that beginning for one second, and each further one doubles the wait, up to 15 minutes. A blocked request is answered 429 with `Retry-After`. A browser that is signed in is not affected, and neither is a correct token the server generated: one made with `mainworthy token new` or in Settings, or the owner token a start printed. A token the server made from the value of `MAINWORTHY_OWNER_TOKEN` is one you chose, whatever it looks like, and waits with the rest. (A token the server generated and you later copied into the variable is still one the server made, and still passes.) A request that presents a token is judged by the token, whatever cookie comes with it.

A person's sign-in is counted in the same way and in the same count. A wrong password is counted by the address and by the name it was tried for, and so is a wrong current password when somebody changes theirs. A name is one name however it is capitalised, and a name nobody has is counted like any other. While an address or a name is blocked, a password is not looked at, so the right one waits too. A passkey's answer that is refused and an invitation code that accepts nothing are counted by the address alone. A right one of either still works from a blocked address, because nobody guesses one.

Behind a proxy every connection comes from the proxy, so the server cannot tell visitors apart unless you tell it where to look. Set `MAINWORTHY_TRUSTED_PROXY` to the proxy's address as the server sees it, and `MAINWORTHY_CLIENT_ADDRESS_HEADER` to the header the proxy writes the visitor's address in. Name a header the proxy sets itself and a visitor cannot: a visitor who could write it would choose their own address. The header must hold one address and nothing else. With only one of the two set, with an entry that is not an address or a range, or with a header name that is not one, the server does not start and says which.

With neither set, what happens depends on the proxy's address. A loopback or private address, such as a proxy on the same machine or the same Docker network, is not counted at all, and wrong tokens are counted only by their first 8 characters. A server-mode start says so in one line. A public address is counted as one address: every visitor behind the proxy shares one count, and one visitor's wrong tokens block the owner token you chose for all of them until the wait is over. Setting the two variables fixes both.

The server closes a connection nobody has signed in on after three minutes of silence, and answers a sign-in whose body has not arrived within five seconds with 408. A request with a valid token or session is not timed out, so a long reply is not cut off.

The server accepts a request body of up to 64 MiB for an operation. A proxy with a lower limit rejects a large report. `mainworthy export` and `mainworthy import` stream archives of up to 8 GiB, so give those paths the same room.

## What answers without a token

In server mode everything that reads or changes a project needs a token. These addresses answer anyone who can reach the server, and none of them shows a project, a person or a setting.

| Address | What it returns |
| --- | --- |
| `/healthz` | Whether the server is up, its version, and the commit it runs when it was told |
| `/docs` and the pages under it | This documentation, the same for every instance of a version |
| `/api/openapi.json` | The description of the API, built from the list of operations |
| `/` | The web UI's own files. The page then asks for a token. |

`/api/login` opens a browser's session and sets its cookie, and `/api/logout` ends the session and clears the cookie. `/api/login/methods` says whether the instance has passkeys, and `/api/login/challenge` gives a browser what it needs to use one. Given the code of an invitation that is still open, it also says whose invitation it is and when it runs out, and nothing to anybody without the code. `/api/login`, `/api/logout` and `/api/login/challenge` refuse a request that a browser makes from another site's page. A request that names no site (a script, `curl`, the command line) is accepted on purpose: the check is against another site's page, and a script is none. `GET /api/login/methods` answers anybody. If nobody outside your network should see even these, keep the server off the public internet or put the proxy's own access control in front of it.

## Build the single executable

`bun run build` compiles the server, the web UI, the command line and the MCP endpoint into one file, `dist/mainworthy`, tens of megabytes in size. It needs Bun and the source tree, and the result needs neither.

```
$ ./dist/mainworthy
Mainworthy 0.1.0 · local · data in ~/.mainworthy · http://127.0.0.1:7357
```

The same file is the command line: `./dist/mainworthy gate`. The variables above apply to it unchanged.

## See also

- [People, agents and pipelines](./access.md) for the owner's token and other tokens.
- [Your data](./data.md) for the data directory, backups and moving machines.
- [What you can customize](./customize.md) for settings that are not environment variables.
