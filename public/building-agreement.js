const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const timestamp = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' Eastern Time';
};
const image = signature => /^data:image\/png;base64,[A-Za-z0-9+/=]{1,500000}$/.test(signature?.image || '') ? signature.image : '';

export function buildingAgreementMarkup(record) {
  const authorization = record.authorization ? `<section><h3>Recorded Lodge authorization</h3>${[
    ['date', 'Authorization date'], ['record', 'Minutes or resolution reference'], ['fee', 'Approved fee'],
    ['insurance', 'Insurance'], ['deposit', 'Security deposit'], ['conditions', 'Conditions'],
  ].filter(([key]) => record.authorization[key]).map(([key, label]) => `<p><strong>${label}:</strong> ${escape(record.authorization[key])}</p>`).join('')}</section>` : '';
  return `<div class="building-agreement-record" style="overflow-wrap:anywhere;min-width:0">
    <h3>${record.status === 'fully_executed' ? 'Signed Building Use Agreement Record' : 'Building Use Agreement Record'}</h3>
    <p><strong>${escape(record.organization)}</strong></p><p>Reference: ${escape(record.requestId)} · ${escape(record.eventDate)}</p>
    <p class="helper">${escape(record.explanation)}</p>
    <h3>Original accepted terms</h3><div style="white-space:pre-wrap">${escape(record.originalText)}</div>
    ${authorization}<section><h3>Captured signatures</h3>${(record.signatures || []).map(signature => `<div style="margin:20px 0"><h4>${escape(signature.label)}</h4>${image(signature) ? `<img src="${image(signature)}" alt="Saved handwritten signature of ${escape(signature.name)}" style="display:block;max-width:100%;width:340px;max-height:100px;object-fit:contain;object-position:left center">` : '<p>Saved signature image unavailable.</p>'}<p><strong>${escape(signature.name)}</strong>${signature.title ? `<br>${escape(signature.title)}` : ''}<br>${escape(timestamp(signature.at))}</p></div>`).join('')}</section>
    ${record.status !== 'fully_executed' ? '<p class="helper">This agreement is still awaiting completion. Only signatures already saved are shown.</p>' : ''}
  </div>`;
}

export function attachBuildingAgreement(card, request, { api, isCurrent = () => true }) {
  if (request.statusOnly || !request.agreementText) return;
  const wrapper = document.createElement('div');
  const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
  button.textContent = request.agreementStatus === 'fully_executed' ? 'View signed agreement record' : 'View recorded agreement and signatures';
  button.setAttribute('aria-expanded', 'false');
  const details = document.createElement('div'); details.hidden = true; details.setAttribute('role', 'region'); details.setAttribute('aria-label', 'Recorded Building Use Agreement');
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  wrapper.append(button, message, details); card.append(wrapper);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (details.childElementCount) { details.hidden = !details.hidden; button.setAttribute('aria-expanded', String(!details.hidden)); return; }
    button.disabled = true; message.textContent = 'Opening saved agreement…';
    try {
      const { agreement } = await api(`/api/building/requests/${encodeURIComponent(request.id)}/agreement?revision=${encodeURIComponent(request.revision)}`);
      if (!isCurrent() || !card.isConnected) return;
      if (!agreement || agreement.requestId !== request.id || agreement.revision !== String(request.revision)) throw Error('This request changed. Refresh it before opening the agreement.');
      details.innerHTML = buildingAgreementMarkup(agreement); details.hidden = false; button.setAttribute('aria-expanded', 'true'); message.textContent = '';
    } catch (error) { if (isCurrent() && card.isConnected) message.textContent = error.message || 'The saved agreement could not be opened. Try again.'; }
    finally { button.disabled = false; }
  });
}
