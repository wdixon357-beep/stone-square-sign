export const minutesReviewAlert = (row) => {
  const raw = String(row.meeting_date || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00Z`) : null;
  const label = date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw
    ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'meeting date not yet confirmed';
  return { id: row.id, title: `Meeting minutes awaiting your review: ${label}`,
    submittedBy: row.created_by_name || 'The preparer', submittedAt: row.submitted_for_review_at,
    url: '/?section=minutes' };
};
