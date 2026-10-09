# free-exercise-db

The exercise catalog. Loaded into the read-only `catalog_exercises` table by
migration `0002`. Text, equipment, and muscle data only; images are not used.

- Source: https://github.com/yuhonas/free-exercise-db
- Commit: `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5` (2026-09-27)
- File: `dist/exercises.json` at that commit, unchanged (876 exercises)
- SHA-256 of `exercises.json`: `5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf`
- License: the Unlicense (public domain), copied here as `UNLICENSE`

To update, replace `exercises.json` with the file from a newer commit, update
this file, and add a migration that reloads the catalog. Never edit the JSON by hand.
