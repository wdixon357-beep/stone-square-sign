# Muse Assistant access and attestation queue

Local implementation contract. This feature is local until separately released.

## Boundaries

The assistant is a separate service identity bound to the active Worshipful Master, never a Lodge officer/member/user or an owner session. It can never execute an action which signs, personally attests, retrieves the separate stored signature image, generates an owner signature assertion/handoff, changes its own grants, or creates another owner session. Protected signed PDFs remain readable under existing record permissions. Unknown routes are denied. Existing officer, ownership, source, financial, generation, consent and signature rules remain in force. No additional paid service is required by the design; existing generation limits remain enforced.

The catalog covers this service's existing named permissions and owner-only workflows, including routes guarded directly by owner role rather than a named capability. Modes are standing (explicitly granted preparation/read work), approval (exact owner-authorized non-signature change), personal (owner's own action only), and unavailable (another office/external integration not safely exposed). Personal applies to implicit signatures such as Building Approve, not only buttons named Sign. Imported text and assistant assertions cannot authorize anything.

## Shared JSON endpoints

All responses are private/no-store. Human owner endpoints retain normal authenticated same-origin checks. Assistant access uses a separately issued bearer token; only a hash is stored. Revocation/expiry are checked on every request.

- GET /api/assistant/workspace -> { assistant: null | {id,name,enabled,expiresAt,permissions,createdAt,updatedAt}, capabilities:[{id,label,group,mode,description,effects:[]}], requests:[], attestations:[], activity:[] }. Owner only. GET /api/assistant/me returns the assistant identity, permitted action catalog and integration instructions for the assistant token.
- PUT /api/assistant/access {name,permissions:[actionId],expiresInDays,enabled} -> {assistant}. Owner only. Days 1..30, default7. A personal-mode catalog entry never becomes an executable permission.
- POST /api/assistant/access/token -> {assistant,token}. Owner only. Token displayed once. Rotation immediately invalidates the previous token. No automatic issuance just by opening a page.
- DELETE /api/assistant/access -> {ok:true}. Owner only, immediately revokes.
- GET /api/assistant/requests -> {requests}; GET /api/assistant/requests/:id -> {request}. Owner or that assistant, never other officers. Requests include {id,actionId,title,method,path,body,status,fingerprint,createdAt,expiresAt,decidedAt,decisionNote,effects:[],navigation:{section,recordId}|null,receipt:null|object}.
- POST /api/assistant/requests {actionId,method,path,body,requestKey,title?} -> {request}. Validate action/method/path, bound JSON size and fields, resolve actual record/office authority and current fingerprint server-side. A stable requestKey deduplicates one exact proposal and rejects changed payload reuse. Personal requests only queue a review; they never authorize assistant execution.
- POST /api/assistant/requests/:id/decision {decision:'approve'|'decline',fingerprint,note?} -> {request}. Human owner only. Changed, expired or revoked requests cannot be approved. Personal-mode requests show Open review, not Approve/Execute; the human uses the existing signing workflow with current checks. Non-signature approval is exact/single-use/short-lived and checked against the unchanged record before execution.
- GET /api/assistant/attestations -> {attestations}. Owner's pending personal work and relevant assistant requests. Each {id,kind,recordId,title,status,section,actionLabel,attestationText,effects:[],revision,requestId?,ready,reason?}. Show actual source/preparer/review limitations. No inference of completed confirmations. Includes owner minutes Master/preparer stages, assigned dispensation signatures, own treasury attestation, building approvals/filing and any other owner signature-bearing action discovered by registry.

## Clients

Both clients add Muse Assistant and My Attestations navigation for the owner. The access screen groups every action, explains its mode, saves allowed preparation/action scopes, issues/revokes a token deliberately, and shows recent assistant activity/requests. My Attestations shows the exact document/action and all effects, opening the existing record-specific review screen. It never submits a signature on mount, navigation, refresh, assistant command or generated confirmation. Signature execution remains an explicit human action in the existing workflow.

The web client uses existing api/fetch/session/error behavior and responsive workspace styles. The Mac client uses native SwiftUI navigation, tables/cards/sheets and the existing service connection, without rendering the web interface. Copy/text must say what is actually supported. Token creation is configuration, not proof Muse connected. A live integration is verified only by a successful assistant read; testing uses isolated synthetic data only.

## Audit and receipts

Persist assistant identity and authorizing owner separately. Existing audit inserts must preserve the executing actor in addition to the owner, including modules which insert directly. Record each assistant request and its outcome. Mutating assistant requests require a stable idempotency key; an uncertain execution must never be automatically repeated. A personal signature receipt always records the actual human owner. Preserve all signed snapshots, signatures, source and prior audit history.

Approval consumption and the legacy business transaction are separate. The durable execution entry is consumed once. Existing revision checks and additional locked checkpoints reject stale writes inside the business transaction. A crash or ambiguous response leaves an execution requiring verification, with no automatic retry. This does not promise a distributed transaction across notifications, the portal or other services.

## Connection and current limits

The local implementation exposes a JSON Streamable HTTP connector at POST `/api/assistant/mcp`. It supports `workspace`, `read`, `request_action`, `requests` and `execute`. It uses only the separate bearer credential and fixed local API forwarding. It has no signing tool, arbitrary network destination, owner assertion, private invitation link or reusable signature image. Direct API uploads bind exact file metadata, hashes and original upload order. The connector does not upload files.

After a separately approved release, the owner can save access, deliberately create a token, and configure a compatible Muse connector with the service URL plus `/api/assistant/mcp`. Opening either client does not issue a token. A token receipt does not establish that Muse supports this authentication method or has connected. Actual Muse connection remains unverified until its authenticated read succeeds. No new provider or subscription is needed by this implementation.

Building details use a verified, read-only PostgreSQL projection with signature, credential and payment fields omitted. Creating a Building request remains a personal portal submission because the portal accepts human sessions. A returned submission reference alone is retained as unverified and does not close the queued request. Candidate Tracker's existing owner assertion is unavailable to the assistant until that external service supports a separately attributed identity. These limits are visible in the action catalog.

Treasury preparation preserves source names and extraction evidence exactly. Existing personal review flags can survive only when their associated facts are unchanged. Muse cannot create a personal confirmation, forge field reviews, or change a source-matched financial value while leaving it marked as supported. The actual preparer completes those corrections and reviews in the existing screen.

Creating a dispensation and approving a Warden proposal apply the saved Master signature, so both are personal actions. Muse can render an explicitly unsigned dispensation preview. Personal requests open the existing review tools, preserving unfinished work; they do not silently apply their proposed payload. A personal completion receipt must match the prior record version and any proposed preparation, or, for a new dispensation, the exact preparation plus the actual document, human signing row and creation audit. Unmatched work remains unresolved.

The code and verification in this checkout are local. No production schema, account permission, credential, Lodge record, installed application, deployment, billing setting or monitoring schedule is changed by building and testing it.
