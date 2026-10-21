// Availability feed for 208 East Lake Street.
// Source of truth for the STANDING house meetings is this file (authoritative &
// correct), plus one-off lodge events, plus APPROVED building reservations
// (the configured building store), plus extra events on the clean secretary@ Google Calendar.
// Public GET → busy blocks so the request form greys out taken times and the
// dashboard shows what's on the books. Never exposes anything personal.
import ical from "node-ical";
import { buildingCommand, hasBuildingStore, buildingStoreBackend } from './_building-store.js';
import { readConnectedCalendar, connectedCalendarWarning, connectedCalendarBlocks } from './connected-calendar.js';

const ICS_URL = process.env.GCAL_ICS_URL || "";
const TZ = "America/New_York";

// ── Standing meetings of the houses that meet at 208 E Lake St ──
// dow: 0=Sun..6=Sat ; weeks: which occurrence(s) in the month (1..5) ; months: 1..12 (optional)
const STANDING = [
  { label: "Mt. Zion Chapter No. 7",                       dow: 2, weeks: [1],    s: "19:30", e: "21:30" },
  { label: "Jephthah Chapter No. 12",                      dow: 3, weeks: [1],    s: "19:30", e: "21:30" },
  { label: "Stone Square Lodge No. 22 — Stated Meeting",   dow: 4, weeks: [1, 3], s: "19:30", e: "21:00", months: [1,2,3,4,5,6,9,10,11,12] },
  { label: "Hannibal Commandery No. 18",                   dow: 4, weeks: [2],    s: "19:30", e: "21:30" },
  { label: "Mina Court No. 142",                           dow: 3, weeks: [3],    s: "19:00", e: "21:00" },
  { label: "Mina Temple No. 68",                            dow: 4, weeks: [4],    s: "19:30", e: "21:30" },
];
// ── One-off / dated lodge events to block ──
const ONEOFF = [
  { date: "2026-07-12", s: "17:00", e: "19:00", label: "Entered Apprentice Meeting · SD Cliff Skinner" },
  { date: "2026-07-19", s: "17:00", e: "19:00", label: "Entered Apprentice Meeting · SD Cliff Skinner" },
  { date: "2026-07-26", s: "17:00", e: "19:00", label: "Entered Apprentice Meeting · SD Cliff Skinner" },
  { date: "2026-07-19", s: "11:00", e: "17:00", label: "Annual Fish Fry · MOT Camp Community Day" },
];

function standingBlocks(fromStr, toStr) {
  const out = [];
  const start = new Date(fromStr + "T12:00:00Z"), end = new Date(toStr + "T12:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate(), dow = d.getUTCDay();
    const nth = Math.floor((day - 1) / 7) + 1;
    const ds = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    for (const r of STANDING) {
      if (r.dow === dow && r.weeks.includes(nth) && (!r.months || r.months.includes(mo)))
        out.push({ date: ds, start: r.s, end: r.e, allDay: false, label: r.label, source: "gcal", status: "approved" });
    }
  }
  for (const o of ONEOFF) if (o.date >= fromStr && o.date <= toStr)
    out.push({ date: o.date, start: o.s, end: o.e, allDay: false, label: o.label, source: "gcal", status: "approved" });
  return out;
}

async function loadReservations() {
  try {
    if (!hasBuildingStore()) return { records: [], connected: false };
    const j = await buildingCommand(["GET", "resv:all"]);
    const records = j.result ? JSON.parse(j.result) : [];
    if (!Array.isArray(records)) throw new Error("Invalid records");
    return { records, connected: true };
  } catch (e) { return { records: [], connected: false }; }
}

const localDate = d => d.toLocaleDateString("en-CA", { timeZone: TZ });
const localTime = d => d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

const FEED_NAME = "Stone Square Lodge No. 22 Building Calendar";
const LOCATION = "208 East Lake Street, Middletown, DE 19709";
const icsText = value => String(value ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = line => {
  const out = [];
  for (let i = 0; i < line.length; i += 74) out.push((i ? " " : "") + line.slice(i, i + 74));
  return out.join("\r\n");
};
const dateStamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const localStamp = (date, time) => `${date.replace(/-/g, "")}T${String(time || "00:00").replace(":", "")}00`;
const uidPart = value => String(value || "event").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
function calendarEvent({ uid, date, start, end, label }) {
  return ["BEGIN:VEVENT", `UID:${icsText(uid)}`, `DTSTAMP:${dateStamp()}`,
    `DTSTART;TZID=${TZ}:${localStamp(date, start)}`, `DTEND;TZID=${TZ}:${localStamp(date, end)}`,
    `SUMMARY:${icsText(label)}`, `LOCATION:${icsText(LOCATION)}`, "END:VEVENT"].map(fold).join("\r\n");
}
function calendarFeed(blocks) {
  const header = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Stone Square Lodge No. 22//Building Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(FEED_NAME)}`, `X-WR-TIMEZONE:${TZ}`, "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"].map(fold);
  return [...header, ...blocks.map(calendarEvent), "END:VCALENDAR"].join("\r\n") + "\r\n";
}

// Extra events from the clean secretary@ building calendar (no personal data there).
async function loadGcal(fromDate, toDate) {
  const feed = await readConnectedCalendar({ url: ICS_URL, parseICS: text => ical.parseICS(text) });
  if (!feed.connected) return { events: [], connected: false, reason: feed.reason };
  const result = connectedCalendarBlocks(feed.data, { from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), expandEvent: ical.expandRecurringEvent });
  return { events: result.events, connected: result.complete, reason: result.complete ? 'connected' : 'partial_data' };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const q = req.query || {};
  const today = new Date();
  const subscription = q.format === "ics";
  const fromDate = subscription ? new Date(today.getTime() - 30 * 86400000) : q.from ? new Date(q.from + "T00:00:00Z") : new Date(today.getTime() - 86400000);
  const toDate = subscription ? new Date(today.getTime() + 730 * 86400000) : q.to ? new Date(q.to + "T23:59:59Z") : new Date(today.getTime() + 120 * 86400000);
  const fromStr = q.from || localDate(fromDate), toStr = q.to || localDate(toDate);
  if (!subscription && (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr) || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate.toISOString().slice(0,10)!==fromStr || toDate.toISOString().slice(0,10)!==toStr || toDate<fromDate || toDate-fromDate>371*86400000)) return res.status(400).json({error:'Choose a valid calendar date range.'});

  const [resv, gcal] = await Promise.all([loadReservations(), subscription ? Promise.resolve({ events: [], connected: false }) : loadGcal(fromDate, toDate)]);
  if (!resv.connected && buildingStoreBackend() !== 'redis') {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(503).json({ error: 'Building requests are temporarily unavailable. This calendar cannot confirm availability.' });
  }
  if (subscription) {
    const published = standingBlocks(fromStr, toStr).map(b => ({ ...b, uid: `standing-${b.date}-${b.start}-${uidPart(b.label)}@stonesquare22pha.org` }));
    for (const r of resv.records) if (r.status === "approved" && r.date >= fromStr && r.date <= toStr) published.push({
      uid: `reservation-${r.id}@stonesquare22pha.org`, date: r.date, start: r.start, end: r.end,
      label: `${r.org || "Reserved"}${Array.isArray(r.spaces) && r.spaces.length ? `, ${r.spaces.join(", ")}` : ""}`,
    });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="stone-square-building.ics"');
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).send(calendarFeed(published));
  }
  const busy = [];
  for (const r of resv.records) {
    if (!r.date || r.date < fromStr || r.date > toStr || r.status === "denied") continue;
    busy.push({ date: r.date, start: r.start || "", end: r.end || "", allDay: false,
      label: r.org || "Reserved", source: "reservation", status: r.status });
  }
  for (const b of standingBlocks(fromStr, toStr)) busy.push(b);
  for (const e of gcal.events) { if (e.date >= fromStr && e.date <= toStr) busy.push(e); }
  busy.sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  return res.status(200).json({ busy, gcalConnected: gcal.connected, calendarFeedStatus: gcal.reason, warning: [!resv.connected && "Building requests are temporarily unavailable. This calendar does not confirm that the building is free.", !gcal.connected && connectedCalendarWarning(gcal.reason)].filter(Boolean).join(" ") || null, from: fromStr, to: toStr });
}
