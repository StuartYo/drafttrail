import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Recorder, verify, replayAt, stats, diffOp, classify, chainHash, genesisHash, sha256Hex, sealOf } from '../src/core.js';

const load = n => JSON.parse(readFileSync(new URL(`../samples/${n}`, import.meta.url), 'utf8'));
const typed = () => load('sample-typed.json');

test('diffOp finds the smallest edit', () => {
  assert.deepEqual(diffOp('abc', 'abXc'), { p: 2, d: 0, s: 'X' });
  assert.deepEqual(diffOp('abc', 'ac'), { p: 1, d: 1, s: '' });
  assert.deepEqual(diffOp('hello world', 'hello brave world'), { p: 6, d: 0, s: 'brave ' });
  assert.deepEqual(diffOp('aaa', 'aa'), { p: 2, d: 1, s: '' });
  assert.deepEqual(diffOp('', 'hi'), { p: 0, d: 0, s: 'hi' });
});

test('classify keeps honest labels', () => {
  assert.equal(classify('insertFromPaste', { s: 'x', d: 0 }), 'paste');
  assert.equal(classify('insertFromDrop', { s: 'x', d: 0 }), 'paste');
  assert.equal(classify('deleteContentBackward', { s: '', d: 1 }), 'delete');
  assert.equal(classify('insertText', { s: 'a', d: 0 }), 'type');
  assert.equal(classify('insertReplacementText', { s: 'because', d: 7 }), 'other');
  assert.equal(classify('historyUndo', { s: '', d: 1 }), 'delete');
});

test('all three samples verify and rebuild their final text', async () => {
  for (const n of ['sample-typed.json', 'sample-pasted.json', 'sample-pasted-edited.json']) {
    const doc = load(n);
    const r = await verify(doc, doc.seal);
    assert.equal(r.ok, true, `${n}: ${r.reason}`);
    assert.equal(r.sealOk, true);
    assert.equal(r.text.length, doc.final.length);
  }
});

test('changing one event is caught at that exact event', async () => {
  const doc = typed();
  const k = 700;
  doc.events[k].s = doc.events[k].s === 'e' ? 'a' : 'e';
  const r = await verify(doc);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, k);
});

test('removing, reordering and truncating are caught', async () => {
  let doc = typed(); doc.events.splice(300, 1);
  let r = await verify(doc); assert.equal(r.ok, false); assert.equal(r.brokenAt, 300);
  doc = typed(); [doc.events[10], doc.events[11]] = [doc.events[11], doc.events[10]];
  r = await verify(doc); assert.equal(r.ok, false); assert.equal(r.brokenAt, 10);
  // truncating the tail keeps the chain valid but breaks the saved final text hash
  doc = typed(); doc.events.length = 1000;
  r = await verify(doc); assert.equal(r.ok, false); assert.equal(r.textHashOk, false);
});

test('a fully rebuilt chain passes alone but fails against the seal code', async () => {
  const doc = typed();
  const originalSeal = doc.seal;
  doc.events[50].s = 'Z';
  let prev = await genesisHash(doc.started);
  for (const e of doc.events) { e.h = await chainHash(prev, e); prev = e.h; }
  doc.final.textHash = await sha256Hex(replayAt(doc).text);
  const alone = await verify(doc);
  assert.equal(alone.ok, true, 'known limit: a forger who recomputes everything passes without the seal');
  const sealed = await verify(doc, originalSeal);
  assert.equal(sealed.ok, false);
  assert.equal(sealed.sealOk, false);
});

test('wrong format and garbage are refused', async () => {
  assert.equal((await verify({ hello: 1 })).ok, false);
  assert.equal((await verify(null)).ok, false);
});

test('stats tell the three scenarios apart', () => {
  const a = stats(load('sample-typed.json'));
  const b = stats(load('sample-pasted.json'));
  const c = stats(load('sample-pasted-edited.json'));
  assert.equal(a.pasteEvents, 0);
  assert.equal(a.pastedShare, 0);
  assert.ok(a.pauses > 10, 'typing has many pauses');
  assert.equal(b.pasteEvents, 1);
  assert.equal(b.pastedShare, 1);
  assert.equal(c.pasteEvents, 1);
  assert.ok(c.pastedShare > 0.9 && c.pastedShare < 1, `edited share ${c.pastedShare}`);
});

test('Recorder keeps order and handles non-Latin text and IME-style replacement', async () => {
  let clock = 0;
  const rec = new Recorder({ now: () => clock, started: '2026-01-01T00:00:00.000Z' });
  const steps = [['你', 'insertCompositionText'], ['你好', 'insertCompositionText'], ['你好嗎', 'insertCompositionText'], ['你好', 'deleteContentBackward'], ['你好, world', 'insertText']];
  for (const [v, t] of steps) { clock += 100; rec.record(v, t); }
  const doc = await rec.snapshot();
  assert.equal(replayAt(doc).text, '你好, world');
  assert.equal((await verify(doc)).ok, true);
  assert.equal(doc.events.length, 5);
});

test('resume continues the same chain', async () => {
  let clock = 0;
  const r1 = new Recorder({ now: () => clock, started: '2026-01-01T00:00:00.000Z' });
  clock += 50; r1.record('ab', 'insertText');
  clock += 50; r1.record('abc', 'insertText');
  const saved = await r1.snapshot();
  const r2 = new Recorder({ now: () => clock, doc: saved });
  clock += 500; r2.record('abcd', 'insertText');
  const doc = await r2.snapshot();
  assert.equal(doc.events.length, 3);
  assert.ok(doc.events[2].t > doc.events[1].t);
  assert.equal((await verify(doc)).ok, true);
  assert.equal(replayAt(doc).text, 'abcd');
});

test('seal format', () => { assert.equal(sealOf('abcdef0123456789', 7), 'ABCDEF012345-7'); });

test('moving own text is a move and keeps its colour; moving pasted text stays pasted', async () => {
  let clock = 0;
  const rec = new Recorder({ now: () => clock, started: '2026-01-01T00:00:00.000Z' });
  const step = (v, t) => { clock += 100; rec.record(v, t); };
  step('Mine. ', 'insertText');
  step('Mine. Outside words.', 'insertFromPaste');
  step('Mine. ', 'deleteByCut');
  step('Outside words.Mine. ', 'insertFromPaste'); // pasted back at the start
  const doc = await rec.snapshot();
  assert.deepEqual(doc.events.map(e => e.k), ['type', 'paste', 'delete', 'move']);
  const { text, origin } = replayAt(doc);
  assert.equal(text, 'Outside words.Mine. ');
  assert.equal(origin, 'p'.repeat(14) + 't'.repeat(6));
  assert.equal((await verify(doc)).ok, true);
  const s = stats(doc);
  assert.equal(s.pasteEvents, 1);
  assert.equal(s.moveEvents, 1);
});

test('a move whose text cannot be found is shown as other, not as typed', async () => {
  const doc = { format: 'drafttrail/1', started: 'x', events: [{ i: 0, t: 0, k: 'move', p: 0, d: 0, s: 'abc' }] };
  assert.equal(replayAt(doc).origin, 'ooo');
});

test('the three samples end with byte-identical text', async () => {
  const h = await Promise.all(['sample-typed.json', 'sample-pasted.json', 'sample-pasted-edited.json'].map(n => sha256Hex(replayAt(load(n)).text)));
  assert.equal(new Set(h).size, 1);
});
