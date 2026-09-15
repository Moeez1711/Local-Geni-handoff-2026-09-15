// In-memory recovery only. No notes are copied into browser storage.
const drafts = new Map(), writes = new Map();
export const getNoteDraft = id => drafts.get(id);
export function setNoteDraft(id, notes) { const draft = { notes }; drafts.set(id, draft); return draft; }
export function saveNoteDraft(id, write) {
  const draft = drafts.get(id), previous = writes.get(id);
  if (!draft) return Promise.resolve();
  if (previous?.draft === draft) return previous.promise;
  const promise = (previous?.promise || Promise.resolve()).catch(() => {}).then(() => write(id, draft.notes)).then(() => {
    if (drafts.get(id) === draft) drafts.delete(id);
  }).finally(() => { if (writes.get(id)?.promise === promise) writes.delete(id); });
  writes.set(id, { draft, promise });
  return promise;
}
