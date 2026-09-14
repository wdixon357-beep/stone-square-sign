# Stone Square standing report rules

These are William Dixon-Saunders's settled requirements. Update this record, the shared instructions in `report-rules.js`, and relevant regression tests together when he changes a rule. Both Mac and website call the shared service. The model receives the rules on every generation request; it does not learn them permanently from conversation. Code, not model instructions, controls permissions, signatures, money and publication.

## Officer access and administrative details

- Jamal Sadler and Xavier White have the Warden work areas: dispensation statuses, read-only dues and Candidate Tracker, Report Generator, their own signature profile, and My Dispensation Proposals. Each Warden sees his own proposal submissions, feedback and status. The Worshipful Master sees and reviews all proposals.
- Jamal and Xavier can view finalized minutes and treasurer reports, with no preparation or editing. Xavier also has bank-material upload access. Neither has officer administration, private approvals, executed dispensation downloads, or signing authority for someone else's dispensation.
- McDuffie and Adrian can prepare minutes and treasurer reports, use Report Generator, view dues and Candidate Tracker, and manage their own signature and settings. McDuffie can upload banking material; Adrian cannot.
- David Marable is Assistant Treasurer and occupies that office in the account roster, not a separate generic Treasury Report Preparer entry.
- John Brown and David Marable can prepare treasurer reports, use Report Generator, view dues, and manage their own signature and settings. John can upload banking material; David cannot. Both can view the universal meeting-minutes and treasurer-report archives. Neither receives Candidate Tracker access.
- Every officer can view finalized Dashboard records and the curated historical meeting-minutes and treasurer-report archives. Historical records remain read only, are labeled as archive records, and never receive fabricated modern signatures, attestations, approvals or distribution status. Records open inside the website or native Mac app and provide a visible return control. Kenny Davis and Bobby Collins are excluded from the current invitation rollout at William's direction.
- The historical archive follows the Lodge meeting season, September through June. Files dated in July or August are excluded. Imports must search the Brothers library plus verified historical supplements, deduplicate by record type and meeting date, preserve the original file, and reject mislabeled records whose contents belong to another organization or date.
- The Worshipful Master retains all capabilities and can change individual capabilities in Officer Access. Preparation, finalized report viewing, and banking uploads are separate permissions. Changes must be enforced by the shared service, not just hidden navigation. Signature profile access is separate from document signing authority.
- Generation provider/model names, usage, charges and remaining allowance are visible only to the Worshipful Master. Non-owner API responses and interface notices use neutral report-assistance wording; hiding a label alone is insufficient.

## Minutes

- Accept complete transcripts, compiled notes and supported uploads. Preserve substantive source details and evidence, distinguish proposals from decisions, and flag unknowns or conflicts. Keep related event details, responsibilities and outcomes together. Never manufacture facts, votes, attendance, times or prayers.
- Use the established template with a mixed format: short paragraphs for opening, reading of minutes, report summaries, degree work, business discussion, Good of the Order and closing; bullets only for separate sickness and distress updates, correspondence and reminders. Keep each motion together in a clearly labeled paragraph containing the proposal, discussion and recorded outcome, with recorded mover and seconder. Separate paragraphs with a blank line. Use bold section headings and restrained emphasis. This replaces the earlier instruction to make everything bullet points. Use WM Dixon-Saunders in narrative. Keep actual source quotations intact. Avoid promotional or decorative prose.
- Degree choices are First Degree, Second Degree, Third Degree and Round Table. Meeting type is Stated Communication or an entered other type. Quorum is Yes or No in its dedicated field. Keep attendance and excused members in dedicated records; do not repeat Roll Call or Quorum narrative. A mention or spoken contribution does not establish attendance.
- Record visitors only when supported, retaining names and Lodge affiliations. Omit empty visitor labels and sign-in-book boilerplate. Never create Praise Reports, Grand Lodge Officer Remarks or person-named prayer subsections. Remove standalone None recorded/None reported/N/A filler while preserving real negative outcomes. Move substantive material from obsolete headings into the appropriate canonical section.
- Always retain Sickness and Distress. Consolidate prayer requests there. Only record the WM request to the Chaplain and the actual closing prayer when source evidence or officer confirmation establishes them. Do not infer official Grand Lodge visitation from an officer attending as an ordinary member.
- Minutes summarize the treasurer report reading status without financial figures. Distributed or presented does not mean read aloud. Preserve explicit non-reading; otherwise request confirmation. Do not repeat an officer's absence already captured in attendance or add duplicate income, expense or action tables.
- Format meeting and next-meeting dates consistently. Place next-meeting details and closing prayer before the formal closure. The formal closure is the final narrative item, followed only by the application's signature block. Signature-template text is not narrative or proof of approval.
- Use the Lodge seal, remove the separate Masonic header symbol, and keep PDF/Word output based on the shared document model. Preview must reflect edited content. The preparing officer title comes from the actual preparer, not a hard-coded secretary title.

## Record-specific corrections are not global defaults

Opening/closing times, an individual Brother's missed instruction months, and correction of a particular outreach actor apply to the relevant source record only. Never apply a prior meeting's 7:36 PM, 10:30 PM or 10:00 PM to a new meeting. Keep instruction attendance, related months and outreach together, attributed to the actual officer in that record.

## Treasury

- Accept PDF statements, screenshots and typed banking notes; retain the source for officer review. Saving information for later is separate from completing a report. Do not assume Marable or any particular person will prepare it.
- Bank-material upload access and report preparation access are separate. McDuffie and John Brown can provide banking records; Marable's preparation access does not imply bank-account access. WM has full application access.
- Preserve exact cents, explicit reporting dates, account context and transaction direction. Unknown values stay unknown, never zero. Keep transfers distinct from receipts/payments. The application calculates balances and reconciliation; the model cannot invent totals, evidence or confirmations.
- Treasury retains its own preparation/signing workflow without a WM review stage. That exception does not remove WM review from minutes.

## Workflow, costs and presentation

- Minutes: preparer reviews and attests, WM reviews and may revise, revisions remain outlined against the submitted snapshot, then WM attests before distribution readiness. Never apply a signature, claim approval or send a document merely because generation finished. Preserve signatures and original submissions when editing an awaiting-review draft. Retain controlled draft deletion.
- The Worshipful Master's completed review and signature immediately publishes the signed PDF inside Meeting Minutes for every officer with finalized-minutes access. No secretary upload or distribution marker is required for this internal availability. The published PDF must use the captured preparer and Worshipful Master attestation snapshots. Unfinished source material and drafts remain visible only to their preparer and the Worshipful Master. Recording distribution to the Craft remains a separate action.
- Do not print an Attestation and Distribution narrative section in meeting minutes. Do not print statements about authorized distribution, pending Lodge approval, retained corrections or retained signed submissions. Keep only the preparing officer and Worshipful Master signature blocks. Treasurer reports likewise use a Preparing Officer signature block without an attestation narrative heading.
- Both clients share records and capabilities. Mac pages use native navigation and layout without duplicate website menus. Website supports phone, iPad and computer. Historical minutes and treasurer reports open inside the active client, with Close, Back, Done or All reports returning to the archive list. Verify margins and actual rendered output whenever layout changes.
- Keep 90-day sign-in and its notice, WM officer access/activity controls, and separate permissions enforced in application code. Do not infer exact working time from a login duration.
- Current approved paid generation uses GPT-5.6 Terra with the application's $5 monthly limit and protected server-side credentials. Saving source material, editing, previewing and downloading do not trigger generation charges. Keep atomic reservations, caching, no silent paid retries and provider-error reporting. This supersedes the earlier no-API preference only within the approved configuration.
- Future corrections belong in this rulebook plus the affected executable instructions/validation and regression tests. Do not rely on chat memory alone. Tests cannot prove arbitrary generated prose is correct; officer source review remains required.

## Enforcement map

| Concern | Shared implementation | Regression coverage |
| --- | --- | --- |
| Generation rules and evidence | report-rules.js, minutes.js, treasury-ai.js | minutes-ai, treasury-ai |
| Canonical sections and retained details | minutes-organizer.js, minutes-format.js | minutes-local, minutes-format |
| Dates, preview and signatures | public/minutes-dates.js, minutes-pdf.js, minutes-document.js, minutes-changes.js | minutes-format, minutes-changes, e2e |
| Treasury evidence and arithmetic | treasury-source.js, treasury.js, treasury-routes.js | treasury-source, treasury-ai, treasury-e2e |
| Paid generation and authorization | ai-generation.js, server.js | ai-generation, generation-routes, e2e |

## General Report Generator assistance

Officer, committee, event and formal reports can organize pasted notes into the selected report fields. This uses the same authenticated Terra integration and shared $5 monthly limit. Preserve original notes and existing entries; show suggestions and source evidence before the user applies them. Never change identity, signatures, review confirmations or send a report during organization. Invalidate the old preview and signature confirmation when suggestions are applied. Keep report calculations in the existing renderer, preserve payer-attributed budgets and proposals versus decisions, and leave unknowns for review. The public generator opens the authenticated Sign assistant; credentials never cross into the public report page.

## Building Requests and Lodge Calendar

- Building Requests uses the existing reservation service. WM and Xavier may approve or decline after an explicit confirmation. Jamal, the Secretary and Assistant Secretary may view requests. Opening or refreshing a request never decides it or sends a notification. Stale decisions require a fresh review.
- Lodge Calendar is available to Lodge officers. WM can create, edit and remove Lodge calendar events. Building source entries remain read only here and retain pending status where applicable. These permissions remain visible in Officer Access.
- Merge the building calendar with dated Lodge and jurisdiction events. Calendar-only events do not reserve the building or alter reservation availability. Preserve inclusive multi-day dates, Eastern time and unknown times. Show a warning if a source cannot be loaded.
- Use the finalized trestleboard and verified event notices. Do not invent dates for TBD or week-only items, or turn a date-only entry into a claimed all-day duration. Keep source details and distinguish tentative events.

- Officers can request Lodge building use inside the web and native Mac dashboards through the separate building.request permission. This does not grant access to other requests or approval authority. The form submits for Stone Square Lodge No. 22 using the signed-in officer's name and email. Include up to twelve dates, individual start/end times, selected spaces, optional phone and event details. Preserve the established portal's known-conflict checks and require explicit acknowledgment of incomplete availability. Submission stays pending and uses the existing notification workflow only after deliberate confirmation. Preserve a submission identifier across retries to retrieve the saved reference without duplicate requests or notices.
