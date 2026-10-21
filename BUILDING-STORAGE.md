# Building Requests storage migration

Building Requests can use the dashboard's existing PostgreSQL database without
adding a service or changing officer permissions. The public request portal keeps
its agreement, signature, status-link, and calendar handlers. Only its private
storage transport changes.

## Release gate

Do not activate the replacement database with an empty queue, partial workflow
cache, downloaded PDFs, or reconstructed signature records. The original complete
`resv:*` export is required. The known source contains existing requests.

The October 20, 2026 implementation is prepared and tested locally. A release
requires current evidence for every gate below. A successful local test is not
evidence that the provider has allowed access or that the migration is live.

1. Verify access to the original database and record its identity and current
   state. Keep the free plan. Obtain an export or no-cost read access if suspended.
2. Fence every legacy writer, including superseded immutable deployment URLs.
   An alias switch or temporary quota suspension alone is not a lasting fence.
   Preserve unrelated report and board services if credentials are changed.
3. Export the complete key inventory twice. Preserve raw strings and exact
   absolute expiries. Confirm identical inventories, archive hashes, request IDs,
   agreement content, signatures, status tokens, and notification metadata.
4. Stage, verify, and activate the target as separate steps. Retain the original
   private export, per-key files, manifest, per-record checksums, and signature
   checksums. Never overwrite a target after officers have changed its records.
5. Release the portal transport and verify the public URL and installed native
   app against the same authoritative records. Use synthetic local records for
   write, approval, signature, and notification rehearsals. Do not create test
   Lodge requests or send test notifications in production.

## Storage and authentication

`building-store.js` creates dedicated tables in the existing database. It stores
the original archive as text, avoiding JSON reserialization during migration.
All runtime archive updates use atomic compare-and-set. Temporary verification
and rate-limit keys retain expiration behavior. Persistent agreements cannot
expire or be removed through the bridge.

The internal route is `POST /api/internal/building-store`. Both services use a
private `BUILDING_STORE_BRIDGE_SECRET` with at least 32 bytes. An HMAC authenticates
the exact body, timestamp, and request ID. No secret belongs in the browser,
native app, source control, test output, or release evidence.

Portal configuration for the cutover:

```text
BUILDING_STORE_BACKEND=sign-postgres
BUILDING_STORE_BRIDGE_URL=https://stone-square-sign.onrender.com/api/internal/building-store
BUILDING_STORE_BRIDGE_SECRET=<configured privately in both services>
```

Absent configuration retains the current Redis backend. Once configured for
PostgreSQL, failures never fall back to Redis. An uninitialized or invalid target
returns an error instead of an empty successful queue. Read-only archive polling
does not persist copies in retry receipts. Mutations use bounded retry receipts;
the portal retries one lost response with the identical signed request.

## Operator tools

`scripts/export-building-store.mjs` performs only source reads. Supply source
credentials privately and explicitly, plus an evidence file confirming that all
legacy writers are fenced. It does not load a repository environment file. It
refuses unsupported keys or types, missing source data, changed inventories,
changed archives, approximate expiries, and overwriting an existing backup.

`scripts/migrate-building-store.mjs` supports `stage`, `verify`, `stage-target`,
`verify-target`, and `activate-target`. Target commands require an explicit
database configuration and `--confirm-target`. Activation also requires the
verified manifest checksum. Only activation changes the readiness state.

Use `--help` on the exporter and inspect the migration command before execution.
Run target commands only after verifying which database the process will use.

If Upstash provides an RDB export, preserve that original file privately before
conversion. `scripts/import-building-rdb.mjs --rdb FILE --inspect` checks the
complete file without opening a network connection or importing a database.
It supports only reviewed RDB formats and refuses unsupported content. Conversion
requires the provider's actual capture time and a verified writer-fence record.
The converter preserves original text and exact expiries, including expired
entries. An unsupported format or disabled checksum requires separate review;
do not weaken validation to force an import through.

## Verification

The package's functional rehearsal includes `test/building-store.mjs` and
`test/building-store-export.mjs`. The portal's dedicated adapter and handler
tests cover existing status links, signed agreements, private verification,
approval, attestation, calendar privacy, duplicate prevention, and failures.
Offline RDB conversion is covered by `test/building-store-rdb.mjs`.

For a real local transport rehearsal, set `BUILDING_PORTAL_ADAPTER_PATH` to the
reviewed portal `api/_building-store.js` and run
`node test/building-store-bridge.mjs`. This uses loopback HTTP and an isolated
PGlite database. It does not contact production or send messages.

## Recovery

Retain the original source and private exports. After cutover, PostgreSQL is the
only writable authority. Roll back code while preserving that storage choice.
Do not repoint an active portal to the stale Redis archive. Reversing the data
migration requires a new fenced, complete export from the current authority and
independent verification before changing the destination.
