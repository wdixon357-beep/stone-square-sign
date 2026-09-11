export const CURRENT_OFFICERS = [
  { name: 'W. Aaron Dixon-Saunders', title: 'Worshipful Master' },
  { name: 'Xavier M. White', title: 'Senior Warden' },
  { name: 'Jamal R. Sadler', title: 'Junior Warden' },
  { name: 'John B. Brown III, PM', title: 'Treasurer' },
  { name: 'William M. McDuffie', title: 'Secretary' },
  { name: 'David Marable', title: 'Assistant Treasurer' },
  { name: 'Adrian Reese', title: 'Assistant Secretary' },
  { name: 'Clifton Skinner', title: 'Senior Deacon' },
  { name: 'Corey Grubbs', title: 'Junior Deacon' },
  { name: 'Kenneth A. Davis, PM', title: 'Chaplain' },
  { name: 'Karim Fletcher', title: 'Senior Steward' },
  { name: 'David Jackson', title: 'Junior Steward' },
  { name: 'Robert G. Collins, HPM', title: 'Tyler' },
];

const comparableName = (value) => String(value || '')
  .toLowerCase()
  .replace(/\b(brother|bro|worshipful|past master|pm|honorary|hpm)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

const namesMatch = (left, right) => {
  const a = comparableName(left);
  const b = comparableName(right);
  return a && b && (a === b || a.includes(b) || b.includes(a));
};

export const officerAttendanceRows = (draft) => {
  const statedRows = Array.isArray(draft.officerAttendance) ? draft.officerAttendance : [];
  const regularRows = CURRENT_OFFICERS.map((officer) => {
  const stated = (draft.officerAttendance || []).find((entry) => namesMatch(entry.name, officer.name));
    if (stated) return {
      name: stated.name || officer.name,
      title: stated.title || officer.title,
      status: stated.status || 'not_recorded',
    };
  if ((draft.present || []).some((name) => namesMatch(name, officer.name))) return { ...officer, status: 'present' };
  if ((draft.excused || []).some((name) => namesMatch(name, officer.name))) return { ...officer, status: 'excused' };
  return { ...officer, status: 'not_recorded' };
  });
  const additionalRows = statedRows.filter((entry) => (
    entry.name && !CURRENT_OFFICERS.some((officer) => namesMatch(entry.name, officer.name))
  )).map((entry) => ({
    name: entry.name,
    title: entry.title || 'Officer or pro tem',
    status: entry.status || 'not_recorded',
  }));
  return [...regularRows, ...additionalRows];
};

export const additionalPresent = (draft) => (draft.present || []).filter((name) => (
  !CURRENT_OFFICERS.some((officer) => namesMatch(name, officer.name))
));

export const nonOfficerExcused = (draft) => (draft.excused || []).filter((name) => (
  !CURRENT_OFFICERS.some((officer) => namesMatch(name, officer.name))
));

export const statusLabel = (status) => ({
  present: 'Present', absent: 'Absent', excused: 'Excused', not_recorded: 'Not recorded',
}[status] || 'Not recorded');

export const financeRows = (items = []) => items.map((item) => ({
  date: item.date || '',
  reference: item.reference || '',
  party: [item.party, item.description].filter(Boolean).join(', '),
  amount: item.amount || '',
}));
