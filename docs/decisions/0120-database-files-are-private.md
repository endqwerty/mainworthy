# 0120: Database files are private

Date: 2026-10-20. Status: accepted.

The SQLite database contains project records, identity data and credential hashes. Its write-ahead log, shared-memory file, rollback journal and upgrade copies can contain the same data. On POSIX filesystems, Mainworthy creates these files with mode `0600`, repairs broader permissions before SQLite reads or writes them, and refuses an existing file owned by another operating-system user.

The check is made through an open file descriptor before SQLite opens a database path. Symbolic links and non-regular database paths are refused. Upgrade copies are created exclusively at their final private mode before `VACUUM INTO` writes them, then published through the existing synced rename.

Mainworthy does not change the data directory's mode. A configured directory can contain operator-managed files and can depend on group traversal or container volume ownership. Protecting the files that Mainworthy owns keeps that contract while removing access to the sensitive bytes. Existing retained copies are repaired on startup, migration and former-install adoption.

This boundary assumes an untrusted operating-system user cannot replace entries in the data directory between Mainworthy's descriptor check and SQLite's open. Mode `0600` also does not establish an owner-only ACL on Windows. [Issue #659](https://github.com/endqwerty/mainworthy/issues/659) records the Windows ACL and adversarially writable-directory design that remains before those hosts can claim the same boundary.
