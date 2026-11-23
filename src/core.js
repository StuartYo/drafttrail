// Drafttrail core: pure functions, no DOM. Runs in browsers and Node 20+.
export const FORMAT = 'drafttrail/1';
const enc = new TextEncoder();

export async function sha256Hex(str) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Smallest edit that turns prev into next (common prefix / suffix).
export function diffOp(prev, next) {
  let a = 0;
  const max = Math.min(prev.length, next.length);
  while (a < max && prev[a] === next[a]) a++;
  let b = 0;
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  return { p: a, d: prev.length - a - b, s: next.slice(a, next.length - b) };
}

// input event inputType -> event kind
export function classify(inputType, op) {
  const t = inputType || '';
  if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertFromYank' || t === 'insertFromPasteAsQuotation') return 'paste';
  if (t.startsWith('delete') && op.s === '') return 'delete';
  if (t === 'insertText' || t === 'insertLineBreak' || t === 'insertParagraph' || t === 'insertCompositionText' || t === 'insertFromComposition') return 'type';
  if (t.startsWith('delete')) return 'edit';
  // unknown source (spellcheck replacement, undo, script): keep an honest label
  if (op.s.length > 1 || op.d > 1) return 'other';
  return op.s === '' ? 'delete' : 'type';
}

export function eventPayload(e) {
  return JSON.stringify([e.i, e.t, e.k, e.p, e.d, e.s]);
}

export async function genesisHash(started) {
  return sha256Hex(`${FORMAT}|${started}`);
}

export async function chainHash(prev, e) {
  return sha256Hex(prev + '|' + eventPayload(e));
}

// Replay state: text, a parallel origin string (t typed, p pasted from outside, o other),
// and a small bin of recently removed text so a "move" can carry its origin along.
const BIN = 50;
export function newState() { return { text: '', origin: '', bin: [] }; }
function originForMove(st, s) {
  for (let k = st.bin.length - 1; k >= 0; k--) {
    const at = st.bin[k].s.indexOf(s);
    if (at >= 0) return st.bin[k].o.slice(at, at + s.length);
  }
  const at = st.text.indexOf(s);
  if (at >= 0) return st.origin.slice(at, at + s.length);
  return 'o'.repeat(s.length);
}
export function applyEvent(st, e) {
  const ins = e.s;
  let o;
  if (e.k === 'move') o = originForMove(st, ins);
  else o = (e.k === 'paste' ? 'p' : e.k === 'other' ? 'o' : 't').repeat(ins.length);
  if (e.d > 0) {
    st.bin.push({ s: st.text.slice(e.p, e.p + e.d), o: st.origin.slice(e.p, e.p + e.d) });
    if (st.bin.length > BIN) st.bin.shift();
  }
  st.text = st.text.slice(0, e.p) + ins + st.text.slice(e.p + e.d);
  st.origin = st.origin.slice(0, e.p) + o + st.origin.slice(e.p + e.d);
  return st;
}

export function replayAt(doc, n = doc.events.length) {
  const st = newState();
  const upto = Math.min(n, doc.events.length);
  for (let i = 0; i < upto; i++) applyEvent(st, doc.events[i]);
  return { text: st.text, origin: st.origin };
}

export function sealOf(head, n) {
  return `${head.slice(0, 12)}-${n}`.toUpperCase();
}
export function normSeal(s) { return String(s || '').trim().toUpperCase(); }

// Verify chain integrity, sequence, final text hash, and an optional seal code.
export async function verify(doc, sealCode) {
  const out = { ok: true, brokenAt: null, reason: '', events: doc?.events?.length ?? 0, textHashOk: null, sealOk: null };
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.events) || !doc.started) {
    return { ...out, ok: false, reason: 'This is not a Drafttrail recording (wrong format).' };
  }
  let prev = await genesisHash(doc.started);
  const st = newState(); let lastT = -1;
  for (let i = 0; i < doc.events.length; i++) {
    const e = doc.events[i];
    if (e.i !== i) return { ...out, ok: false, brokenAt: i, reason: `Event ${i + 1}: sequence number does not match its position.` };
    if (e.t < lastT) return { ...out, ok: false, brokenAt: i, reason: `Event ${i + 1}: timestamp goes backwards.` };
    lastT = e.t;
    const h = await chainHash(prev, e);
    if (h !== e.h) return { ...out, ok: false, brokenAt: i, reason: `Event ${i + 1}: its fingerprint does not match. This event, or one before it, was changed after recording.` };
    if (e.p < 0 || e.d < 0 || e.p + e.d > st.text.length) return { ...out, ok: false, brokenAt: i, reason: `Event ${i + 1}: the edit points outside the text.` };
    applyEvent(st, e);
    prev = h;
  }
  const text = st.text;
  const finalHash = await sha256Hex(text);
  out.textHashOk = !!doc.final && doc.final.textHash === finalHash;
  if (!out.textHashOk) { out.ok = false; out.reason = 'The text rebuilt from the events does not match the saved final text.'; }
  out.head = prev;
  out.seal = sealOf(prev, doc.events.length);
  if (sealCode) {
    out.sealOk = normSeal(sealCode) === out.seal;
    if (!out.sealOk) { out.ok = false; out.reason = out.reason || 'The seal code does not match this file. The file may have been rebuilt after the seal was handed out.'; }
  }
  out.text = text;
  return out;
}

// Recorder: turns text-box changes into a hash-chained event list.
export class Recorder {
  constructor({ now = () => performance.now(), started = new Date().toISOString(), doc = null } = {}) {
    this.now = now;
    this.queue = Promise.resolve();
    if (doc) {
      this.doc = structuredClone(doc);
      this.text = replayAt(doc).text;
      const last = doc.events.length ? doc.events[doc.events.length - 1] : null;
      this.prevHash = last ? last.h : null;
      this.t0 = now() - (last ? last.t + 1000 : 0);
    } else {
      this.doc = { format: FORMAT, started, meta: {}, events: [], final: null };
      this.text = '';
      this.prevHash = null;
      this.t0 = now();
    }
    this.seq = this.doc.events.length;
    this.bin = [];
  }
  // Call from the input handler with the new full value. Ordering is kept by a promise queue.
  record(nextText, inputType) {
    const op = diffOp(this.text, nextText);
    if (op.d === 0 && op.s === '') return;
    const t = Math.round(this.now() - this.t0);
    let k = classify(inputType, op);
    // Pasting text that already sits in this draft, or was cut from it, is a move, not an outside paste.
    // Replay looks the text up again and keeps its original colour, so moving pasted text cannot hide it.
    if (k === 'paste' && op.s && (this.text.includes(op.s) || this.bin.some(b => b.includes(op.s)))) k = 'move';
    if (op.d > 0) { this.bin.push(this.text.slice(op.p, op.p + op.d)); if (this.bin.length > 50) this.bin.shift(); }
    this.text = nextText;
    const e = { i: this.seq++, t, k, p: op.p, d: op.d, s: op.s };
    this.queue = this.queue.then(async () => {
      if (this.prevHash === null) this.prevHash = await genesisHash(this.doc.started);
      e.h = await chainHash(this.prevHash, e);
      this.prevHash = e.h;
      this.doc.events.push(e);
    });
  }
  async snapshot() {
    await this.queue;
    const doc = structuredClone(this.doc);
    doc.final = { length: this.text.length, textHash: await sha256Hex(replayAt(doc).text) };
    const head = doc.events.length ? doc.events[doc.events.length - 1].h : await genesisHash(doc.started);
    doc.seal = sealOf(head, doc.events.length);
    return doc;
  }
}

// Plain-number summary of a recording. Descriptive only, never a verdict.
export function stats(doc, { pauseMs = 2000, burstWindowMs = 2000 } = {}) {
  const ev = doc.events;
  const { text, origin } = replayAt(doc);
  const count = k => ev.filter(e => e.k === k).length;
  const pastes = ev.filter(e => e.k === 'paste' && e.s.length > 0);
  const pastedChars = pastes.reduce((n, e) => n + e.s.length, 0);
  const typed = ev.filter(e => e.k === 'type');
  const typedChars = typed.reduce((n, e) => n + e.s.length, 0);
  const survivingPaste = [...origin].filter(c => c === 'p').length;
  let pauses = 0, activeMs = 0, longest = 0;
  for (let i = 1; i < ev.length; i++) {
    const gap = ev[i].t - ev[i - 1].t;
    if (gap >= pauseMs) pauses++; else activeMs += gap;
    if (gap > longest) longest = gap;
  }
  const spanMs = ev.length ? ev[ev.length - 1].t - ev[0].t : 0;
  let burst = 0, lo = 0, run = 0;
  for (let hi = 0; hi < typed.length; hi++) {
    run += typed[hi].s.length;
    while (typed[hi].t - typed[lo].t > burstWindowMs) { run -= typed[lo].s.length; lo++; }
    if (run > burst) burst = run;
  }
  const removed = ev.reduce((n, e) => n + e.d, 0);
  return {
    events: ev.length, finalChars: text.length, words: (text.match(/\S+/g) || []).length,
    typedEvents: typed.length, deleteEvents: count('delete'), pasteEvents: pastes.length, moveEvents: count('move'), otherEvents: count('other') + count('edit'),
    typedChars, pastedChars, survivingPastedChars: survivingPaste,
    pastedShare: text.length ? survivingPaste / text.length : 0,
    largestPaste: pastes.reduce((m, e) => Math.max(m, e.s.length), 0),
    pauses, longestPauseMs: longest, spanMs, activeMs,
    typedCharsPerMin: activeMs > 0 ? Math.round(typedChars / (activeMs / 60000)) : 0,
    fastestBurstChars: burst,
    removedChars: removed,
    revisionShare: typedChars + pastedChars ? removed / (typedChars + pastedChars) : 0,
  };
}

// Sentences for a human reader. Descriptive wording only.
export function describe(s) {
  if (s.events === 0) return ['No events recorded.'];
  const pct = Math.round(s.pastedShare * 100);
  const lines = [];
  if (s.pasteEvents === 0) lines.push('No paste events: every character was entered by typing.');
  else if (pct >= 50) lines.push(`${pct}% of the final text arrived by paste (${s.pasteEvents} paste event${s.pasteEvents > 1 ? 's' : ''}, largest ${s.largestPaste} characters).`);
  else lines.push(`${s.pasteEvents} paste event${s.pasteEvents > 1 ? 's' : ''}; ${pct}% of the final text came from pasting.`);
  if (s.moveEvents) lines.push(`${s.moveEvents} time${s.moveEvents > 1 ? 's' : ''} the writer moved or copied text that was already in the draft. Moved text keeps the colour it had before.`);
  lines.push(`${s.pauses} pause${s.pauses === 1 ? '' : 's'} of 2 seconds or more. About ${Math.round(s.revisionShare * 100)} characters were removed for every 100 added.`);
  return lines;
}
