import { normalizeMinutesDraft } from './minutes.js';
import { attendanceLabel, stationCoverageText } from './public/minutes-attendance.js';

export const minutesChanges = (submitted, reviewed) => {
  const before = normalizeMinutesDraft(submitted), after = normalizeMinutesDraft(reviewed);
  const changes = [];
  const labels = { meetingDate: 'Meeting date', meetingType: 'Meeting type', degree: 'Degree', openingTime: 'Opening time', closingTime: 'Closing time', prayerRequested: 'Prayer requested by the Worshipful Master', closingPrayerGiven: 'Closing prayer for the sick and distressed', presiding: 'Presiding officer', quorum: 'Quorum', nextMeeting: 'Next meeting', present: 'Brothers present', excused: 'Brothers excused', visitors: 'Visitors', officerAttendance: 'Officer attendance' };
  const display = value => typeof value === 'string' ? value : value == null ? ''
    : Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry
      : `${entry.name}, ${entry.title}: ${attendanceLabel(entry)}${entry.stationCoverage || entry.actingName ? `; ${stationCoverageText(entry)}` : ''}`).join('\n') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  for (const field of ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'prayerRequested', 'closingPrayerGiven', 'presiding', 'quorum', 'nextMeeting', 'present', 'excused', 'visitors', 'officerAttendance']) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changes.push({ field: labels[field], before: display(before[field]), after: display(after[field]) });
  }
  // Compare the actual submitted wording, not a presentation-cleaned copy.
  // Group by heading so removing a template section does not make every later
  // section look as though it was replaced by its neighbour.
  const sectionGroups = sections => {
    const groups = new Map();
    for (const [index, section] of (Array.isArray(sections) ? sections : []).entries()) {
      const heading = String(section?.heading || '').trim() || `Section ${index + 1}`;
      const body = String(section?.body || '');
      groups.set(heading, [...(groups.get(heading) || []), body]);
    }
    return groups;
  };
  const originalSections = sectionGroups(submitted.sections), reviewedSections = sectionGroups(after.sections);
  for (const heading of new Set([...originalSections.keys(), ...reviewedSections.keys()])) {
    const previous = originalSections.get(heading), current = reviewedSections.get(heading);
    if (JSON.stringify(previous) !== JSON.stringify(current)) changes.push({ field: heading, before: previous ? `${heading}\n${previous.join('\n')}` : '', after: current ? `${heading}\n${current.join('\n')}` : '' });
  }
  return changes;
};

// Confirmation belongs to the officer who recorded attendance. A Master's
// correction never becomes a new confirmation attributed to that preparer.
// Submitted snapshots remain immutable; only unchanged groups retain their
// existing confirmation in the working copy.
const attendanceRowsForComparison = draft => JSON.stringify((Array.isArray(draft?.officerAttendance) ? draft.officerAttendance : []).map(row => JSON.stringify({
  name: String(row?.name || '').trim(), title: String(row?.title || '').trim(),
  status: row?.status || 'not_recorded', stationCoverage: row?.stationCoverage || null,
  actingName: String(row?.actingName || '').trim() || null,
  actingRole: String(row?.actingRole || '').trim() || null,
  actingWholeMeeting: typeof row?.actingWholeMeeting === 'boolean' ? row.actingWholeMeeting : null,
})).sort());
const attendanceNamesForComparison = (draft, key) => JSON.stringify((Array.isArray(draft?.[key]) ? draft[key] : [])
  .map(name => String(name).trim()).filter(Boolean).sort());
export const preparerAttendanceReviewForEdit = (recorded, edited) => ({
  officerRoll: recorded?.attendanceReview?.officerRoll === true
    && attendanceRowsForComparison(recorded) === attendanceRowsForComparison(edited)
    && (Number(recorded?.officerAttendanceVersion) >= 2 ? 2 : 1) === (Number(edited?.officerAttendanceVersion) >= 2 ? 2 : 1),
  otherPresent: recorded?.attendanceReview?.otherPresent === true
    && attendanceNamesForComparison(recorded, 'present') === attendanceNamesForComparison(edited, 'present'),
  otherExcused: recorded?.attendanceReview?.otherExcused === true
    && attendanceNamesForComparison(recorded, 'excused') === attendanceNamesForComparison(edited, 'excused'),
});

// Some legacy reviews predate the submitted snapshot. Retain their recorded
// corrections exactly and append new deltas; a missing baseline never erases
// earlier review history or invents the original submitted wording.
export const reviewedMinutesChanges = (submitted, previous, reviewed, retained = []) => submitted
  ? minutesChanges(submitted, reviewed)
  : [...structuredClone(Array.isArray(retained) ? retained : []), ...minutesChanges(previous, reviewed)];
