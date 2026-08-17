# Backup and restore

Every executed dispensation the Lodge holds lives in one Postgres database. If it is
lost, the signed instruments are lost. This is the procedure, and it has been tested
end to end rather than written from memory.

`pg_dump` is deliberately not used. It is not installed on the Mac, it would have to
be version matched to the server, and it produces a file nobody verifies. `migrate.mjs`
runs in both directions and **hash checks every stored PDF and every signature on the
way out and the way in**, so a backup that silently corrupted a document cannot pass.

## Take a backup of production

    cd ~/dev/stone-square-sign
    STAMP=$(date +%Y%m%d-%H%M%S)
    node migrate.mjs --from "$DATABASE_URL" --to "pglite:$HOME/Backups/stone-square-sign/neon-$STAMP"
    tar -czf "$HOME/Backups/stone-square-sign/neon-$STAMP.tar.gz" \
        -C "$HOME/Backups/stone-square-sign" "neon-$STAMP"

Do not paste `DATABASE_URL` on the command line where it lands in shell history. Export
it first, or read it from `.env`.

It must finish with:

    Migration verified. Row counts match and every stored PDF and signature hashes identical.

Anything else means the backup is not trustworthy. Do not keep it and do not proceed.

## Restore into a new database

    node migrate.mjs --from "pglite:<backup directory>" --to "$NEW_DATABASE_URL"

The tool refuses a target that already holds rows unless `--force` is given, so a
restore cannot quietly overwrite live data by accident.

## Verify without writing anything

    node migrate.mjs --from "pglite:<backup directory>" --to "$DATABASE_URL" --verify

Compares row counts per table and sha256 of every stored object. Touches nothing.

## What is covered

All ten tables: `users`, `sessions`, `invitations`, `reset_codes`, `submission_profiles`,
`office_slots`, `profile_signatures`, `documents`, `document_signers`, `audit_events`.
Primary keys are preserved with `OVERRIDING SYSTEM VALUE`, because `document_signers`
and `audit_events` reference documents and users by id, and renumbering would silently
reassign who signed what. Identity sequences are advanced afterwards so the next real
insert does not collide.

Hash verified objects: every `documents.file_bytes` (the instrument as uploaded), every
`documents.signed_bytes` (the executed copy), every `document_signers.signature_bytes`,
and every `profile_signatures.signature_bytes`.

## Tested on 2026-08-17

- Local `.pglite` tarred, extracted to a scratch directory, opened, all 10 tables and
  28 rows present, all 4 document PDFs readable.
- Local `.pglite` migrated to a scratch Postgres: 28 rows, **13 stored objects hash
  identical**, statuses preserved (2 completed, 1 partially signed, 1 rescinded).
- That copy migrated onward to a second scratch Postgres: same 13 hashes again, proving
  the restore direction.
- The original `.pglite` was not modified at any point.

## Schedule

Take a backup before any deploy that changes `db.js` or the schema, and after any
stated communication at which documents were executed. There is no automatic backup on
Neon's free plan; this is manual and it is nobody's job unless it is the Worshipful
Master's.
