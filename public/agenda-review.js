// Keep the dashboard guidance and the PDF validation on the same rules.
export function agendaContinueIssues(draft = {}) {
  const issues = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.meetingDate)) {
    issues.push({ label: 'Choose the meeting date.', target: 'meetingDate' });
  }
  if (!draft.meetingType) issues.push({ label: 'Enter the meeting type.', target: 'meetingType' });
  if (!draft.startTime) issues.push({ label: 'Enter the meeting start time.', target: 'startTime' });
  const sections = Array.isArray(draft.sections) ? draft.sections : [];
  if (!sections.length) issues.push({ label: 'Add at least one agenda section.', target: 'add-section' });
  sections.forEach((section, index) => {
    if (!section.heading) issues.push({ label: `Add a heading to agenda section ${index + 1}.`, target: `section.${index}.heading` });
  });
  return issues;
}
