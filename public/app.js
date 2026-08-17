const CLIENT_BUILD_VERSION = (() => {
  try {
    return new URL(document.currentScript.src).searchParams.get('v') || 'development';
  } catch {
    return 'development';
  }
})();

const state = {
  token: localStorage.getItem('stone-square-sign-token') || '',
  user: null,
  signingDocumentId: null,
  signingPdfObjectUrl: null,
  invitationToken: new URLSearchParams(window.location.search).get('invite') || '',
  invitationUrl: '',
  signatureRequired: false,
  signatureMode: 'drawn',
  selectedTypedStyle: 0,
  profileHasInk: false,
  realtimeAbort: null,
  refreshTimer: null,
  signatureObjectUrl: '',
  pdfObjectUrl: '',
  submissionProfiles: {},
  parsedDispensation: null,
  locationMatch: null,
  dispensationPreviewUrl: '',
  pendingReviewDocument: null,
};

const $ = (id) => document.getElementById(id);
const show = (element) => element.classList.remove('hidden');
const hide = (element) => element.classList.add('hidden');
const authMessage = $('authMessage');
const docMessage = $('docMessage');
const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const setMessage = (element, text, isError = false) => {
  element.textContent = text || '';
  element.classList.toggle('error', isError);
  element.classList.toggle('success', Boolean(text) && !isError);
};

const checkForWebUpdate = async () => {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return;
    const { version } = await response.json();
    $('webUpdateBanner').classList.toggle('hidden', !version || version === CLIENT_BUILD_VERSION);
  } catch {
    // A temporary connection interruption is handled by the live queue indicator.
  }
};

$('applyWebUpdate').addEventListener('click', () => window.location.reload());
window.setTimeout(checkForWebUpdate, 1500);
window.setInterval(checkForWebUpdate, 30000);

const apiFetch = async (path, init = {}) => {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
};

const setActiveTab = (which) => {
  const mapping = {
    login: ['showLogin', 'loginForm'],
    register: ['showRegister', 'registerForm'],
    reset: ['showReset', 'forgotForm'],
  };
  Object.values(mapping).forEach(([buttonId, formId]) => {
    $(buttonId).classList.remove('active');
    hide($(formId));
  });
  $(mapping[which][0]).classList.add('active');
  show($(mapping[which][1]));
  setMessage(authMessage, '');
};

const roleLabel = (role) => ({
  owner: 'Worshipful Master / Administrator',
  secretary: 'Secretary',
  assistant_secretary: 'Assistant Secretary',
  viewer: 'Lodge Viewer',
}[role] || 'Signer');

const initials = (name) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const formatDate = (date) => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(date));

const formatClockTime = (value) => {
  const [hour, minute] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return value || '';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
    .format(new Date(2000, 0, 1, hour, minute));
};

const easternGreeting = () => {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York',
  }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

const enterWorkspace = async (user) => {
  state.user = user;
  $('whoami').textContent = user.name;
  $('userRole').textContent = roleLabel(user.role);
  $('userInitials').textContent = initials(user.name);
  $('builderMasterName').textContent = user.name;
  $('landingGreeting').textContent = `${easternGreeting()}, ${user.name}`;
  $('landingRole').textContent = roleLabel(user.role);
  document.querySelectorAll('.owner-only').forEach((element) => {
    element.classList.toggle('hidden', user.role !== 'owner');
  });
  /* Dues names the men who are behind, so a viewer is not shown the tile at all.
   * The server refuses him regardless; this avoids dangling a locked door. */
  const maySeeDues = ['owner', 'secretary', 'assistant_secretary'].includes(user.role);
  document.querySelectorAll('.dues-only').forEach((element) => {
    element.classList.toggle('hidden', !maySeeDues);
  });
  showWorkspaceSection('home');
  hide($('authCard'));
  show($('appCard'));
  const [documents] = await Promise.all([
    renderDocuments(),
    user.role === 'owner' ? renderOfficers() : Promise.resolve(),
    user.role === 'owner' ? loadSubmissionProfiles() : Promise.resolve(),
  ]);
  if (user.hasSignature || user.role === 'viewer') showPendingSignatureNotice(user, documents || []);
  startRealtime();
  if (!user.hasSignature && user.role !== 'viewer') window.setTimeout(() => openSignatureSetup(true), 150);
};

const applySubmissionProfiles = () => {
  const owner = state.submissionProfiles.worshipful_master;
  $('dispMasterAddress').value = owner?.address || '';
  $('confirmSubmissionProfiles').checked = false;
  $('submissionProfilePrompt').textContent = owner
    ? `Yes, use ${owner.address} as my Worshipful Master address for this submission.`
    : 'Yes, use this Worshipful Master address for this submission.';
};

const fillFormFromParsedDispensation = () => {
  const fields = state.parsedDispensation?.fields;
  if (!fields) return;
  $('dispTitle').value = fields.title;
  $('dispRequestDate').value = fields.requestDate || builderTodayValue;
  $('dispSignerRole').value = fields.signerRole === 'assistant_secretary' ? 'assistant_secretary' : 'both';
  $('dispRequestDetails').value = fields.requestDetails;
  $('dispEventDate').value = fields.eventDate;
  $('dispEventTime').value = fields.eventTime;
  $('dispLocationName').value = fields.locationName;
  $('dispStreet').value = fields.streetAddress;
  $('dispCityState').value = fields.cityState;
  applySubmissionProfiles();
  if (fields.worshipfulMasterAddress) $('dispMasterAddress').value = fields.worshipfulMasterAddress;
  $('confirmSubmissionProfiles').checked = false;
  const parsedFields = [
    'dispTitle', 'dispRequestDate', 'dispRequestDetails', 'dispEventDate',
    'dispEventTime', 'dispLocationName', 'dispStreet', 'dispCityState',
  ];
  parsedFields.forEach((id) => {
    const input = $(id);
    input.closest('.parsed-covered')?.classList.toggle('hidden', Boolean(input.value.trim()));
  });
  $('remainingQuestionsIntro').classList.remove('hidden');
  const missing = [
    ['dispRequestDetails', 'request details'], ['dispEventDate', 'event date'],
    ['dispEventTime', 'event time'], ['dispLocationName', 'location name'],
    ['dispStreet', 'street and number'], ['dispCityState', 'city, state, and ZIP'],
  ].filter(([id]) => !$(id).value.trim()).map(([, label]) => label);
  setMessage(
    $('builderMessage'),
    missing.length
      ? `Complete the missing required fields before review: ${missing.join(', ')}.`
      : 'The pasted details are ready. Complete the remaining Lodge questions.',
    missing.length > 0,
  );
  hide($('pasteReviewModal'));
};

const loadSubmissionProfiles = async () => {
  const { profiles } = await apiFetch('/api/submission-profiles');
  state.submissionProfiles = Object.fromEntries(profiles.map((profile) => [profile.role, profile]));
  applySubmissionProfiles();
};

const showWorkspaceSection = (section) => {
  const home = section === 'home';
  const builder = section === 'builder';
  const queue = section === 'queue';
  const dues = section === 'dues';
  const approvals = section === 'approvals';
  $('landingSection').classList.toggle('hidden', !home);
  $('queueSection').classList.toggle('hidden', !queue);
  $('builderSection').classList.toggle('hidden', !builder);
  $('duesSection').classList.toggle('hidden', !dues);
  $('approvalsSection').classList.toggle('hidden', !approvals);
  $('homeNav').classList.toggle('active', home);
  $('queueNav').classList.toggle('active', queue);
  $('builderNav').classList.toggle('active', builder);
  $('duesNav').classList.toggle('active', dues);
  $('approvalsNav').classList.toggle('active', approvals);
  if (dues) renderDues();
  if (approvals) renderApprovals();
  /* Zeffy payments arrive from outside the app, so no in-app event can announce
   * them. While the dues page is the one on screen, re-read it on a timer so two
   * officers looking at once see the same figures. */
  window.clearInterval(state.duesTimer);
  if (dues) state.duesTimer = window.setInterval(() => renderDues(true), 60000);
};

/* What the District Deputy decided, and the proof of it.
 *
 * Both dispensations the Lodge holds as approved have nothing written in the approval block on
 * the form itself: no tick, no date, no signature. Both were granted by email. So this shows how
 * the decision arrived rather than pretending the instrument carries it, and says plainly when no
 * endorsed copy exists. */
const APPROVAL_WORDS = {
  approved: 'Approved', disapproved: 'Not approved', withdrawn: 'Withdrawn', pending: 'Awaiting a decision',
};
const APPROVAL_ROUTE = {
  endorsed_pdf: 'endorsed copy returned', email: 'given by email', verbal: 'given verbally',
};

const renderApprovals = async () => {
  const message = $('approvalsMessage');
  const list = $('approvalsList');
  try {
    const { approvals = [] } = await apiFetch('/api/approvals');
    list.innerHTML = '';
    if (!approvals.length) {
      setMessage(message, 'No dispensation has been recorded as decided yet.');
      return;
    }
    setMessage(message, '');
    approvals.forEach((item) => {
      const row = window.document.createElement('article');
      row.className = 'doc-row';
      const decided = APPROVAL_WORDS[item.approval_status] || item.approval_status;
      const route = APPROVAL_ROUTE[item.approval_source] || item.approval_source || '';
      row.innerHTML = `
        <div class="queue-number">${item.approval_status === 'approved' ? '\u2713' : '\u2022'}</div>
        <div class="doc-icon">PDF</div>
        <div class="doc-main"><h3></h3><p></p></div>
        <span class="status ${item.approval_status === 'approved' ? 'completed' : 'rescinded'}">${decided}</span>
        <div class="doc-actions"></div>`;
      row.querySelector('h3').textContent = item.title || item.original_name;
      row.querySelector('.doc-main p').textContent =
        `${item.approved_by || 'Not recorded'} · ${formatDate(item.approved_on)} · ${route}`;
      if (!item.has_endorsed_copy) {
        const warn = window.document.createElement('p');
        warn.className = 'queue-submission queue-submission-warn';
        warn.textContent = 'No endorsed copy on file. The approval block on the form is blank.';
        row.querySelector('.doc-main').appendChild(warn);
      }
      const actions = row.querySelector('.doc-actions');
      const open = window.document.createElement('button');
      open.className = 'text-button';
      open.textContent = 'View PDF';
      open.addEventListener('click', () => openPdf(item.id, item.original_name));
      actions.appendChild(open);
      if (item.has_endorsed_copy) {
        const endorsed = window.document.createElement('button');
        endorsed.className = 'secondary compact';
        endorsed.textContent = 'View endorsed copy';
        endorsed.addEventListener('click', async () => {
          try {
            const blob = await apiFetch(`/api/documents/${item.id}/endorsed`);
            window.open(URL.createObjectURL(blob), '_blank');
          } catch (error) {
            setMessage(message, error.message, true);
          }
        });
        actions.appendChild(endorsed);
      }
      if (state.user?.role === 'viewer') actions.replaceChildren();
      list.appendChild(row);
    });
  } catch (error) {
    setMessage(message, error.message, true);
  }
};

$('approvalsNav').addEventListener('click', () => showWorkspaceSection('approvals'));
$('approvalsRefresh').addEventListener('click', () => renderApprovals());
$('homeNav').addEventListener('click', () => showWorkspaceSection('home'));
$('queueNav').addEventListener('click', () => showWorkspaceSection('queue'));
$('builderNav').addEventListener('click', () => showWorkspaceSection('builder'));
$('dispensationsMenuCard').addEventListener('click', () => showWorkspaceSection('queue'));
$('duesNav').addEventListener('click', () => showWorkspaceSection('dues'));
$('duesMenuCard').addEventListener('click', () => showWorkspaceSection('dues'));
$('duesRefresh').addEventListener('click', () => renderDues(true));

const scheduleQueueRefresh = () => {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(async () => {
    await renderDocuments();
    if (state.user?.role === 'owner') await renderOfficers();
  }, 180);
};

const setLiveState = (connected) => {
  $('liveStatus').classList.toggle('connected', connected);
  $('liveStatus').lastChild.textContent = connected ? ' Live queue connected' : ' Reconnecting live queue';
};

const startRealtime = async () => {
  state.realtimeAbort?.abort();
  const controller = new AbortController();
  state.realtimeAbort = controller;
  while (state.token && !controller.signal.aborted) {
    try {
      const response = await fetch('/api/events', {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('Live connection unavailable.');
      setLiveState(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        events.forEach((event) => {
          if (event.includes('event: queue_changed') || event.includes('event: profile_changed')) {
            scheduleQueueRefresh();
          }
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setLiveState(false);
    }
    await delay(2500);
  }
};

const renderDocuments = async () => {
  try {
    const { documents } = await apiFetch('/api/documents');
    $('metricAll').textContent = documents.length;
    $('metricPending').textContent = documents.filter((item) => item.status === 'pending').length;
    $('metricComplete').textContent = documents.filter((item) => item.status === 'completed').length;
    const awaiting = ['owner', 'viewer'].includes(state.user?.role)
      ? documents.filter((item) => !['completed', 'rescinded'].includes(item.status)).length
      : documents.filter((item) => item.needsSignature && !['completed', 'rescinded'].includes(item.status)).length;
    $('dispensationsMenuCard').classList.toggle('awaiting', awaiting > 0);
    $('dispensationsMenuStatus').textContent = awaiting > 0
      ? `${awaiting} document${awaiting === 1 ? '' : 's'} awaiting action`
      : 'Open the dispensation queue';
    const list = $('docList');
    list.innerHTML = '';
    if (!documents.length) {
      list.innerHTML = '<div class="empty-state"><span>◇</span><h3>The queue is clear</h3><p>New dispensation requests will appear here automatically.</p></div>';
      return documents;
    }
    let queueNumber = 0;
    documents.forEach((doc) => {
      if (!['completed', 'rescinded'].includes(doc.status)) queueNumber += 1;
      const article = window.document.createElement('article');
      article.className = 'doc-row';
      const signerHtml = doc.signers.map((signer) =>
        `<span class="signer ${signer.signed_at ? 'signed' : ''}">${signer.signed_at ? '✓' : '○'} ${signer.signer_name}</span>`).join('');
      const status = doc.status === 'rescinded'
        ? 'Rescinded'
        : doc.status === 'completed' ? 'Completed'
        : doc.needsSignature ? 'Your signature is needed' : 'Awaiting signatures';
      article.innerHTML = `
        <div class="queue-number">${doc.status === 'rescinded' ? 'R' : doc.status === 'completed' ? '✓' : queueNumber}</div>
        <div class="doc-icon">PDF</div>
        <div class="doc-main"><h3></h3><p>${formatDate(doc.created_at)} · ${signerHtml}</p></div>
        <span class="status ${doc.status}">${status}</span>
        <div class="doc-actions"></div>`;
      article.querySelector('h3').textContent = doc.title || doc.original_name;
      const actions = article.querySelector('.doc-actions');
      const openButton = window.document.createElement('button');
      openButton.className = 'text-button';
      openButton.textContent = 'View PDF';
      openButton.addEventListener('click', () => openPdf(doc.id, doc.original_name));
      actions.appendChild(openButton);
      if (doc.needsSignature && !['completed', 'rescinded'].includes(doc.status)) {
        const signButton = window.document.createElement('button');
        signButton.className = 'primary compact';
        signButton.textContent = 'Review and sign';
        signButton.addEventListener('click', () => openSignerModal(doc.id, doc.title));
        actions.appendChild(signButton);
      }
      /* A completed dispensation is not done until the District Deputy has it. Say plainly
       * whether it went, because a silent failure is how one misses its date. */
      if (state.user?.role !== 'viewer' && doc.status === 'completed' && doc.template_kind === 'dispensation_v1') {
        const note = window.document.createElement('p');
        note.className = 'queue-submission';
        if (doc.submitted_at) {
          note.textContent = `Sent to the District Deputy ${new Date(doc.submitted_at).toLocaleString()}`;
        } else {
          note.textContent = doc.submitted_error
            ? `NOT sent to the District Deputy. ${doc.submitted_error}`
            : 'Not yet sent to the District Deputy.';
          note.classList.add('queue-submission-warn');
        }
        article.querySelector('.doc-main').appendChild(note);
      }
      if (state.user?.role === 'owner' && doc.status === 'completed'
          && doc.template_kind === 'dispensation_v1') {
        /* Opens his own mail client with the note already written, and downloads the executed PDF
         * at the same time so it is sitting in Downloads ready to drag in. mailto has no
         * attachment field, so the download is the closest thing to attaching it for him. */
        const draftButton = window.document.createElement('button');
        draftButton.className = 'secondary compact';
        draftButton.textContent = 'Draft in my mail app';
        draftButton.addEventListener('click', async () => {
          try {
            const { draft } = await apiFetch(`/api/documents/${doc.id}/submission-draft`);
            const blob = await apiFetch(`/api/documents/${doc.id}/file`);
            const url = URL.createObjectURL(blob);
            const link = window.document.createElement('a');
            link.href = url;
            link.download = draft.filename;
            window.document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            setMessage(docMessage,
              `${draft.filename} has been downloaded. Your mail app is opening with the note written. Drag the PDF in and send.`);
            window.location.href = `mailto:${encodeURIComponent(draft.to)}`
              + `?subject=${encodeURIComponent(draft.subject)}`
              + `&body=${encodeURIComponent(draft.body)}`;
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(draftButton);
      }
      if (state.user?.role === 'owner' && doc.status === 'completed'
          && doc.template_kind === 'dispensation_v1') {
        const sendButton = window.document.createElement('button');
        sendButton.className = doc.submitted_at ? 'secondary compact' : 'primary compact';
        sendButton.textContent = doc.submitted_at ? 'Send again' : 'Send to the District Deputy';
        sendButton.addEventListener('click', async () => {
          if (doc.submitted_at
              && !window.confirm('This already went to the District Deputy. Send it to him again?')) return;
          try {
            const payload = await apiFetch(`/api/documents/${doc.id}/submit`, {
              method: 'POST', body: JSON.stringify({ resend: Boolean(doc.submitted_at) }),
            });
            setMessage(docMessage, payload.message || 'Sent to the District Deputy.');
            await renderDocuments();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(sendButton);
      }
      /* Only worth offering while exactly one of the two Secretaries is on it. */
      const secretaryRoles = ['secretary', 'assistant_secretary'];
      const onIt = secretaryRoles.filter((role) => (doc.signers || []).some((s) => s.signer_role === role));
      if (state.user?.role === 'owner' && onIt.length === 1
          && !['completed', 'rescinded'].includes(doc.status)) {
        const bothButton = window.document.createElement('button');
        bothButton.className = 'secondary compact';
        bothButton.textContent = 'Let either Secretary sign';
        bothButton.addEventListener('click', async () => {
          if (!window.confirm(`Send ${doc.title || doc.original_name} to both Secretaries? Whoever signs first completes it.`)) return;
          try {
            const payload = await apiFetch(`/api/documents/${doc.id}/offer-to-both`, { method: 'POST' });
            setMessage(docMessage, payload.message || 'Either Secretary can now sign it.');
            await renderDocuments();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(bothButton);
      }
      if (state.user?.role === 'owner' && !['completed', 'rescinded'].includes(doc.status)) {
        const rescindButton = window.document.createElement('button');
        rescindButton.className = 'secondary compact danger';
        rescindButton.textContent = 'Rescind';
        rescindButton.addEventListener('click', async () => {
          if (!window.confirm(`Rescind ${doc.title || doc.original_name}? It will be removed from the active signing queue.`)) return;
          try {
            const payload = await apiFetch(`/api/documents/${doc.id}/rescind`, { method: 'POST' });
            setMessage(docMessage, payload.message || 'Document rescinded.');
            await renderDocuments();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(rescindButton);
      }
      if (state.user?.role === 'viewer') actions.replaceChildren();
      list.appendChild(article);
    });
    return documents;
  } catch (error) {
    setMessage(docMessage, error.message, true);
    return [];
  }
};

const showPendingSignatureNotice = (user, documents) => {
  const pending = ['owner', 'viewer'].includes(user.role)
    ? documents.filter((document) => !['completed', 'rescinded'].includes(document.status))
    : documents.filter((document) => document.needsSignature && !['completed', 'rescinded'].includes(document.status));
  if (!pending.length) return;
  state.pendingReviewDocument = pending[0];
  $('pendingSignatureTitle').textContent = user.role === 'owner'
    ? (pending.length === 1 ? 'Dispensation activity awaiting review' : `${pending.length} dispensations awaiting review`)
    : user.role === 'viewer'
      ? (pending.length === 1 ? 'Dispensation activity ready to view' : `${pending.length} dispensations ready to view`)
    : (pending.length === 1 ? 'Dispensation awaiting review and signature' : `${pending.length} dispensations awaiting review and signature`);
  $('pendingSignatureMessage').textContent = user.role === 'owner' || user.role === 'viewer'
    ? `${pending.length} active dispensation${pending.length === 1 ? ' is' : 's are'} in the officer signing queue.`
    : (pending.length === 1
      ? `${pending[0].title || pending[0].original_name} is assigned to you and ready for review.`
      : `You have ${pending.length} assigned dispensations ready for review.`);
  show($('pendingSignatureNotice'));
};

$('dismissPendingSignature').addEventListener('click', () => hide($('pendingSignatureNotice')));
$('reviewPendingSignature').addEventListener('click', () => {
  const document = state.pendingReviewDocument;
  hide($('pendingSignatureNotice'));
  if (state.user?.role === 'owner' || state.user?.role === 'viewer') {
    showWorkspaceSection('queue');
  } else if (document) {
    openSignerModal(document.id, document.title || document.original_name);
  }
});

const openPdf = async (id, fileName) => {
  try {
    setMessage(docMessage, 'Loading protected PDF...');
    const blob = await apiFetch(`/api/documents/${id}/file`);
    if (state.pdfObjectUrl) URL.revokeObjectURL(state.pdfObjectUrl);
    const url = URL.createObjectURL(blob);
    state.pdfObjectUrl = url;
    $('pdfViewerTitle').textContent = fileName || 'Lodge document';
    $('pdfFrame').src = url;
    show($('pdfModal'));
    setMessage(docMessage, '');
  } catch (error) {
    setMessage(docMessage, error.message, true);
  }
};

$('closePdf').addEventListener('click', () => {
  hide($('pdfModal'));
  $('pdfFrame').removeAttribute('src');
  if (state.pdfObjectUrl) URL.revokeObjectURL(state.pdfObjectUrl);
  state.pdfObjectUrl = '';
});

const renderOfficers = async () => {
  try {
    const { officers, pending = [] } = await apiFetch('/api/officers');
    const list = $('officerList');
    list.innerHTML = '';
    const activeByRole = new Map(officers.filter((officer) => officer.role !== 'viewer').map((officer) => [officer.role, officer]));
    /* Three states, not two. A man who has been invited and has not taken it up yet is pending,
     * and calling that "invitation needed" is how he ends up invited twice. */
    const pendingByRole = new Map(pending.map((invite) => [invite.role, invite]));
    const seat = (role, fallbackName) => {
      const active = activeByRole.get(role);
      if (active) return { ...active, state: 'active' };
      const waiting = pendingByRole.get(role);
      if (waiting) return { ...waiting, state: 'pending' };
      return { role, name: fallbackName, email: '', state: 'none' };
    };
    const entries = [
      seat('secretary', 'William McDuffie'),
      seat('assistant_secretary', 'Adrian Reese'),
      ...officers.filter((officer) => officer.role === 'viewer').map((o) => ({ ...o, state: 'active' })),
      ...pending.filter((invite) => invite.role === 'viewer').map((i) => ({ ...i, state: 'pending' })),
    ];
    entries.forEach((officer) => {
      const row = window.document.createElement('div');
      const badge = window.document.createElement('span');
      badge.className = 'officer-initials';
      badge.textContent = initials(officer.name);
      const details = window.document.createElement('p');
      const strong = window.document.createElement('strong');
      strong.textContent = officer.name;
      const small = window.document.createElement('small');
      const stateLabel = officer.state === 'active'
        ? 'Active'
        : officer.state === 'pending' ? 'Pending, invited and not signed in yet' : 'Invitation needed';
      small.textContent = `${roleLabel(officer.role)} · ${stateLabel}`;
      details.append(strong, small);
      const status = window.document.createElement('i');
      if (officer.state === 'active') status.className = 'active';
      else if (officer.state === 'pending') status.className = 'pending';
      row.append(badge, details, status);
      if (officer.state === 'active') {
        const revoke = window.document.createElement('button');
        revoke.className = 'text-button danger';
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', async () => {
          if (!window.confirm(`Revoke access for ${officer.name}? They will be signed out immediately.`)) return;
          try {
            const result = await apiFetch('/api/officers/revoke', {
              method: 'POST',
              body: JSON.stringify({ email: officer.email }),
            });
            setMessage(docMessage, result.message);
            await renderOfficers();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    });
  } catch (error) {
    $('officerList').innerHTML = `<p class="helper">${error.message}</p>`;
  }
};

$('showLogin').addEventListener('click', () => setActiveTab('login'));
$('showRegister').addEventListener('click', () => setActiveTab('register'));
$('showReset').addEventListener('click', () => setActiveTab('reset'));

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value,
      }),
    });
    state.token = payload.token;
    localStorage.setItem('stone-square-sign-token', payload.token);
    await enterWorkspace(payload.user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: $('registerName').value.trim(),
        email: $('registerEmail').value.trim(),
        password: $('registerPassword').value,
        invitationToken: state.invitationToken,
        role: $('registerRole').value,
        accessCode: $('registerAccessCode').value.trim(),
      }),
    });
    state.token = payload.token;
    localStorage.setItem('stone-square-sign-token', payload.token);
    history.replaceState({}, '', '/');
    await enterWorkspace(payload.user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('requestReset').addEventListener('click', async () => {
  try {
    const payload = await apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({
        email: $('resetEmail').value.trim(),
      }),
    });
    setMessage(authMessage, payload.message);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('resetSubmit').addEventListener('click', async () => {
  try {
    const payload = await apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        email: $('resetEmail').value.trim(),
        code: $('resetCode').value.trim(),
        newPassword: $('resetPassword').value,
      }),
    });
    setActiveTab('login');
    setMessage(authMessage, payload.message);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  state.realtimeAbort?.abort();
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = '';
  state.user = null;
  localStorage.removeItem('stone-square-sign-token');
  hide($('appCard'));
  show($('authCard'));
  setActiveTab('login');
});

$('documentFile').addEventListener('change', () => {
  $('selectedFile').textContent = $('documentFile').files[0]?.name || 'No file selected';
});
$('uploadShortcut').addEventListener('click', () => {
  showWorkspaceSection('queue');
  $('uploadPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

const builderToday = new Date();
const builderTodayValue = [builderToday.getFullYear(), String(builderToday.getMonth() + 1).padStart(2, '0'), String(builderToday.getDate()).padStart(2, '0')].join('-');
$('dispRequestDate').value = builderTodayValue;
$('dispSignerRole').addEventListener('change', applySubmissionProfiles);
['dispMasterAddress'].forEach((id) => {
  $(id).addEventListener('input', () => { $('confirmSubmissionProfiles').checked = false; });
});
$('reviewPastedDetails').addEventListener('click', async () => {
  const text = $('dispPasteDetails').value.trim();
  if (!text) return setMessage($('builderMessage'), 'Paste the dispensation information first.', true);
  try {
    const result = await apiFetch('/api/dispensations/parse', {
      method: 'POST', body: JSON.stringify({ text }),
    });
    state.parsedDispensation = result;
    const labels = {
      title: 'Title', requestDate: 'Request date', signerRole: 'Send to', requestDetails: 'Request',
      eventDate: 'Event date', eventTime: 'Event time', locationName: 'Location',
      streetAddress: 'Street', cityState: 'City, state, ZIP',
      worshipfulMasterAddress: 'Worshipful Master address', secretaryAddress: 'Officer address',
    };
    const container = $('pasteReviewFields');
    container.innerHTML = '';
    Object.entries(labels).forEach(([key, label]) => {
      if (!result.fields[key] && ['worshipfulMasterAddress', 'secretaryAddress'].includes(key)) return;
      const row = window.document.createElement('div');
      const name = window.document.createElement('strong');
      const value = window.document.createElement('span');
      name.textContent = label;
      let displayValue = result.fields[key] || 'Not found';
      if (key === 'signerRole') {
        displayValue = result.fields[key] === 'assistant_secretary'
          ? SIGNER_CHOICES.assistant_secretary.label : SIGNER_CHOICES.both.label;
      } else if (key === 'eventTime' && /^\d{1,2}:\d{2}$/.test(result.fields[key] || '')) {
        const [hourText, minute] = result.fields[key].split(':');
        const hour = Number(hourText);
        displayValue = `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
      } else if ((key === 'requestDate' || key === 'eventDate') && /^\d{4}-\d{2}-\d{2}$/.test(result.fields[key] || '')) {
        displayValue = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })
          .format(new Date(`${result.fields[key]}T12:00:00Z`));
      }
      value.textContent = displayValue;
      row.append(name, value);
      container.appendChild(row);
    });
    $('pasteReviewWarnings').textContent = result.warnings.join(' ');
    show($('pasteReviewModal'));
  } catch (error) {
    setMessage($('builderMessage'), error.message, true);
  }
});
$('findLocationAddress').addEventListener('click', async () => {
  const locationName = $('dispLocationName').value.trim();
  if (!locationName) return setMessage($('builderMessage'), 'Enter the event location name first.', true);
  try {
    setMessage($('builderMessage'), 'Searching for the event address...');
    const { matches } = await apiFetch('/api/locations/search', {
      method: 'POST',
      body: JSON.stringify({ locationName, cityState: $('dispCityState').value.trim() }),
    });
    if (!matches.length) throw new Error('No matching address was found. Add a city or ZIP code and try again.');
    state.locationMatch = matches[0];
    $('locationMatchName').textContent = matches[0].displayName;
    $('locationMatchStreet').textContent = matches[0].streetAddress;
    $('locationMatchCity').textContent = matches[0].cityState;
    setMessage($('builderMessage'), '');
    show($('locationConfirmModal'));
  } catch (error) {
    setMessage($('builderMessage'), error.message, true);
  }
});
$('rejectLocationAddress').addEventListener('click', () => hide($('locationConfirmModal')));
$('useLocationAddress').addEventListener('click', () => {
  if (!state.locationMatch) return;
  $('dispStreet').value = state.locationMatch.streetAddress;
  $('dispCityState').value = state.locationMatch.cityState;
  hide($('locationConfirmModal'));
});
$('rejectPastedDetails').addEventListener('click', () => hide($('pasteReviewModal')));
$('usePastedDetails').addEventListener('click', fillFormFromParsedDispensation);

/* The builder asks one question, "send to", and the server takes a list. Sending to
 * both is the ordinary case: either Secretary may sign and the first one finishes it. */
const SIGNER_CHOICES = {
  both: { roles: ['secretary', 'assistant_secretary'], label: 'Both Secretaries, whoever signs first' },
  secretary: { roles: ['secretary'], label: 'William McDuffie, Secretary' },
  assistant_secretary: { roles: ['assistant_secretary'], label: 'Adrian Reese, Assistant Secretary' },
};
const signerChoice = () => SIGNER_CHOICES[$('dispSignerRole').value] || SIGNER_CHOICES.both;

const dispensationPayload = () => ({
  title: $('dispTitle').value.trim(),
  requestDate: $('dispRequestDate').value,
  signerRoles: signerChoice().roles,
  requestDetails: $('dispRequestDetails').value.trim(),
  eventDate: $('dispEventDate').value,
  eventTime: $('dispEventTime').value,
  locationName: $('dispLocationName').value.trim(),
  streetAddress: $('dispStreet').value.trim(),
  cityState: $('dispCityState').value.trim(),
  worshipfulMasterAddress: $('dispMasterAddress').value.trim(),
  personalInfoConfirmed: $('confirmSubmissionProfiles').checked,
});

$('dispensationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('builderMessage');
  try {
    setMessage(message, 'Creating your PDF preview...');
    const blob = await apiFetch('/api/dispensations/preview', { method: 'POST', body: JSON.stringify(dispensationPayload()) });
    if (state.dispensationPreviewUrl) URL.revokeObjectURL(state.dispensationPreviewUrl);
    state.dispensationPreviewUrl = URL.createObjectURL(blob);
    $('dispensationPreviewFrame').src = state.dispensationPreviewUrl;
    const payload = dispensationPayload();
    const rows = [
      ['Title', payload.title], ['Request', payload.requestDetails],
      ['Event', `${payload.eventDate} at ${formatClockTime(payload.eventTime)}`],
      ['Location', `${payload.locationName}, ${payload.streetAddress}, ${payload.cityState}`],
      ['Send to', signerChoice().label],
      ['Worshipful Master address', payload.worshipfulMasterAddress],
    ];
    const container = $('finalReviewFields');
    container.innerHTML = '';
    rows.forEach(([label, value]) => {
      const row = window.document.createElement('div');
      const name = window.document.createElement('strong');
      const content = window.document.createElement('span');
      name.textContent = label;
      content.textContent = value;
      row.append(name, content);
      container.appendChild(row);
    });
    setMessage(message, '');
    show($('dispensationFinalReview'));
  } catch (error) {
    setMessage(message, error.message, true);
  }
});

$('backFromFinalReview').addEventListener('click', () => hide($('dispensationFinalReview')));
$('sendDispensation').addEventListener('click', async () => {
  try {
    setMessage($('finalReviewMessage'), 'Sending the dispensation to the officer queue...');
    await apiFetch('/api/dispensations', { method: 'POST', body: JSON.stringify(dispensationPayload()) });
    hide($('dispensationFinalReview'));
    $('dispensationForm').reset();
    $('dispRequestDate').value = builderTodayValue;
    applySubmissionProfiles();
    document.querySelectorAll('.parsed-covered').forEach((element) => element.classList.remove('hidden'));
    hide($('remainingQuestionsIntro'));
    showWorkspaceSection('queue');
    setMessage(docMessage, 'Dispensation created from the official template and added to the queue.');
    await renderDocuments();
  } catch (error) {
    setMessage($('finalReviewMessage'), error.message, true);
  }
});

$('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('documentFile').files[0];
  if (!file) return setMessage(docMessage, 'Choose a PDF first.', true);
  try {
    setMessage(docMessage, 'Reading document and adding it to the live queue...');
    const form = new FormData();
    form.append('document', file);
    form.append('title', $('docTitle').value.trim());
    await apiFetch('/api/documents', { method: 'POST', body: form });
    $('uploadForm').reset();
    $('selectedFile').textContent = 'No file selected';
    setMessage(docMessage, 'Document added to the live queue.');
    await renderDocuments();
  } catch (error) {
    setMessage(docMessage, error.message, true);
  }
});

$('openInvite').addEventListener('click', () => {
  show($('inviteModal'));
  hide($('inviteResult'));
});
$('closeInvite').addEventListener('click', () => hide($('inviteModal')));
$('inviteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await apiFetch('/api/officers/invite', {
      method: 'POST',
      body: JSON.stringify({
        role: $('inviteRole').value,
        name: $('inviteName').value.trim(),
        email: $('inviteEmail').value.trim(),
      }),
    });
    state.invitationUrl = payload.inviteUrl;
    $('inviteMessage').textContent = payload.emailSent
      ? 'Invitation emailed. The private link expires in seven days.'
      : 'Invitation created. Email delivery is not connected, so copy and send this private link directly.';
    show($('inviteResult'));
    await renderOfficers();
  } catch (error) {
    $('inviteMessage').textContent = error.message;
    show($('inviteResult'));
  }
});
$('copyInvite').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.invitationUrl);
  $('copyInvite').textContent = 'Private link copied';
});

const profileCanvas = $('profileSigCanvas');
const profileContext = profileCanvas.getContext('2d');
let profileDrawing = false;

const configureProfileCanvas = () => {
  const ratio = window.devicePixelRatio || 1;
  profileCanvas.width = Math.floor(profileCanvas.clientWidth * ratio);
  profileCanvas.height = Math.floor(profileCanvas.clientHeight * ratio);
  profileContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  profileContext.strokeStyle = '#071b2f';
  profileContext.lineWidth = 2.6;
  profileContext.lineCap = 'round';
  profileContext.lineJoin = 'round';
};

const profilePoint = (event) => {
  const rect = profileCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

profileCanvas.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  profileDrawing = true;
  const point = profilePoint(event);
  profileContext.beginPath();
  profileContext.moveTo(point.x, point.y);
});
profileCanvas.addEventListener('pointermove', (event) => {
  if (!profileDrawing) return;
  event.preventDefault();
  const point = profilePoint(event);
  profileContext.lineTo(point.x, point.y);
  profileContext.stroke();
  state.profileHasInk = true;
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((name) => {
  profileCanvas.addEventListener(name, () => { profileDrawing = false; });
});

const clearProfileCanvas = () => {
  profileContext.clearRect(0, 0, profileCanvas.clientWidth, profileCanvas.clientHeight);
  state.profileHasInk = false;
};

const typedSignatureStyles = [
  { label: 'Classic Script', font: '"Snell Roundhand", "Segoe Script", cursive', size: 64, skew: 0, rotation: 0 },
  { label: 'Bold Script', font: '"Snell Roundhand", "Segoe Script", cursive', size: 61, weight: 700, skew: 0, rotation: 0 },
  { label: 'Formal Chancery', font: '"Apple Chancery", "URW Chancery L", cursive', size: 55, skew: -0.08, rotation: 0 },
  { label: 'Elegant Script', font: '"Savoye LET", "Brush Script MT", cursive', size: 61, skew: 0, rotation: 0 },
  { label: 'House Script', font: 'SignPainter, "Brush Script MT", cursive', size: 60, skew: -0.04, rotation: 0 },
  { label: 'Ornate Pen', font: 'Zapfino, "Snell Roundhand", cursive', size: 43, skew: 0, rotation: 0 },
  { label: 'Personal Note', font: 'Noteworthy, "Segoe Print", cursive', size: 56, skew: 0, rotation: -0.02 },
  { label: 'Natural Hand', font: '"Bradley Hand", "Segoe Print", cursive', size: 58, skew: 0, rotation: -0.035 },
];

const drawTypedSignature = (canvas, name, styleIndex) => {
  const ratio = window.devicePixelRatio || 1;
  const width = 620;
  const height = 145;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#071b2f';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const style = typedSignatureStyles[styleIndex] || typedSignatureStyles[0];
  context.font = `${style.weight || 400} ${style.size}px ${style.font}`;
  const safeName = name || 'Your Name';
  const measured = context.measureText(safeName).width;
  const scale = Math.min(1, 535 / Math.max(measured, 1));
  context.save();
  context.translate(width / 2, height / 2 - 3);
  if (style.skew) context.transform(1, 0, style.skew, 1, 0, 0);
  if (style.rotation) context.rotate(style.rotation);
  context.scale(scale, 1);
  context.fillText(safeName, 0, 0);
  context.restore();
};

const renderTypedChoices = () => {
  const name = $('typedSignatureName').value.trim() || state.user?.name || 'Your Name';
  const container = $('typedSignatureChoices');
  container.innerHTML = '';
  for (let index = 0; index < typedSignatureStyles.length; index += 1) {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = `signature-choice ${state.selectedTypedStyle === index ? 'selected' : ''}`;
    button.setAttribute('aria-label', typedSignatureStyles[index].label);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, name, index);
    button.appendChild(canvas);
    const label = window.document.createElement('span');
    label.textContent = typedSignatureStyles[index].label;
    button.appendChild(label);
    button.addEventListener('click', () => {
      state.selectedTypedStyle = index;
      renderTypedChoices();
    });
    container.appendChild(button);
  }
};

const signatureInitialsFromName = (name) => name
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((part) => part[0])
  .join('')
  .slice(0, 4)
  .toUpperCase();

const renderInitialsChoices = () => {
  const value = $('signatureInitials').value.trim().toUpperCase()
    || signatureInitialsFromName(state.user?.name || '')
    || 'WDS';
  const container = $('initialsSignatureChoices');
  container.innerHTML = '';
  for (let index = 0; index < typedSignatureStyles.length; index += 1) {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = `signature-choice ${state.selectedTypedStyle === index ? 'selected' : ''}`;
    button.setAttribute('aria-label', `${typedSignatureStyles[index].label} initials`);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, value, index);
    button.appendChild(canvas);
    const label = window.document.createElement('span');
    label.textContent = typedSignatureStyles[index].label;
    button.appendChild(label);
    button.addEventListener('click', () => {
      state.selectedTypedStyle = index;
      renderInitialsChoices();
    });
    container.appendChild(button);
  }
};

const selectSignatureMode = (mode) => {
  state.signatureMode = mode;
  $('chooseDraw').classList.toggle('active', mode === 'drawn');
  $('chooseType').classList.toggle('active', mode === 'typed');
  $('chooseInitials').classList.toggle('active', mode === 'initials');
  $('drawSignaturePanel').classList.toggle('hidden', mode !== 'drawn');
  $('typeSignaturePanel').classList.toggle('hidden', mode !== 'typed');
  $('initialsSignaturePanel').classList.toggle('hidden', mode !== 'initials');
  if (mode === 'typed') renderTypedChoices();
  if (mode === 'initials') renderInitialsChoices();
};

const openSignatureSetup = (required = false) => {
  state.signatureRequired = required;
  $('closeSignatureSetup').classList.toggle('hidden', required);
  $('signatureSetupTitle').textContent = required ? 'Create your signature to continue' : 'Change your saved signature';
  $('signatureSetupHelp').textContent = required
    ? 'Choose how your signature should appear before opening the live document queue.'
    : 'The new signature will be used on documents you sign after it is saved.';
  $('typedSignatureName').value = state.user?.name || '';
  $('signatureInitials').value = signatureInitialsFromName(state.user?.name || '');
  state.selectedTypedStyle = 0;
  show($('signatureSetupModal'));
  selectSignatureMode('typed');
  configureProfileCanvas();
  clearProfileCanvas();
  setMessage($('profileSignatureMessage'), '');
};

$('profileButton').addEventListener('click', () => openSignatureSetup(false));
$('chooseDraw').addEventListener('click', () => selectSignatureMode('drawn'));
$('chooseType').addEventListener('click', () => selectSignatureMode('typed'));
$('chooseInitials').addEventListener('click', () => selectSignatureMode('initials'));
$('typedSignatureName').addEventListener('input', renderTypedChoices);
$('signatureInitials').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase();
  renderInitialsChoices();
});
$('clearProfileSig').addEventListener('click', clearProfileCanvas);
$('closeSignatureSetup').addEventListener('click', () => {
  if (!state.signatureRequired) hide($('signatureSetupModal'));
});

$('saveProfileSignature').addEventListener('click', async () => {
  let signatureData;
  let styleName = 'drawn';
  if (state.signatureMode === 'drawn') {
    if (!state.profileHasInk) {
      return setMessage($('profileSignatureMessage'), 'Draw your signature before saving.', true);
    }
    signatureData = profileCanvas.toDataURL('image/png');
  } else if (state.signatureMode === 'typed') {
    const name = $('typedSignatureName').value.trim();
    if (!name) return setMessage($('profileSignatureMessage'), 'Type your name before choosing a style.', true);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, name, state.selectedTypedStyle);
    signatureData = canvas.toDataURL('image/png');
    styleName = `cursive-${state.selectedTypedStyle + 1}`;
  } else {
    const value = $('signatureInitials').value.trim().toUpperCase();
    if (!value) return setMessage($('profileSignatureMessage'), 'Enter your initials before choosing a style.', true);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, value, state.selectedTypedStyle);
    signatureData = canvas.toDataURL('image/png');
    styleName = `initials-${state.selectedTypedStyle + 1}`;
  }
  try {
    const payload = await apiFetch('/api/profile/signature', {
      method: 'PUT',
      body: JSON.stringify({
        signatureData,
        signatureType: state.signatureMode,
        styleName,
      }),
    });
    state.user = payload.user;
    state.signatureRequired = false;
    hide($('signatureSetupModal'));
    setMessage(docMessage, 'Your signature profile is saved.');
  } catch (error) {
    setMessage($('profileSignatureMessage'), error.message, true);
  }
});

const loadSavedSignature = async (imageElement) => {
  const blob = await apiFetch('/api/profile/signature');
  if (state.signatureObjectUrl) URL.revokeObjectURL(state.signatureObjectUrl);
  state.signatureObjectUrl = URL.createObjectURL(blob);
  imageElement.src = state.signatureObjectUrl;
};

const openSignerModal = async (documentId, title) => {
  if (!state.user?.hasSignature) return openSignatureSetup(true);
  state.signingDocumentId = documentId;
  $('signTitle').textContent = `Sign ${title || 'document'}`;
  $('signatureConsent').checked = false;
  $('signerAddress').value = '';
  $('submitSig').disabled = true;
  if (state.signingPdfObjectUrl) URL.revokeObjectURL(state.signingPdfObjectUrl);
  state.signingPdfObjectUrl = null;
  $('signingPdfFrame').removeAttribute('src');
  setMessage($('signMessage'), 'Loading the document for review...');
  show($('signModal'));
  try {
    const pdfResponse = await fetch(`/api/documents/${documentId}/file`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!pdfResponse.ok) {
      const payload = await pdfResponse.json().catch(() => ({}));
      throw new Error(payload.error || 'The PDF could not be loaded for review.');
    }
    const [pdfBlob] = await Promise.all([
      pdfResponse.blob(),
      loadSavedSignature($('signingSignaturePreview')),
    ]);
    state.signingPdfObjectUrl = URL.createObjectURL(pdfBlob);
    $('signingPdfFrame').src = state.signingPdfObjectUrl;
    $('submitSig').disabled = false;
    setMessage($('signMessage'), 'Document loaded. Review it before consenting and signing.');
  } catch (error) {
    setMessage($('signMessage'), error.message, true);
  }
};

const closeSignerModal = () => {
  hide($('signModal'));
  $('signingPdfFrame').removeAttribute('src');
  if (state.signingPdfObjectUrl) URL.revokeObjectURL(state.signingPdfObjectUrl);
  state.signingPdfObjectUrl = null;
  $('submitSig').disabled = true;
};

$('closeSign').addEventListener('click', closeSignerModal);
$('changeSignatureFromSign').addEventListener('click', () => {
  closeSignerModal();
  openSignatureSetup(false);
});
$('submitSig').addEventListener('click', async () => {
  if (!$('signatureConsent').checked) {
    return setMessage($('signMessage'), 'Confirm the electronic signature consent.', true);
  }
  if (!$('signerAddress').value.trim()) {
    return setMessage($('signMessage'), 'Enter your address as it should appear on the dispensation.', true);
  }
  try {
    const payload = await apiFetch(`/api/documents/${state.signingDocumentId}/sign`, {
      method: 'POST', body: JSON.stringify({ consent: true, officerAddress: $('signerAddress').value.trim() }),
    });
    closeSignerModal();
    setMessage(docMessage, payload.message);
    await renderDocuments();
  } catch (error) {
    setMessage($('signMessage'), error.message, true);
  }
});

$('dispensationForm').addEventListener('invalid', (event) => {
  event.target.closest('.parsed-covered')?.classList.remove('hidden');
  const label = document.querySelector(`label[for="${event.target.id}"]`)?.textContent?.trim() || 'required field';
  setMessage($('builderMessage'), `Complete ${label.toLowerCase()} before reviewing the PDF.`, true);
}, true);

const initialize = async () => {
  const inviteEmail = new URLSearchParams(window.location.search).get('email');
  if (inviteEmail) $('registerEmail').value = inviteEmail;
  try {
    const setup = await apiFetch('/api/setup');
    if (setup.registrationMode === 'access_code' && !state.invitationToken) {
      show($('selfServeFields'));
      $('registerEyebrow').textContent = 'LODGE OFFICERS';
      $('registerHeading').textContent = 'Create your account';
      $('registerHelp').textContent = 'Choose your office and enter the access code the Worshipful Master sent you.';
    }
    if (setup.needsOwnerSetup && !state.invitationToken) {
      $('registerEyebrow').textContent = 'INITIAL SETUP';
      $('registerHeading').textContent = 'Create the owner account';
      $('registerHelp').textContent = 'The first account controls document uploads and officer invitations.';
    }
  } catch (_error) {}
  if (state.invitationToken) setActiveTab('register');
  if (state.token) {
    try {
      const payload = await apiFetch('/api/auth/me');
      await enterWorkspace(payload.user);
    } catch (_error) {
      localStorage.removeItem('stone-square-sign-token');
      state.token = '';
    }
  }
};

initialize();

/* ---------- Dues ----------
 * Restricted to the Worshipful Master, the Secretary and the Assistant Secretary.
 * Rendered needs-attention-first, because the point of the page is knowing who to
 * call, not admiring a total. */
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const renderDues = async (force = false) => {
  if (state.duesLoading) return;
  if (state.duesLoaded && !force) return;
  state.duesLoading = true;
  setMessage($('duesMessage'), 'Reading payments from Zeffy…');
  try {
    const led = await apiFetch('/api/dues');
    $('duesYearLine').textContent =
      `${led.duesYear} dues, ${money(led.rateCents)} each, reconciled live against both Zeffy campaigns.`;
    $('duesCollected').textContent = money(led.totals.collectedCents);
    $('duesOutstanding').textContent = money(led.totals.outstandingCents);
    $('duesPaidCount').textContent = String(led.totals.paidCount);
    $('duesUnpaidCount').textContent = String(led.totals.unpaidCount);

    const stale = $('duesStale');
    if (led.staleCampaign) {
      stale.textContent = `Last year's custom dues campaign is still open and has taken ${led.staleCampaign.count} payment(s) totalling ${money(led.staleCampaign.totalCents)}. Those are NOT counted above. Close that campaign in Zeffy.`;
      stale.classList.remove('hidden');
    } else stale.classList.add('hidden');

    const rows = $('duesRows');
    rows.replaceChildren();
    for (const r of led.rows) {
      const el = document.createElement('div');
      el.className = `item dues-row dues-${r.status}`;
      const paid = r.status === 'paid'
        ? `Paid in full${r.lastPaymentISO ? ` on ${r.lastPaymentISO}` : ''}`
        : r.status === 'partial'
          ? `${money(r.paidCents)} of ${money(r.assessedCents)}, ${money(r.remainingCents)} outstanding`
          : 'Nothing received';
      const credit = r.creditCents ? ` · ${money(r.creditCents)} credit` : '';
      const how = r.payments.length
        ? ` · matched by ${[...new Set(r.payments.map((p) => p.matchedVia))].join(', ')}`
        : '';
      el.innerHTML = `<div class="grow"><div class="name">${r.name}</div><small>${paid}${credit}${how}</small></div><span class="pill">${r.status}</span>`;
      rows.append(el);
    }

    const panel = $('duesUnmatchedPanel');
    const un = $('duesUnmatched');
    un.replaceChildren();
    if (led.unmatched.length) {
      for (const u of led.unmatched) {
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `<div class="grow"><div class="name">${u.buyerName || u.buyerEmail || 'Unknown'}</div><small>${u.dateISO} · ${money(u.amountCents)} · ${u.buyerEmail}</small></div>`;
        un.append(el);
      }
      panel.classList.remove('hidden');
    } else panel.classList.add('hidden');

    setMessage($('duesMessage'), `${led.rows.length} Brothers · updated just now`);
    state.duesLoaded = true;
  } catch (error) {
    setMessage($('duesMessage'), error.message, true);
  } finally {
    state.duesLoading = false;
  }
};
