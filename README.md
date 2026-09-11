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
Previewing, printing and saving do not trigger email. The Mac preview has its own
window so the report form remains available.

## Meeting Minutes

The Secretary or Assistant Secretary can paste a corrected Plaud transcript or upload
its TXT, DOCX or PDF export. The app structures a draft for officer review, including
attendance, motions, decisions, assignments and dates. It sends the transcript to the
OpenAI Responses API only when the officer chooses Create Draft, with response storage
disabled. The transcript and resulting draft remain restricted to the Worshipful
Master and the Secretaries inside Stone Square Sign.

The preparer attests first. The Worshipful Master reviews and attests next. The signed
draft then returns to the Secretary as ready for distribution. Nothing is sent to the
Craft automatically, and every copy remains marked DRAFT until the Lodge's formal
approval is recorded after a communication.

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
| `OPENAI_API_KEY` | the API key used only when an authorized officer creates draft meeting minutes |

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

38 checks. They should all pass before anything is deployed.

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
