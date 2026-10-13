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
| `MAINWORTHY_OWNER_TOKEN` | none | A token for the owner. Server mode needs one to sign in. |
| `MAINWORTHY_SESSION_IDLE` | `14d` | How long a browser stays signed in without being used. A whole number and `h`, `d` or `w`: `12h`, `14d`, `2w`. |
| `MAINWORTHY_SESSION_MAX` | `90d` | How long a browser stays signed in at most, however much it is used. The same form. |
| `MAINWORTHY_READERS` | the CPU count minus 2, at least 1 and at most 8 | How many reader threads answer reads. `0` answers them on the main thread. |
| `MAINWORTHY_COMMIT` | none | The commit this server was built from, which `/healthz` reports. 40 lower-case hexadecimal characters, or it reads as unknown. Without it the server reads `SOURCE_COMMIT`. |

A value that is not a whole number for `MAINWORTHY_READERS` stops the start with `invalid: MAINWORTHY_READERS must be a non-negative integer`. A session lifetime that is not a duration stops the start too, with a line that names the variable.

The first start creates the data directory, one owner and a project named `scratch`. It does not need any variable.

Every start gives the owner named by `MAINWORTHY_OWNER` every capability. The owner is a person: the server does not start when the name belongs to an agent or a pipeline on this instance, or starts with `forgotten-`. If you change the name later, you get a second owner, and the first one keeps its grant. Remove its grant with `mainworthy actor ungrant`.

In server mode, an owner token is needed to sign in. If you set `MAINWORTHY_OWNER_TOKEN`, the server adds that value as a token for the owner. If you do not, a start on which the owner holds no token that works prints a generated one: the first start, and the start after an import. To get a token after you lost it, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. A value that was revoked, or that is somebody else's token, is not brought back: the server says so in one line on standard error. Use a long random value and keep it out of version control.

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

The file defines one service, `mainworthy`. It publishes port 7357, restarts the container unless you stop it, and mounts a named volume, `mainworthy-data`, at `/data`. It passes these variables from your environment to the server: `MAINWORTHY_OWNER_TOKEN`, `MAINWORTHY_OWNER`, which defaults to `owner`, and the two session lifetimes, `MAINWORTHY_SESSION_IDLE` and `MAINWORTHY_SESSION_MAX`, which take the server's defaults when you leave them empty. Set the token to a long random string. If you leave it empty, the server generates one and prints it once, and `docker compose logs` shows it. Open `http://localhost:7357` and sign in with it.

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

`/api/login` opens a browser's session and sets its cookie, and `/api/logout` ends the session and clears the cookie. Both accept only a request from the server's own pages. If nobody outside your network should see even these, keep the server off the public internet or put the proxy's own access control in front of it.

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
