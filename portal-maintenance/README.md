# Maintained portal corrections

These files are reviewed overlays for the existing Stone Square request portal. They are not a complete portal application. Never deploy this folder as an empty replacement.

The complete previous build, project IDs, migration helpers and static assets are preserved privately in the October 20 Building Requests migration evidence. Assemble an exact copy of that build, apply only the reviewed calendar, report-renderer and report-page overlays, and record before/after hashes. Keep PostgreSQL as the sole writable Building Requests store and retain the project firewall fence on generated deployment hosts.

The owner report renderer depends on the authenticated Sign `/api/reports/signature` endpoint. Release the compatible Sign backend before promoting the portal report changes. No filed report, agreement, signature or calendar record is modified by these overlays.

The October 21 release is prepared in private project evidence and must not be promoted while the database provider is refusing connections. Local regression and rendering checks do not establish production recovery.
