# Your data

Find your data, export it to a text file, back it up and move it to another machine. Your cases, results and decisions are yours, and you can take them out at any time.

## Where the data lives

Mainworthy keeps everything in one SQLite file, `mainworthy.db`, in the data directory. The directory is `~/.mainworthy` unless you set `MAINWORTHY_DATA`, and `/data` in the container. See [configuration](./configuration.md#variables-the-server-reads).

```
$ ls ~/.mainworthy
mainworthy.db  mainworthy.db-shm  mainworthy.db-wal
```

While the server runs, it also keeps a `-wal` and a `-shm` file beside the database. The three belong together. After a clean stop the `-wal` file is empty.

The file holds every project, case and version, every result, decision and policy, and the actors, grants and a hash of each token. Treat it like the data of any private system.

## Export everything

An admin on every project exports the whole instance with one command. It works while the server runs, and the archive is one consistent snapshot.

```
$ mainworthy export --out mainworthy.ndjson.gz
exported to mainworthy.ndjson.gz
```

A file name that ends in `.gz` is compressed, and any other name is plain text. Mainworthy writes the file readable by you only. It builds the file beside the destination and renames it when the export is complete, so a failed export leaves an earlier backup alone. In server mode the command needs an admin token. Give it with `--token` or `MAINWORTHY_TOKEN`. The web UI has no export button.

The archive is text, one JSON object per line. The first line describes the archive. Each row of data follows on a line of its own. The last line holds a row count and a SHA-256 checksum of everything before it.

```
$ head -n 1 mainworthy.ndjson | cut -c 1-80
{"mainworthy":"archive","format":1,"schema":1,"exportedAt":1791875678677,"tables
$ tail -n 1 mainworthy.ndjson
{"end":true,"rows":67,"sha256":"ca0a5d4d76fe0de47415d595159393df3fad4fc517e4227325a4e5b5ca6b9cf7"}
```

You can read it with any tool that reads text, search it with `grep`, and keep it in version control if the data suits that.

The archive holds everything except two things. It leaves out tokens, because they are credentials, and the search index, which Mainworthy rebuilds on import. Anyone who reads the archive reads your cases and decisions, so store it as you would the data itself.

## Import into a new instance

An import loads an archive into a new instance and makes it a copy of the one that exported it. It does not merge.

1. Start a new instance and make nothing in it.
2. Run `mainworthy import` with the archive.

```
$ mainworthy import mainworthy.ndjson.gz
imported 67 rows across 36 tables
Import replaced the bootstrap rows. Your previous session may no longer exist. The configured local owner was refreshed.
```

A `.gz` suffix tells the command to decompress. The import checks the whole archive before it keeps anything: every row count, the checksum, each column and each link between records. If any check fails, nothing changes.

An instance that already has data refuses an import and keeps what it has:

```
$ mainworthy import mainworthy.ndjson.gz
conflict: import needs a fresh instance; existing projects or user data will not be replaced
```

A fresh instance is one that has only its first project, `scratch`, with no edits and no policy change, and only its owner. Making a token for a new person, agent or pipeline adds an actor, and that is enough to make the instance non-fresh. There is no merge yet, so to bring an archive into an instance that has data, start a new instance.

An archive imports only into a build with the same schema as the one that wrote it. A newer archive is refused with a message to upgrade. An older one is refused too, because Mainworthy cannot yet replay an archive across a schema change. Use the same version on both sides.

After an import in server mode, the tokens are gone, because the archive carries none. It carries no password, passkey or invitation either: an archive holds nothing that signs somebody in. The people, agents and pipelines are still there with their grants. Restart the server to sign in: with no owner token configured it prints a new one, and with `MAINWORTHY_OWNER_TOKEN` set it takes that value. Then make new tokens for the others with `mainworthy token new`, and as the owner invite each person again with `mainworthy invite new <name>`, which for a person who exists prints a recovery link. In local mode, Mainworthy refreshes the owner and you can carry on.

## Back up

Run an export on a schedule, from any machine that can reach the server, and keep the files somewhere other than the server.

```
$ MAINWORTHY_URL=https://mainworthy.example.com MAINWORTHY_TOKEN=<token> \
    mainworthy export --out backup-2026-10-13.ndjson.gz
exported to backup-2026-10-13.ndjson.gz
```

Test a backup now and then by importing it into a throwaway instance. A backup you never restored is a guess.

A second way is to copy the data directory. Stop the server first, then copy the whole directory, including the `-wal` and `-shm` files. A copy keeps the tokens, which an export does not. Start a server with `MAINWORTHY_DATA` pointing at the copy and it comes up with the same cases, tokens and decisions. In the container, back up the volume the same way, with the container stopped.

## Move to another machine

Moving is an export on the old machine and an import on the new one.

1. On the old machine, run `mainworthy export --out mainworthy.ndjson.gz`.
2. Copy the file to the new machine.
3. On the new machine, install the same version of Mainworthy. Start a server with an empty data directory. In server mode, set `MAINWORTHY_OWNER_TOKEN`.
4. Run `mainworthy import mainworthy.ndjson.gz`.
5. Restart the server, so the owner token you set becomes a token.
6. Make new tokens for agents and pipelines, put them into your CI secrets and agent settings, and point `MAINWORTHY_URL` at the new address.
7. Stop the old server when everything reports to the new one.

If you want to keep the tokens, stop the server and copy the data directory instead, as described under backups.

## See also

- [Configuration](./configuration.md) for `MAINWORTHY_DATA` and the owner token.
- [People, agents and pipelines](./access.md) for making tokens again.
- [Command line](./cli.md) for the flags of `export` and `import`.
