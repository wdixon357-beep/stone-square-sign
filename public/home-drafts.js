const issueList = (issues, open) => {
  const list = document.createElement('ul');
  for (const {label,target} of issues) {
    const item = document.createElement('li');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'home-draft-link';
    link.textContent = label;
    link.addEventListener('click', () => open(target));
    item.append(link);
    list.append(item);
  }
  return list;
};

export function renderHomeDraftCards(list, entries, onOpen) {
  list.replaceChildren();
  for (const entry of entries) {
    const open = target => onOpen(entry, target);
    const card = document.createElement('article');
    card.className = 'home-draft-card';
    const header = document.createElement('div');
    header.className = 'home-draft-card-header';
    const heading = document.createElement('h3');
    heading.textContent = entry.title;
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'secondary small';
    resume.textContent = 'Continue draft';
    resume.setAttribute('aria-label', `Continue draft: ${entry.title}`);
    resume.addEventListener('click', () => open(entry.issues[0]?.target));
    header.append(heading, resume);
    card.append(header);
    const info = document.createElement('p');
    info.className = 'helper home-draft-meta';
    info.textContent = [entry.savedLabel, entry.workingLabel].filter(Boolean).join(' · ');
    if (info.textContent) card.append(info);
    if (entry.issues.length) {
      card.append(issueList(entry.issues.slice(0,3), open));
      if (entry.issues.length > 3) {
        const more = document.createElement('details');
        const summary = document.createElement('summary');
        const remaining = entry.issues.length - 3;
        summary.textContent = `Show ${remaining} more ${remaining === 1 ? 'item' : 'items'}`;
        more.append(summary, issueList(entry.issues.slice(3), open));
        card.append(more);
      }
    } else {
      const note = document.createElement('p');
      note.className = 'helper';
      note.textContent = entry.readyLabel;
      card.append(note);
    }
    list.append(card);
  }
}
