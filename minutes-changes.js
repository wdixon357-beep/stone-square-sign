import { normalizeMinutesDraft } from './minutes.js';

export const minutesChanges = (submitted, reviewed) => {
  const before = normalizeMinutesDraft(submitted), after = normalizeMinutesDraft(reviewed);
  const changes = [];
  const labels = { meetingDate: 'Meeting date', meetingType: 'Meeting type', degree: 'Degree', openingTime: 'Opening time', closingTime: 'Closing time', prayerRequested: 'Prayer requested by the Worshipful Master', closingPrayerGiven: 'Closing prayer for the sick and distressed', presiding: 'Presiding officer', quorum: 'Quorum', nextMeeting: 'Next meeting', present: 'Brothers present', excused: 'Brothers excused', visitors: 'Visitors', officerAttendance: 'Officer attendance' };
  const display = value => typeof value === 'string' ? value : value == null ? ''
    : Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry
      : `${entry.name}, ${entry.title}: ${entry.status.replaceAll('_', ' ')}`).join('\n') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
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
