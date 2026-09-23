# Stone Square Sign

A signing queue for Lodge documents that need the Secretary's or the Assistant
Secretary's signature. Dispensations today, anything else later.

The shared service currently runs on Render Starter and Neon Free. See hosting costs below.

---

## What it does

The Worshipful Master uploads a PDF. The server reads the text, works out which
officers it names, and puts it in a queue. Officers sign it from a phone, a tablet or
a browser. When the last required signature lands, everybody involved gets the
executed PDF by email and the document is marked complete.

- Officers join by private invitation only. Nobody can register off the street.
- First sign-in makes a signature: draw it, or type a name and pick from five styles.
  Changeable later from Profile.
- The queue updates live across every connected device.
- Every upload, signature and consent is written to an audit trail with IP and time.
- The document as uploaded is kept separately from the executed copy, so the original
  is always recoverable.

## Report Generator

Home and the sidebar open the shared Report Generator inside the web dashboard and
Mac app. The report form stays separate from the dispensation signing queue. Brothers
preview first, then review, type their signature and explicitly send the final report.
Previewing, printing and saving do not trigger email. The native Mac form and PDF
preview stay together in the app workspace.

## Meeting Minutes

The Worshipful Master and the Secretaries can paste compiled meeting notes or a
corrected transcript, or upload TXT, DOCX or PDF. Source detection preserves agenda
blocks and topic context. With `OPENAI_API_KEY` configured on the shared server,
GPT-5.6 Luna organizes minutes and treasury source text into structured drafts.
Without the key, the existing local organizer remains available and both clients
show that Luna setup is pending. Missing details remain marked for review.

### Luna setup and usage

1. Sign in to OpenAI Platform, enable API billing and create a project API key.
   API billing is separate from a ChatGPT subscription. For an initial trial,
   purchase $5 in prepaid credits and disable automatic recharge.
2. In Render, select `stone-square-sign`, open **Environment**, add
   `OPENAI_API_KEY`, and choose **Save and deploy**. Never put the key in a source
   file, client app, screenshot, support message or repository.
3. Refresh Meeting Minutes or Treasurer Reports. Both clients show the connection
   state. Validate one synthetic example before using real Lodge records.

The server fixes the model to `gpt-5.6-luna`, uses the default service tier,
sets `store:false`, and has no autonomous tools or conversation history. Only
creating or explicitly reorganizing drafts calls OpenAI. Banking information
saved for a later preparer, document previews, edits, signatures and downloads
make no paid generation calls. PDFs and screenshots use the existing local text
extraction/OCR first; Luna receives the extracted text, not the original files.

A database ledger enforces a shared $5 allowance per UTC calendar month. It
reserves conservative input and maximum output costs before each request;
pending or uncertain charges continue to count. Repeating a completed identical
request from the same account reuses its result. Reported usage is estimated at
conservative rates, not a billing statement. The allowance covers this app only;
it cannot limit other uses of the key or changes in provider pricing. Configure
an OpenAI project budget as an additional alert, not a substitute for this limit.
The ledger retains existing Terra charges in the current month. Luna estimates
round up to $0.50 per million input tokens and $1.50 per million output tokens
at the ledger's existing integer scale, above the published Luna rates.

Structured output and exact source quotes help reviewers trace extracted content.
They do not prove every interpretation is correct. Missing or contradictory facts
remain review items. Arithmetic, reconciliation, access checks, signatures and
approval states remain deterministic application controls. Generation failures
preserve the source and do not silently switch to the local organizer.

Attendance is matched to the officer roster. Financial report figures remain in the
circulated report. The minutes record whether it was read aloud. The PDF uses the
Lodge's navy and gold format, consolidated into occupied sections, without emblems,
empty worksheets or a Grand Lodge Officer Remarks section. The preview refreshes
when fields change. A bundled PDF.js renderer shows every page on phones and iPads.
Computer screens show editing and preview side by side; smaller screens have Edit
and Preview views. All document pages retain US Letter dimensions and fixed margins.
The Mac client uses SwiftUI forms and PDFKit for minutes and
reports; the website uses the same shared services through its browser interface.

An unsigned draft may be deleted by its preparer or the Master. Deletion removes it
from the active list while retaining an audit entry. Signed records cannot be deleted.
An older draft can be reorganized from its original source into an unsaved preview.

The preparer attests first. The Master may edit the submitted record during review,
with each correction shown as submitted and reviewed text. Both signatures and the
versions they attest to are retained as immutable snapshots. After the Master signs,
the preparer and Secretary receive notice. The Secretary distributes the authorized
draft. No minutes are emailed to the Craft automatically. Formal Lodge approval is
recorded separately and removes the DRAFT marking.

## What it costs

The live Render service was verified on **Starter, $7/month**, on September 4, 2026.
Neon is on Free. The table below describes a target free configuration, not the current
bill. Before downgrading Render, replace the SMTP transport with an HTTPS email API:
Render Free blocks outbound SMTP ports 25, 465 and 587. Retain the same database and
verify invitation, reset and signed-document delivery before changing the plan.

| Piece | Service | Free allowance |
|---|---|---|
| Web server | Render, free web service | 750 instance hours a month |
| Database | Neon, free plan | 0.5 GB, no card required |
| Email | HTTPS email API, integration required | Resend Free: 100/day, 3,000/month |

Two consequences of free, both worth knowing before you commit:

**The server sleeps.** A free Render service spins down after 15 minutes idle and
takes about a minute to wake. The first officer to open the queue in a day waits;
everyone after that does not. While anyone has the queue open, the live event stream
keeps it awake.

**No persistent disk.** A free web service cannot attach one, so the documents, the
executed copies and the signature images are held in Postgres as `bytea`. At roughly
300 KB a dispensation, 0.5 GB is on the order of 1,600 documents.

**Health checks do not use database time.** Render and the daytime wake-up workflow
call `/api/health` frequently. That endpoint checks only the web process, so an idle
Neon database can suspend instead of consuming compute for routine host checks.

## Account recovery

Password reset codes are emailed to the address on the account. The application does
not collect or store phone numbers.

William's personally authorized Mac installation uses a separate persistent session and opens directly into his account without a password or Touch ID. Its credential stays in the Mac app's private storage. Temporary connection failures show Reconnect and preserve it. Account reset or explicit revocation can still invalidate access. The local setup is recorded in the audit trail; it does not disable website authentication.

Website sessions use a 90-day inactivity window. An officer who uses the desk during the last
30 days of that window is renewed for another 90 days. Explicit sign-out, password
reset and access revocation still end the affected session immediately.

**A Mac app for anyone else's Mac.** Distributing a Mac app that opens without a
Gatekeeper warning needs an Apple Developer ID, which is $99 a year. The app runs on
the Mac it was built on. The officers use the URL, which is what they want anyway.

---

## Deploy it

You need a Neon account and a Render account. Both are free and neither asks for a
card. Create them yourself; this is the one part nobody can do for you.

**1. Database.** At neon.tech create a project. Copy the **pooled** connection string,
the one with `-pooler` in the host name. That is `DATABASE_URL`.

**2. Mail (paid Render only).** The current SMTP implementation requires a Render tier that permits SMTP. For that configuration, at myaccount.google.com/apppasswords, with two-step verification on,
generate an App Password for the Lodge account. That sixteen character string is
`SMTP_PASS`. It is not the account password and it can be revoked on its own.

**3. Web service.** At render.com, New, Web Service, point it at this repository.
`render.yaml` already sets the free plan, the build and the health check. Fill in the
variables marked `sync: false`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled string |
| `APP_BASE_URL` | the Render URL, no trailing slash |
| `OWNER_EMAIL` | the only address allowed to claim the owner account |
| `SMTP_USER` | the Lodge Gmail address |
| `SMTP_PASS` | the App Password from step 2 |
| `MAIL_FROM` | `Stone Square Sign <that same address>` |

**4. Claim the owner account.** Open the URL and register with `OWNER_EMAIL`. That is
the only account that can be created without an invitation, and only once.

**5. Invite the officers.** From Officers, invite Secretary William McDuffie and
Assistant Secretary Adrian Reese. Each gets a private link that expires in seven days
and works once.

**6. Point the Mac app at it.** Open Stone Square Sign, Settings, and set the server
address to the Render URL. It defaults to `http://localhost:3000`, which only works
while a server is running on this machine.

## Run it locally

    npm install
    cp .env.example .env
    npm start

With `DATABASE_URL` blank it runs on PGlite, which is PostgreSQL compiled to
WebAssembly. Nothing has to be installed. Set `PGLITE_DIR` to keep that data between
restarts. Note that a local database is a *separate* queue from the hosted one.

## Test it

    npm test

Spawns the real server against an in-memory Postgres and drives the whole flow: the
schema builds, an uninvited stranger is turned away, officers join by invitation, an
invitation cannot be replayed, a PDF survives the round trip byte for byte, signatures
accumulate onto one document instead of replacing each other, the document completes
only when every signer is done, record copies are mailed, the original is still
recoverable, and the reset form gives the same answer for a real account as for one
that does not exist.

All checks should pass before anything is deployed.

## A note on the database driver

`node-postgres` returns `int8`, which is what `COUNT(*)` is, as a **string**. PGlite
returns a number. Left alone, `remaining === 0` is true in the local test and false on
Neon, so every test would pass and no document would ever reach completed in
production. `db.js` sets a type parser to make the two agree. Do not remove it.

## Layout

    server.js        routes, auth, signing, mail
    db.js            the one place that knows which Postgres it is talking to
    public/          the web client officers use
    macos/           the SwiftUI Mac client
    test/e2e.mjs     the end to end proof
    render.yaml      free tier deployment
