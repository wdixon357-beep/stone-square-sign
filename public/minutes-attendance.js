// Shared by the minutes editor, attestation gate and document renderers.
// An unknown station assignment is never an assertion that nobody filled it.
export const normalizeOfficerCoverage = (row = {}) => ({
  stationCoverage: ['filled', 'vacant'].includes(row.stationCoverage) ? row.stationCoverage : null,
  actingName: typeof row.actingName === 'string' ? row.actingName.trim() || null : null,
  actingWholeMeeting: typeof row.actingWholeMeeting === 'boolean' ? row.actingWholeMeeting : null,
  ...(typeof row.actingRole === 'string' && row.actingRole.trim() ? {actingRole: row.actingRole.trim()} : {}),
});

export const assistantCoverageRoleForStation = row => {
  switch (String(row?.title || '').trim().toLowerCase()) {
    case 'treasurer': return 'Assistant Treasurer';
    case 'secretary': return 'Assistant Secretary';
    default: return null;
  }
};

export const attendanceLabel = (row) => ({
  present: 'Present', arrived_late: 'Arrived later', absent: 'Absent',
  excused: 'Excused', not_recorded: 'Not recorded',
}[typeof row === 'string' ? row : row?.status] || 'Not recorded');

export function sameAttendancePerson(left, right) {
  const tokens = value => String(value || '').toLowerCase()
    .replace(/\bpast\s+master\b|\b(?:brother|bro|pm|hpm|jr|sr|ii|iii|iv)\b/g, '').match(/[a-z]+/g)?.filter(token => token.length > 1) || [];
  const a = tokens(left), b = tokens(right);
  const officeAlias = value => /^(?:wm|sw|jw|sd|jd|ss|js)\.?\s+[a-z'-]+\.?$/i.test(String(value || '').trim());
  return a.length > 0 && b.length > 0 && (a.join('') === b.join('')
    || a.length >= 2 && b.length >= 2 && a[0] === b[0] && a.at(-1) === b.at(-1)
    || (officeAlias(left) || officeAlias(right)) && a.at(-1) === b.at(-1));
}

export function attendanceCoverageIssues(draft = {}) {
  if (Number(draft.officerAttendanceVersion) < 2 || !draft.officerAttendanceVersion) return [];
  return (Array.isArray(draft.officerAttendance) ? draft.officerAttendance : []).flatMap(row => {
    const {stationCoverage, actingName, actingWholeMeeting, actingRole} = normalizeOfficerCoverage(row);
    const assistants = actingRole ? (draft.officerAttendance || []).filter(assistant => String(assistant.title || '').trim().toLowerCase() === actingRole.toLowerCase()) : [];
    const label = `${row.title || 'Officer'}${row.name ? ` (${row.name})` : ''}`;
    const needsCoverage = ['excused', 'absent', 'arrived_late'].includes(row.status);
    if (!needsCoverage) return stationCoverage || actingName || actingWholeMeeting !== null || actingRole
      ? [`${label}: confirm the regular officer's later arrival or clear the station coverage.`] : [];
    if (!stationCoverage) return [`${label}: record who covered the station, or confirm it was left vacant.`];
    if (stationCoverage === 'vacant') return actingName || actingWholeMeeting !== null || actingRole
      ? [`${label}: clear the covering Brother and duration when the station was left vacant.`] : [];
    return [
      actingRole && actingRole !== assistantCoverageRoleForStation(row)
        && `${label}: select the assistant for this station or clear the assistant role.`,
      actingRole && (assistants.length !== 1 || !sameAttendancePerson(assistants[0].name, actingName))
        && `${label}: the covering name must match the selected assistant.`,
      !actingName && `${label}: enter the Brother who covered the station.`,
      actingName && sameAttendancePerson(actingName, row.name)
        && `${label}: the covering Brother must be someone other than the regular officer.`,
      actingWholeMeeting === null && `${label}: confirm whether the covering Brother served the whole meeting.`,
      actingWholeMeeting === false && row.status !== 'arrived_late'
        && `${label}: a partial assignment requires confirmation that the regular officer arrived.`,
    ].filter(Boolean);
  });
}

export function stationCoverageText(row = {}) {
  const {stationCoverage, actingName, actingWholeMeeting} = normalizeOfficerCoverage(row);
  if (stationCoverage === 'vacant') return row.status === 'arrived_late'
    ? 'Station left vacant until the regular officer arrived.' : 'Station left vacant.';
  if (stationCoverage === 'filled') {
    if (!actingName) return 'Covering Brother not yet recorded.';
    if (row.actingRole && row.actingRole === assistantCoverageRoleForStation(row)) {
      const assistant = `${row.actingRole} ${actingName}`;
      if (actingWholeMeeting === true) return `${assistant} covered the station for the whole meeting.`;
      if (actingWholeMeeting === false && row.status === 'arrived_late') return `${assistant} covered the station until ${row.name || 'the regular officer'} arrived.`;
      return `${assistant} covered the station. Duration not yet confirmed.`;
    }
    if (actingWholeMeeting === true) return `${actingName} served pro tem for the whole meeting.`;
    if (actingWholeMeeting === false && row.status === 'arrived_late') return `${actingName} served pro tem until ${row.name || 'the regular officer'} arrived.`;
    return `${actingName} served pro tem. Duration not yet confirmed.`;
  }
  return ['excused', 'absent', 'arrived_late'].includes(row.status) ? 'Station coverage not yet recorded.' : '';
}
