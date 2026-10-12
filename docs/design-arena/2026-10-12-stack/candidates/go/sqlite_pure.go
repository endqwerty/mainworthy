//go:build purego

package main

import _ "modernc.org/sqlite"

const sqliteDriver = "sqlite"
const sqliteFlavor = "modernc.org/sqlite"

func sqliteDSN(path string) string {
	return "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(30000)&_pragma=cache_size(-65536)&_pragma=foreign_keys(ON)&_txlock=immediate"
}
