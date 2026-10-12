//go:build !purego

package main

import _ "github.com/mattn/go-sqlite3"

const sqliteDriver = "sqlite3"
const sqliteFlavor = "mattn/go-sqlite3"

func sqliteDSN(path string) string {
	return "file:" + path + "?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=30000&_txlock=immediate&_cache_size=-65536&_foreign_keys=on"
}
