# 0123: Name a trunk change only from its recorded landing

A merged pull request's head can be a commit it did not land on trunk, such as a pull request from main into a release branch. Ending a change without landing metadata leaves that head unchanged. Its head cannot establish which change landed a trunk commit.

Store received landing metadata on `change_ends`: exact commit, repository and branch. Reopening removes it, closing clears it, a corrected landing replaces it, and repeating merged without metadata preserves a known landing. Earlier merged changes have no recorded landing. Do not backfill from their heads.

A trunk result names a change only when exactly one current merged end records its project, repository, branch and exact commit. Its decision scope stays on trunk. Resolve all targets on a result or run page in one query, using an index on the landing tuple.

Keep landings with the ends already omitted from archives by decision 0022. Imported changes remain open and name no landing. This changes only an excluded table, so migration 0036 does not change the archive version.

A separate landing table would duplicate the end's lifecycle. Inferring a landing from a merged head would retain the false association this decision removes.
