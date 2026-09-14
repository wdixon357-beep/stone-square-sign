export async function renderAccessControls(root, api) {
  if (root.dirtyAccessKeys?.size) return;
  root.dirtyAccessKeys = new Set();
  root.replaceChildren();
  const message = document.createElement('p'); message.setAttribute('role', 'status'); root.append(message);
  try {
    const { capabilities, accounts } = await api('/api/admin/access');
    for (const account of accounts) {
      const panel = document.createElement('details'); panel.className = 'account-access';
      const title = document.createElement('summary'); title.textContent = `${account.name} · ${account.pending ? 'Invitation pending' : account.revoked ? 'Access revoked' : 'Active'}`; panel.append(title);
      const email = document.createElement('p'); email.textContent = account.email; panel.append(email);
      if (account.role === 'owner') { const note = document.createElement('p'); note.textContent = 'The Worshipful Master retains full access.'; panel.append(note); root.append(panel); continue; }
      const fieldset = document.createElement('fieldset'); fieldset.className = 'permission-grid';
      const legend = document.createElement('legend'); legend.textContent = 'Areas and actions available to this person'; fieldset.append(legend);
      for (const capability of capabilities) {
        const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
        input.type = 'checkbox'; input.value = capability.id; input.checked = account.permissions.includes(capability.id); text.textContent = capability.label; label.append(input, text); fieldset.append(label);
        if (['secretary','assistant_secretary','treasurer','assistant_treasurer','treasury_preparer','warden','officer'].includes(account.role) && ['minutes.view','treasury.view'].includes(capability.id)) { input.disabled = true; text.textContent += ' · Included for every officer'; }
      }
      fieldset.addEventListener('change', () => root.dirtyAccessKeys.add(account.key));
      const save = document.createElement('button'); save.type = 'button'; save.className = 'secondary'; save.textContent = 'Save access';
      const status = document.createElement('p'); status.setAttribute('role', 'status');
      save.addEventListener('click', async () => {
        save.disabled = true; fieldset.disabled = true; status.textContent = 'Saving access…';
        try { await api('/api/admin/access', { method: 'PUT', body: JSON.stringify({ key: account.key, permissions: [...fieldset.querySelectorAll('input:checked')].map(input => input.value) }) }); const refreshed = await api('/api/admin/access'); const saved = refreshed.accounts.find(item => item.key === account.key); if (saved) for (const input of fieldset.querySelectorAll('input')) input.checked = saved.permissions.includes(input.value); root.dirtyAccessKeys.delete(account.key); status.textContent = 'Access saved.'; }
        catch(error) { status.textContent = error.message || 'Access could not be saved.'; }
        finally { save.disabled = false; fieldset.disabled = false; }
      });
      panel.append(fieldset, save, status); root.append(panel);
    }
  } catch(error) { message.textContent = error.message || 'Officer access could not load.'; }
}
