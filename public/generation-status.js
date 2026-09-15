export function generationStatusText(status, role) {
  if (!status || typeof status.configured !== 'boolean') return 'Generation status unavailable. Refresh before creating a draft.';
  if (role !== 'owner' || status.administratorDetails !== true) return status.configured
    ? 'Report assistance is available. Review suggested entries before saving or signing.'
    : 'Report assistance is temporarily unavailable. You can continue entering your report.';
  let text = status.configured
    ? 'Terra enabled. Creating or reorganizing a draft sends its source text to OpenAI for your review. Saving, previewing and signing do not use Terra.'
    : 'Local organizer active. Terra setup is pending.';
  if (status.configured && Number.isFinite(status.remainingDollars)) text += ` $${status.remainingDollars.toFixed(2)} of the $5.00 estimated monthly allowance remains. Pending requests count toward this limit.`;
  return text;
}
export async function showGenerationStatus(element, api, role) {
  if (!element) return;
  element.textContent = 'Checking generation connection…';
  try { element.textContent = generationStatusText(await api('/api/generation/status'), role); }
  catch { element.textContent = generationStatusText(null, role); }
}
