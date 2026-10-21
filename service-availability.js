// Provider quota rejection is a service outage, not a bad sign-in or a reason
// to replay a save. Never expose the connection string or provider error text.
export function databaseQuotaResponse(error) {
  if (error?.code !== '53000' || !/\bquota\b/i.test(String(error.message || ''))) return null;
  return { status: 503, body: {
    error: 'Dashboard storage is temporarily unavailable because its service allowance has been reached. Keep your draft and try again after access is restored.',
    code: 'DATABASE_QUOTA_EXCEEDED', incidentRecorded: false, retryable: false, retryAfterSeconds: 300,
  } };
}
