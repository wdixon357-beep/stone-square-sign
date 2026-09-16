export function clearCollectionReviewEvidence(draft, collection) {
  if (!draft) return;
  if (draft.fieldReviews) for (const path of Object.keys(draft.fieldReviews)) if (path.startsWith(`${collection}.`)) delete draft.fieldReviews[path];
  draft.extractionNotes = (draft.extractionNotes || [])
    .flatMap(note => String(note).split('\n').filter(line => !line.includes(`Source evidence: ${collection}[`)))
    .filter(Boolean);
}
