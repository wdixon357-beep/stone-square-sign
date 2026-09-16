import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [models, views, creator, updater] = await Promise.all([
  readFile(new URL('../macos/Sources/StoneSquareSign/Models.swift', import.meta.url), 'utf8'),
  readFile(new URL('../macos/Sources/StoneSquareSign/Views.swift', import.meta.url), 'utf8'),
  readFile(new URL('../macos/Sources/StoneSquareSign/AgendaCreator.swift', import.meta.url), 'utf8'),
  readFile(new URL('../macos/Sources/StoneSquareSign/AppUpdater.swift', import.meta.url), 'utf8'),
]);

assert.match(models, /enum AppSection:[^\n]*\bcase[^\n]*\bagenda\b/);
assert.match(models, /case \.agenda: return role == "owner"/);
assert.match(views, /Label\("Agenda Creator", systemImage:/);
assert.match(views, /AgendaCreatorView\(workspace: agendaWorkspace\)/);
assert.match(creator, /HSplitView/);
assert.match(creator, /\/api\/agendas/);
assert.match(creator, /LodgeDocumentPreview\(data: workspace\.pdf\)/);
assert.match(creator, /Button\("Save Draft"\)/);
assert.match(creator, /Button\("Resume Draft"\)/);
assert.match(creator, /Unsaved changes/);
assert.match(creator, /Last saved/);
assert.match(updater, /Save or discard your Agenda Creator edits before updating/);
console.log('Native Agenda Creator checks passed: owner-only route, persistent save and resume controls, native layout, shared service, PDF preview and update guard.');
