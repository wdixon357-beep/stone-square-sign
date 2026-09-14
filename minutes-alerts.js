const meetingDateLabel = row => {
  const raw = String(row.meeting_date || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00Z`) : null;
  return date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw
    ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'meeting date not yet confirmed';
};

export const minutesReviewAlert = (row) => {
  const label = meetingDateLabel(row);
  return { id: row.id, title: `Meeting minutes awaiting your review: ${label}`,
    submittedBy: row.created_by_name || 'The preparer', submittedAt: row.submitted_for_review_at,
    message: `Submitted by ${row.created_by_name || 'the preparer'}. Open for review.`,
    kind: 'master_review', url: '/?section=minutes' };
};

export const minutesCompletionAlert = row => {
  const label = meetingDateLabel(row);
  return { id: row.id, title: `Meeting minutes reviewed and signed: ${label}`,
    submittedBy: row.master_attested_by_name || 'WM Dixon-Saunders', submittedAt: row.master_attested_at,
    message: `WM Dixon-Saunders reviewed and signed the minutes you prepared. The signed record is now available to every officer in the Dashboard.`,
    kind: 'preparer_completion', url: '/?section=minutes' };
};
