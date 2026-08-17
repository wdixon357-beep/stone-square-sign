const state = {
  token: localStorage.getItem('stone-square-sign-token') || '',
  user: null,
  signingDocumentId: null,
  invitationToken: new URLSearchParams(window.location.search).get('invite') || '',
  invitationUrl: '',
  signatureRequired: false,
  signatureMode: 'drawn',
  selectedTypedStyle: 0,
  profileHasInk: false,
  realtimeAbort: null,
  refreshTimer: null,
  signatureObjectUrl: '',
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
  owner: 'Document Owner',
  secretary: 'Secretary',
  assistant_secretary: 'Assistant Secretary',
}[role] || 'Signer');

const initials = (name) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const formatDate = (date) => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(date));

const enterWorkspace = async (user) => {
  state.user = user;
  $('whoami').textContent = user.name;
  $('userRole').textContent = roleLabel(user.role);
  $('userInitials').textContent = initials(user.name);
  document.querySelectorAll('.owner-only').forEach((element) => {
    element.classList.toggle('hidden', user.role !== 'owner');
  });
  hide($('authCard'));
  show($('appCard'));
  await Promise.all([
    renderDocuments(),
    user.role === 'owner' ? renderOfficers() : Promise.resolve(),
  ]);
  startRealtime();
  if (!user.hasSignature) window.setTimeout(() => openSignatureSetup(true), 150);
};

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
    $('metricPending').textContent = documents.filter((item) => item.status !== 'completed').length;
    $('metricComplete').textContent = documents.filter((item) => item.status === 'completed').length;
    const list = $('docList');
    list.innerHTML = '';
    if (!documents.length) {
      list.innerHTML = '<div class="empty-state"><span>◇</span><h3>The queue is clear</h3><p>New dispensation requests will appear here automatically.</p></div>';
      return;
    }
    let queueNumber = 0;
    documents.forEach((doc) => {
      if (doc.status !== 'completed') queueNumber += 1;
      const article = window.document.createElement('article');
      article.className = 'doc-row';
      const signerHtml = doc.signers.map((signer) =>
        `<span class="signer ${signer.signed_at ? 'signed' : ''}">${signer.signed_at ? '✓' : '○'} ${signer.signer_name}</span>`).join('');
      const status = doc.status === 'completed'
        ? 'Completed'
        : doc.needsSignature ? 'Your signature is needed' : 'Awaiting signatures';
      article.innerHTML = `
        <div class="queue-number">${doc.status === 'completed' ? '✓' : queueNumber}</div>
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
      if (doc.needsSignature && doc.status !== 'completed') {
        const signButton = window.document.createElement('button');
        signButton.className = 'primary compact';
        signButton.textContent = 'Review and sign';
        signButton.addEventListener('click', () => openSignerModal(doc.id, doc.title));
        actions.appendChild(signButton);
      }
      list.appendChild(article);
    });
  } catch (error) {
    setMessage(docMessage, error.message, true);
  }
};

const openPdf = async (id, fileName) => {
  try {
    setMessage(docMessage, 'Opening protected PDF...');
    const blob = await apiFetch(`/api/documents/${id}/file`);
    const url = URL.createObjectURL(blob);
    const popup = window.open(url, '_blank', 'noopener');
    if (!popup) {
      const link = window.document.createElement('a');
      link.href = url;
      link.download = fileName || 'lodge-document.pdf';
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    setMessage(docMessage, '');
  } catch (error) {
    setMessage(docMessage, error.message, true);
  }
};

const renderOfficers = async () => {
  try {
    const { officers } = await apiFetch('/api/officers');
    const byRole = new Map(officers.map((officer) => [officer.role, officer]));
    $('officerList').innerHTML = [
      ['secretary', 'William McDuffie', 'Secretary'],
      ['assistant_secretary', 'Adrian Reese', 'Assistant Secretary'],
    ].map(([role, fallback, label]) => {
      const officer = byRole.get(role);
      return `<div><span class="officer-initials">${initials(officer?.name || fallback)}</span><p><strong>${officer?.name || fallback}</strong><small>${label} · ${officer ? 'Active' : 'Invitation needed'}</small></p><i class="${officer ? 'active' : ''}"></i></div>`;
    }).join('');
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
        phone: $('registerPhone').value.trim(),
        password: $('registerPassword').value,
        invitationToken: state.invitationToken,
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
        phone: $('resetPhone').value.trim(),
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
        phone: $('resetPhone').value.trim(),
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
  $('uploadPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        phone: $('invitePhone').value.trim(),
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

const typedFonts = [
  '"Snell Roundhand", "Segoe Script", cursive',
  '"Apple Chancery", "URW Chancery L", cursive',
  '"Brush Script MT", "Segoe Print", cursive',
  'Georgia, "Times New Roman", serif',
  '"Bradley Hand", "Comic Sans MS", cursive',
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
  context.strokeStyle = '#071b2f';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const fontSize = [64, 55, 61, 52, 58][styleIndex];
  const italic = styleIndex === 3 ? 'italic' : '';
  context.font = `${italic} ${fontSize}px ${typedFonts[styleIndex]}`;
  const safeName = name || 'Your Name';
  const measured = context.measureText(safeName).width;
  const scale = Math.min(1, 535 / Math.max(measured, 1));
  context.save();
  context.translate(width / 2, height / 2 - 3);
  if (styleIndex === 1) context.transform(1, 0, -0.13, 1, 0, 0);
  if (styleIndex === 4) context.rotate(-0.035);
  context.scale(scale, 1);
  context.fillText(safeName, 0, 0);
  context.restore();
  context.lineCap = 'round';
  context.lineWidth = styleIndex === 2 ? 2 : 1.4;
  context.beginPath();
  if (styleIndex === 0) {
    context.moveTo(100, 112); context.bezierCurveTo(260, 121, 440, 102, 555, 112);
  } else if (styleIndex === 1) {
    context.moveTo(140, 115); context.bezierCurveTo(280, 100, 420, 126, 520, 108);
  } else if (styleIndex === 2) {
    context.moveTo(105, 113); context.lineTo(520, 113); context.bezierCurveTo(555, 113, 560, 95, 580, 99);
  } else if (styleIndex === 3) {
    context.moveTo(170, 111); context.lineTo(450, 111);
  } else {
    context.moveTo(120, 116); context.bezierCurveTo(270, 92, 420, 126, 555, 104);
  }
  context.stroke();
};

const renderTypedChoices = () => {
  const name = $('typedSignatureName').value.trim() || state.user?.name || 'Your Name';
  const container = $('typedSignatureChoices');
  container.innerHTML = '';
  for (let index = 0; index < 5; index += 1) {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = `signature-choice ${state.selectedTypedStyle === index ? 'selected' : ''}`;
    button.setAttribute('aria-label', `Signature style ${index + 1}`);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, name, index);
    button.appendChild(canvas);
    button.addEventListener('click', () => {
      state.selectedTypedStyle = index;
      renderTypedChoices();
    });
    container.appendChild(button);
  }
};

const selectSignatureMode = (mode) => {
  state.signatureMode = mode;
  $('chooseDraw').classList.toggle('active', mode === 'drawn');
  $('chooseType').classList.toggle('active', mode === 'typed');
  $('drawSignaturePanel').classList.toggle('hidden', mode !== 'drawn');
  $('typeSignaturePanel').classList.toggle('hidden', mode !== 'typed');
  if (mode === 'typed') renderTypedChoices();
};

const openSignatureSetup = (required = false) => {
  state.signatureRequired = required;
  $('closeSignatureSetup').classList.toggle('hidden', required);
  $('signatureSetupTitle').textContent = required ? 'Create your signature to continue' : 'Change your saved signature';
  $('signatureSetupHelp').textContent = required
    ? 'Choose how your signature should appear before opening the live document queue.'
    : 'The new signature will be used on documents you sign after it is saved.';
  $('typedSignatureName').value = state.user?.name || '';
  state.selectedTypedStyle = 0;
  show($('signatureSetupModal'));
  selectSignatureMode('drawn');
  configureProfileCanvas();
  clearProfileCanvas();
  setMessage($('profileSignatureMessage'), '');
};

$('profileButton').addEventListener('click', () => openSignatureSetup(false));
$('chooseDraw').addEventListener('click', () => selectSignatureMode('drawn'));
$('chooseType').addEventListener('click', () => selectSignatureMode('typed'));
$('typedSignatureName').addEventListener('input', renderTypedChoices);
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
  } else {
    const name = $('typedSignatureName').value.trim();
    if (!name) return setMessage($('profileSignatureMessage'), 'Type your name before choosing a style.', true);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, name, state.selectedTypedStyle);
    signatureData = canvas.toDataURL('image/png');
    styleName = `professional-${state.selectedTypedStyle + 1}`;
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
  setMessage($('signMessage'), '');
  show($('signModal'));
  try {
    await loadSavedSignature($('signingSignaturePreview'));
  } catch (error) {
    setMessage($('signMessage'), error.message, true);
  }
};

$('closeSign').addEventListener('click', () => hide($('signModal')));
$('changeSignatureFromSign').addEventListener('click', () => {
  hide($('signModal'));
  openSignatureSetup(false);
});
$('submitSig').addEventListener('click', async () => {
  if (!$('signatureConsent').checked) {
    return setMessage($('signMessage'), 'Confirm the electronic signature consent.', true);
  }
  try {
    const payload = await apiFetch(`/api/documents/${state.signingDocumentId}/sign`, {
      method: 'POST', body: JSON.stringify({ consent: true }),
    });
    hide($('signModal'));
    setMessage(docMessage, payload.message);
    await renderDocuments();
  } catch (error) {
    setMessage($('signMessage'), error.message, true);
  }
});

const initialize = async () => {
  const inviteEmail = new URLSearchParams(window.location.search).get('email');
  if (inviteEmail) $('registerEmail').value = inviteEmail;
  try {
    const setup = await apiFetch('/api/setup');
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
