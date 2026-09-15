import test from 'node:test';
import assert from 'node:assert/strict';
import { getNoteDraft, setNoteDraft, saveNoteDraft } from './noteDrafts.js';

test('closing before the debounce flushes the current draft only once', async () => {
  const calls = []; setNoteDraft('flush', 'A useful conversation');
  const write = async (id, notes) => calls.push([id, notes]);
  await Promise.all([saveNoteDraft('flush', write), saveNoteDraft('flush', write)]);
  assert.deepEqual(calls, [['flush', 'A useful conversation']]); assert.equal(getNoteDraft('flush'), undefined);
});
test('a slow old save cannot overwrite newer notes from a reopened panel', async () => {
  let release; const calls = [];
  setNoteDraft('serial', 'old');
  const first = saveNoteDraft('serial', async (_, text) => { calls.push(text); await new Promise(resolve => { release = resolve; }); });
  await new Promise(resolve => setImmediate(resolve));
  setNoteDraft('serial', 'new'); const second = saveNoteDraft('serial', async (_, text) => calls.push(text));
  assert.deepEqual(calls, ['old']); release(); await first; await second;
  assert.deepEqual(calls, ['old', 'new']); assert.equal(getNoteDraft('serial'), undefined);
});
test('failed notes remain available to reopen and retry in the same page session', async () => {
  setNoteDraft('failed', 'Keep this draft');
  await assert.rejects(saveNoteDraft('failed', async () => { throw new Error('offline'); }));
  assert.equal(getNoteDraft('failed').notes, 'Keep this draft');
  await saveNoteDraft('failed', async () => {}); assert.equal(getNoteDraft('failed'), undefined);
});
