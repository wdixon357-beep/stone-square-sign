// Lodge report generator. The public path can create only a non-officer report.
// The officer path requires a short-lived assertion signed by Stone Square Sign;
// it never trusts identity, office, permission or signature claims from the form.
// POST ?preview=1 renders the PDF and stores nothing. POST sends
// the PDF to the Worshipful Master and the Secretary's office and keeps a row.
// POST ?copy=1 sends the reviewed final report only to the Worshipful Master.
// Preview requests never email and do not require the final review or signature.
// Public requests are rate limited so the link cannot be used to flood the Lodge inbox.
import nodemailer from "nodemailer";
import { copyKey, deliverCopy } from "./_report-copy.js";
import { REVIEW_STATEMENT, validateReview } from "./_report-review.js";
import { creds } from "./_accounts.js";
import { OFFICERS, letterheadHtml } from "./_letterhead.js";
import { TYPES, reportType, isMaster, validate, buildReport, todayLong } from "./_report-body.js";
import { htmlToPdf } from "./_pdf.js";
import { reportAssertionFromRequest } from "./_report-auth.js";
import { deliverDashboardReport } from "./_report-dashboard-delivery.js";
import { ownerReportSignature } from "./_report-owner-signature.js";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(cmd) {
  if (!KV_URL || !KV_TOKEN) { console.error("[report] KV not configured, row not stored"); return null; }
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  return r.json();
}
const WM = "brodixonsaunders@stonesquare22pha.org";
// The Secretary's office: the shared inbox plus both men, never one without the others.
const SECRETARY_OFFICE = ["secretary@stonesquare22pha.org", "mcduff8995@gmail.com", "reeseadrian66@gmail.com"];

function passLevel(body) {
  const key = process.env.REPORT_POST_KEY;
  const given = String((body || {}).passcode || "");
  if (key && given === key) return "key"; // test and dictation channel: mails the WM only
  return "public";
}
// ponytail: fixed-window counter per address in KV, 40 builds and 20 sends an hour. The whole Lodge shares one address on meeting night, so the room needs headroom; it is still far too few to flood anyone.
async function overLimit(req, what, max) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "unknown";
  const k = `report:rate:${what}:${ip}`;
  try { const r = await redis(["INCR", k]); if (r && r.result === 1) await redis(["EXPIRE", k, 3600]); return !!(r && r.result > max); }
  catch (e) { return false; }
}

async function send(to, subject, text, attachment, preserveUncertain = false) {
  const c = creds("lodge");
  if (!c) { console.error("[report] PASS_LODGE unset"); return false; }
  try {
    const isGmail = c.smtpHost.includes("gmail");
    const t = nodemailer.createTransport({ host: c.smtpHost, port: isGmail ? 465 : 587, secure: isGmail, auth: { user: c.email, pass: c.pass } });
    const info = await t.sendMail({ from: `Stone Square Lodge No. 22 <${c.email}>`, to, subject, text, attachments: [attachment] });
    console.log("[report] sent", subject, "to", to, "id", info && info.messageId);
    return true;
  } catch (e) {
    console.error("[report] mail FAILED", String(e && e.message || e).slice(0, 300));
    if (preserveUncertain && !["EAUTH", "EENVELOPE"].includes(e.code)) throw e;
    return false;
  }
}

const newId = () => "RPT-" + Math.random().toString(16).slice(2, 6).toUpperCase();
const UNIQUE_OFFICE_BY_ROLE = Object.freeze({
  owner: "Worshipful Master",
  secretary: "Secretary",
  assistant_secretary: "Assistant Secretary",
  treasurer: "Treasurer",
  assistant_treasurer: "Assistant Treasurer",
});
function resolveOfficer(principal) {
  const uniqueOffice = UNIQUE_OFFICE_BY_ROLE[principal.role];
  if (uniqueOffice) return OFFICERS.find(([office]) => office === uniqueOffice) || null;
  // A shared role such as warden or officer cannot choose a seat. Those users
  // must carry the exact canonical roster name in their trusted assertion.
  return OFFICERS.find(([, name]) => name === principal.name) || null;
}
const comparableName = value => String(value || "").normalize("NFKD").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
  .filter(part => part.length > 1 && !["bro", "brother", "pm", "hpm"].includes(part)).join(" ");

export default async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Cache-Control", "private, no-store");
  const assertion = reportAssertionFromRequest(req);
  const assertionSupplied = !!String(req?.headers?.authorization || req?.headers?.Authorization || "");
  if (assertionSupplied && !assertion.ok) return res.status(401).json({ error: "unauthorized" });
  let principal = null;
  let rosterOfficer = null;
  if (assertion.ok) {
    if (!assertion.principal.permissions.includes("reports.create")) return res.status(403).json({ error: "forbidden" });
    rosterOfficer = resolveOfficer(assertion.principal);
    if (!rosterOfficer) return res.status(403).json({ error: "officer_not_found" });
    principal = { ...assertion.principal, name: rosterOfficer[1] };
  }
  if (req.method === "GET") {
    if (q.schema !== undefined) {
      const publicTypes = Object.fromEntries(Object.entries(TYPES).filter(([type]) => type !== "officer"));
      return res.status(200).json({ authenticated: !!principal,
        identity: principal ? { office: rosterOfficer[0], name: principal.name, email: principal.email, role: principal.role } : null,
        officers: principal ? [{ office: rosterOfficer[0], name: principal.name }] : [],
        types: principal ? TYPES : publicTypes, reviewStatement: REVIEW_STATEMENT,
        masterTypes: principal ? Object.fromEntries(Object.keys(TYPES).map(type => [type, reportType(type, { office: "Worshipful Master" })])) : publicTypes,
        today: todayLong() });
    }
    return res.status(404).json({ error: "not_found" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const b = req.body || {};
  const requestedType = String(b.type || "");
  const unauthenticatedOfficerAttempt = !principal && (b.isOfficer === true || requestedType === "officer" || String(b.office || "").trim() || String(b.signatureName || "").trim());
  if (unauthenticatedOfficerAttempt) return res.status(401).json({ error: "officer_authentication_required" });
  const level = principal ? "officer" : passLevel(b);
  if (level !== "key" && await overLimit(req, q.preview !== undefined ? "build" : "send", q.preview !== undefined ? 40 : 20)) return res.status(429).json({ error: "slow_down" });

  const type = requestedType;
  const publicName = String(b.name || "").trim().slice(0, 80);
  if (!principal && (OFFICERS.some(([, name]) => comparableName(name) === comparableName(publicName))
    || comparableName(publicName) === comparableName("William Dixon-Saunders"))) return res.status(403).json({ error: "officer_identity_requires_authentication" });
  const who = principal
    ? { isOfficer: true, office: rosterOfficer[0], name: principal.name, email: principal.email, phone: String(b.phone || "").trim() }
    : { isOfficer: false, office: "", name: publicName, email: String(b.email || "").trim().slice(0, 160), phone: String(b.phone || "").trim() };
  const requestedSignature = String(b.signatureName || "").trim();
  if (principal && requestedSignature && requestedSignature !== principal.name) {
    return res.status(400).json({ error: "invalid", problems: [{ field: "signatureName", message: "Sign with the name on your officer account." }] });
  }
  who.signatureName = principal ? principal.name : "";
  const fields = {};
  for (const [k, v] of Object.entries(b.fields || {})) if (/^[a-zA-Z]{1,20}$/.test(k)) fields[k] = String(v == null ? "" : v).slice(0, 20000); // validate() refuses anything over 6,000 with a message
  const preview = q.preview !== undefined;
  const reviewProblems = preview
    ? []
    : principal ? validateReview({ reviewed: b.reviewed, signatureName: who.signatureName })
      : b.reviewed === true ? [] : [{ field: "reviewed", message: "Review your report and check the confirmation box before continuing." }];
  const problems = [...validate(type, fields, who), ...reviewProblems];
  if (principal && q.copy !== undefined && String(fields.title || "").length > 240) {
    problems.push({ field: "title", message: "Keep the report title to 240 characters or fewer." });
  }
  if (problems.length) return res.status(400).json({ error: "invalid", problems });

  let signatureImage;
  try {
    signatureImage = await ownerReportSignature({ principal,
      assertion: String(req.headers.authorization || req.headers.Authorization || "").replace(/^Bearer /, "") });
  } catch (error) {
    return res.status(error.statusCode || 409).json({ error: error.message, code: error.code });
  }
  const r = buildReport(type, fields, who);
  const html = letterheadHtml({ header: r.header, subheader: r.subheader, date: todayLong(), to: r.to, salutation: r.salutation, bodyHtml: r.bodyHtml, signer: { name: who.name, office: who.office, phone: who.phone, signatureName: who.signatureName, signatureImage } });
  let out;
  try { out = await htmlToPdf(html); }
  catch (e) { console.error("[report] render failed", String(e && e.message || e).slice(0, 400)); return res.status(500).json({ error: "render_failed" }); }

  if (q.preview !== undefined) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${r.filename}"`);
    res.setHeader("X-Pages", String(out.pages));
    return res.status(200).send(out.pdf);
  }

  if (q.copy !== undefined) {
    const clientId = /^[a-z0-9-]{8,64}$/i.test(String(b.clientId || "")) ? String(b.clientId) : "";
    if (!clientId) return res.status(400).json({ error: "invalid", problems: [{ field: "title", message: "Refresh the page and try again." }] });
    if (principal) {
      const delivery = await deliverDashboardReport({
        assertion: String(req.headers.authorization || req.headers.Authorization).replace(/^Bearer /, ""),
        clientId, type, fields, phone: who.phone, title: fields.title || TYPES[type].name,
        filename: r.filename, pdf: out.pdf.toString("base64"), pages: out.pages,
        deliveryIntent: b.deliveryIntent,
      });
      return res.status(delivery.status).json(delivery.body);
    }
    const key = copyKey({ clientId, type, who, fields, date: todayLong() });
    const delivery = await deliverCopy({ redis, key, send: id => send(WM, r.subject,
`${TYPES[type].name} from ${r.subheader}, prepared ${todayLong()}.

Title: ${fields.title || ""}
Report contact: ${who.email}
Reference: ${id}

${isMaster(who) ? "You chose to send this final report to the Craft. Your signed copy is attached on the Lodge letterhead for your records. This email does not record Lodge approval." : principal ? "The Brother reviewed, signed and chose to send this final report. Your copy is attached on the Lodge letterhead. This email is a copy for your review, not a record of Lodge approval." : "The submitter reviewed and chose to send this final report. Your copy is attached on the Lodge letterhead. This email is a copy for your review, not a record of Lodge approval."}`,
      { filename: r.filename, content: out.pdf, contentType: "application/pdf" }, true) });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, ...delivery, pages: out.pages, filename: r.filename, pdf: out.pdf.toString("base64") });
  }

  // A retry after a dropped connection must not send the same report twice.
  const clientId = /^[a-z0-9-]{8,64}$/i.test(String(b.clientId || "")) ? String(b.clientId) : "";
  if (clientId) {
    try { const cur = await redis(["GET", "reports:all"]); const dup = (cur && cur.result ? JSON.parse(cur.result) : []).find(x => x.clientId === clientId);
      if (dup) return res.status(200).json({ ok: true, id: dup.id, mailed: dup.mailed, pages: out.pages, filename: r.filename, pdf: out.pdf.toString("base64"), repeat: true }); } catch (e) {}
  }
  const id = newId();
  const recipients = level === "key" ? [WM] : level === "officer" ? [WM, ...SECRETARY_OFFICE, who.email] : [WM, who.email];
  const text =
`${TYPES[type].name} from ${r.subheader}, submitted ${todayLong()}.

Title: ${fields.title || ""}
Reference: ${id}

The report is attached as a PDF on the Lodge letterhead. Sent from the Lodge Report Generator page at request.stonesquare22pha.org/report.`;
  const mailed = await send(recipients.join(", "), r.subject, text, { filename: r.filename, content: out.pdf, contentType: "application/pdf" });

  try {
    const cur = await redis(["GET", "reports:all"]);
    const all = cur && cur.result ? JSON.parse(cur.result) : [];
    all.unshift({ id, clientId, type, office: who.office, name: who.name, email: who.email, phone: who.phone, reviewed: true, signatureName: who.signatureName, title: fields.title || "", pages: out.pages, createdAt: new Date().toISOString(), recipients, mailed, channel: level });
    await redis(["SET", "reports:all", JSON.stringify(all.slice(0, 500))]);
  } catch (e) { console.error("[report] store failed", String(e && e.message || e).slice(0, 200)); }

  return res.status(200).json({ ok: true, id, mailed, pages: out.pages, filename: r.filename, pdf: out.pdf.toString("base64") });
}
