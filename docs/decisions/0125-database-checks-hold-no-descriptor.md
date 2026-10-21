# 0125: Database file checks close no descriptor on a file SQLite may hold

Date: 2026-10-21. Status: accepted. Amends decision 0120.

Decision 0120 checked each database file through an open descriptor and then closed it. On POSIX systems, closing any descriptor on a file drops every lock the process holds on that file, including the locks SQLite holds for another connection. Every server start opens the database several times in one process: the writer, the writer's read connection, the reader threads, the checkpoint thread and the demo reset. Each later open dropped the writer's locks. Another process could then take the write lock beside the writer (`test/storage-permissions.test.ts` shows it), or find the shared-memory index unowned and rebuild it under the server. The checkpoint thread then failed to open with `SQLITE_BUSY_RECOVERY` or `database disk image is malformed` ([#689](https://github.com/endqwerty/mainworthy/issues/689)).

An existing database file and its `-wal`, `-shm` and `-journal` are now checked by path: `lstat` refuses a symbolic link, a file that is not regular and a file owned by another user, and `chmod` repairs a mode other than `0600`. A file that does not exist yet is still created through a descriptor with `O_CREAT | O_EXCL | O_NOFOLLOW` at mode `0600`. No connection can hold a file that did not exist, so closing that descriptor drops nothing.

The check by path leaves the same window decision 0120 already assumes away: an untrusted operating-system user who can replace entries in the data directory between the check and SQLite's open, which SQLite makes by path in any case. [Issue #659](https://github.com/endqwerty/mainworthy/issues/659) still covers that design.
