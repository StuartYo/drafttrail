import { Recorder, verify, replayAt, stats, describe, sha256Hex } from './core.js';

const $ = id => document.getElementById(id);
const SAMPLES = {
  'sample-typed.json': 'Typed by hand',
  'sample-pasted.json': 'Pasted in one go',
  'sample-pasted-edited.json': 'Pasted, then edited',
};
const DRAFT_KEY = 'drafttrail:draft';
let rec = new Recorder();
let current = null;       // doc shown in Replay
let currentName = '';
let verifyDoc = null;
let playTimer = null;

/* ---------- tabs ---------- */
const TABS = ['write', 'replay', 'compare', 'verify'];
function show(name) {
  for (const t of TABS) {
    $('view-' + t).hidden = t !== name;
    $('tab-' + t).setAttribute('aria-selected', String(t === name));
  }
  if (name !== 'replay') stopPlay();
  if (name === 'replay' && (!current || currentName === 'Your draft') && rec.seq > 0 && current?.events?.length !== rec.seq) { refreshSeal().then(d => openReplay(d, 'Your draft')); return; }
  if (name === 'compare') renderCompare();
}
for (const t of TABS) $('tab-' + t).addEventListener('click', () => show(t));
$('go-compare').addEventListener('click', () => show('compare'));

/* ---------- helpers ---------- */
const fmt = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function loadSample(name) {
  try {
    const r = await fetch('samples/' + name);
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch {
    alert('The sample could not be loaded. Open this page through a web address (not as a local file) and try again.');
    return null;
  }
}

/* ---------- WRITE ---------- */
const editor = $('editor');
let saveTimer = null, liveTimer = null;
function counters() {
  const ev = rec.doc.events;
  $('live-events').textContent = rec.seq;
  $('live-chars').textContent = rec.text.length;
  let p = 0; for (const e of ev) if (e.k === 'paste') p++;
  $('live-pastes').textContent = p;
  const has = rec.seq > 0;
  for (const id of ['save', 'open-replay', 'copy-seal', 'reset']) $(id).disabled = !has;
  $('rec-actions').hidden = !has; $('rec-empty').hidden = has;
}
async function refreshSeal() {
  const snap = await rec.snapshot();
  $('live-seal').textContent = rec.seq ? snap.seal : '-';
  counters();
  return snap;
}
editor.addEventListener('input', ev => {
  rec.record(editor.value, ev.inputType);
  counters();
  clearTimeout(liveTimer); liveTimer = setTimeout(refreshSeal, 300);
  clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 1200);
});
async function autosave() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(await rec.snapshot())); } catch { /* storage full or blocked */ }
}
$('save').addEventListener('click', async () => {
  const doc = await refreshSeal();
  doc.meta = { tool: 'Drafttrail', simulated: false };
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `drafttrail-${d.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  $('save-note').textContent = `Saved. Your seal code is ${doc.seal}. Send it to your reader in a separate message from the file.`;
});
$('copy-seal').addEventListener('click', async () => {
  const snap = await refreshSeal();
  try { await navigator.clipboard.writeText(snap.seal); $('save-note').textContent = `Copied ${snap.seal}.`; }
  catch { $('save-note').textContent = `Could not copy automatically. Your seal code is ${snap.seal}.`; }
});
$('open-replay').addEventListener('click', async () => { openReplay(await refreshSeal(), 'Your draft'); });
$('reset').addEventListener('click', () => {
  if (rec.seq && !confirm('Start over? Save the recording first if you want to keep it.')) return;
  rec = new Recorder(); editor.value = ''; localStorage.removeItem(DRAFT_KEY);
  $('live-seal').textContent = '-'; counters();
});
window.addEventListener('beforeunload', e => { if (rec.seq > 0) { e.preventDefault(); } });
try {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved.events?.length) {
      $('resume-bar').hidden = false;
      $('resume-text').textContent = `An unfinished draft was found in this browser (${saved.events.length} events, ${saved.final?.length ?? 0} characters).`;
      $('resume-yes').onclick = () => {
        rec = new Recorder({ doc: saved }); editor.value = rec.text; $('resume-bar').hidden = true; refreshSeal();
      };
      $('resume-no').onclick = () => { localStorage.removeItem(DRAFT_KEY); $('resume-bar').hidden = true; };
    }
  }
} catch { /* ignore */ }

/* ---------- REPLAY ---------- */
let pos = 0;
function openReplay(doc, name) {
  stopPlay();
  current = doc; currentName = name; pos = doc.events.length;
  $('replay-empty').hidden = true; $('replay-main').hidden = false;
  $('replay-title').textContent = `Replay: ${name}`;
  $('sim-banner').hidden = !doc.meta?.simulated;
  const s = stats(doc);
  $('scrub').max = doc.events.length; $('scrub').value = 0;
  $('plain').innerHTML = describe(s).map(l => `<li>${esc(l)}</li>`).join('');
  $('stats').innerHTML = [
    ['Words in final text', s.words], ['Typing events', s.typedEvents], ['Paste events', s.pasteEvents],
    ['Largest paste (characters)', s.largestPaste], ['Share of final text pasted', Math.round(s.pastedShare * 100) + '%'],
    ['Pauses of 2 s or more', s.pauses], ['Typing speed (characters per minute)', s.activeMs >= 10000 && s.typedCharsPerMin ? s.typedCharsPerMin : 'n/a'],
    ['Longest pause', fmt(s.longestPauseMs)], ['Total span', fmt(s.spanMs)],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  $('axis-end').textContent = fmt(s.spanMs);
  drawTimeline($('timeline'), doc, 1000, 96);
  render();
  show('replay');
}
function render() {
  const doc = current; if (!doc) return;
  const { text, origin } = replayAt(doc, pos);
  const last = pos ? doc.events[pos - 1] : null;
  const caretAt = last ? Math.min(text.length, last.p + last.s.length) : 0;
  const piece = (from, to) => {
    let html = '', i = from;
    while (i < to) {
      let j = i; while (j < to && origin[j] === origin[i]) j++;
      const seg = esc(text.slice(i, j));
      html += origin[i] === 't' ? seg : `<mark class="${origin[i]}">${seg}</mark>`;
      i = j;
    }
    return html;
  };
  const box = $('replay-text');
  box.innerHTML = piece(0, caretAt) + '<span class="caret"></span>' + piece(caretAt, text.length);
  const caret = box.querySelector('.caret');
  const top = caret.offsetTop;
  if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = Math.max(0, top - box.clientHeight / 2);
  $('scrub').value = pos;
  const t = pos ? doc.events[pos - 1].t : 0;
  $('clock').textContent = `Event ${pos} of ${doc.events.length}   |   time ${fmt(t)}`;
  const x = doc.events.length ? (t / Math.max(1, doc.events[doc.events.length - 1].t)) * 1000 : 0;
  const cur = $('timeline').querySelector('.cursor');
  if (cur) { cur.setAttribute('x1', x); cur.setAttribute('x2', x); }
}
function drawTimeline(svg, doc, w, h) {
  const ev = doc.events, end = Math.max(1, ev.length ? ev[ev.length - 1].t : 1);
  let g = `<line x1="0" x2="${w}" y1="${h * 0.62}" y2="${h * 0.62}" stroke="#d9d5c8"/>`;
  for (const e of ev) {
    const x = (e.t / end) * w;
    if (e.k === 'paste') {
      const hh = Math.min(h * 0.55, 10 + Math.log10(e.s.length + 1) * 14);
      g += `<rect x="${x - 3}" y="${h * 0.62 - hh}" width="6" height="${hh}" fill="#a84a08"/>`;
    } else if (e.k === 'move' || e.k === 'other') g += `<line x1="${x}" x2="${x}" y1="${h * 0.62 - 16}" y2="${h * 0.62 + 16}" stroke="#66756f" stroke-width="1.5"/>`;
    else if (e.k === 'delete' || e.k === 'edit') g += `<line x1="${x}" x2="${x}" y1="${h * 0.62}" y2="${h * 0.62 + 12}" stroke="#16211d" stroke-width="1"/>`;
    else g += `<line x1="${x}" x2="${x}" y1="${h * 0.62}" y2="${h * 0.62 - 12}" stroke="#0e6b57" stroke-width="1"/>`;
  }
  svg.innerHTML = g + `<line class="cursor" x1="0" x2="0" y1="0" y2="${h}" stroke="#16211d" stroke-width="1.5" stroke-dasharray="4 3"/>`;
}
$('scrub').addEventListener('input', e => { stopPlay(); pos = +e.target.value; render(); });
$('timeline').addEventListener('click', e => {
  if (!current) return;
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * Math.max(1, current.events[current.events.length - 1].t);
  let n = 0; while (n < current.events.length && current.events[n].t <= t) n++;
  stopPlay(); pos = n; render();
});
$('next-paste').addEventListener('click', () => {
  if (!current) return; stopPlay();
  const from = pos; let n = current.events.findIndex((e, i) => i >= from && e.k === 'paste');
  if (n < 0) n = current.events.findIndex(e => e.k === 'paste');
  if (n < 0) { $('clock').textContent = 'This recording has no paste events.'; return; }
  pos = n + 1; render();
});
function stopPlay() { clearTimeout(playTimer); playTimer = null; $('play').textContent = 'Play'; }
function step() {
  if (!current || pos >= current.events.length) { stopPlay(); return; }
  const speed = +$('speed').value;
  const prevT = pos ? current.events[pos - 1].t : 0;
  pos++;
  render();
  if (pos >= current.events.length) { stopPlay(); return; }
  const gap = Math.min(current.events[pos].t - current.events[pos - 1].t, 1200);
  playTimer = setTimeout(step, Math.max(4, gap / speed));
}
$('play').addEventListener('click', () => {
  if (playTimer) { stopPlay(); return; }
  if (pos >= current.events.length) pos = 0;
  $('play').textContent = 'Pause';
  step();
});
for (const b of document.querySelectorAll('.sample')) {
  b.addEventListener('click', async () => {
    const name = b.dataset.sample, doc = await loadSample(name);
    if (doc) openReplay(doc, SAMPLES[name]);
  });
}

/* ---------- COMPARE ---------- */
let compareDone = false;
async function renderCompare() {
  if (compareDone) return;
  const grid = $('compare-grid'); grid.innerHTML = '<p>Loading samples...</p>';
  const docs = [];
  for (const name of Object.keys(SAMPLES)) { const d = await loadSample(name); if (!d) return; docs.push([name, d]); }
  grid.innerHTML = '';
  const prints = await Promise.all(docs.map(([, d]) => sha256Hex(replayAt(d).text)));
  const same = new Set(prints).size === 1;
  const first = stats(docs[0][1]);
  $('compare-lede').textContent = same
    ? `All three end with the same ${first.words} words, byte for byte (text fingerprint ${prints[0].slice(0, 12)}). A checker that reads only the finished essay, whether an AI detector, a language model or a teacher, gets identical input three times and has to give the same answer. The recordings below are what tells them apart.`
    : 'The three samples end with different text.';
  docs.forEach(([name, doc], k) => {
    const s = stats(doc);
    const el = document.createElement('div'); el.className = 'pane';
    el.innerHTML = `<h3>${SAMPLES[name]}</h3><div class="big"><span class="num">${Math.round(s.pastedShare * 100)}%</span><span class="unit">of the final text pasted</span></div><div class="sub">${s.pasteEvents} paste event${s.pasteEvents === 1 ? '' : 's'}, ${s.pauses} pause${s.pauses === 1 ? '' : 's'} of 2 s or more, ${fmt(s.spanMs)} of writing</div><svg viewBox="0 0 400 64" preserveAspectRatio="none" id="cmp-${k}" role="img" aria-label="Timeline for ${SAMPLES[name]}"></svg>
      <table class="stats">
      <tr><td>Typing events</td><td>${s.typedEvents}</td></tr>
      <tr><td>Pauses of 2 s or more</td><td>${s.pauses}</td></tr>
      <tr><td>Characters removed per 100 added</td><td>${Math.round(s.revisionShare * 100)}</td></tr>
      <tr><td>Total span</td><td>${fmt(s.spanMs)}</td></tr>
      <tr class="same"><td>Final text fingerprint${same ? ' <span class="tag">same in all three</span>' : ''}</td><td>${prints[k].slice(0, 12)}</td></tr></table>
      <div class="actions"><button class="btn" data-open="${name}">Replay this one</button></div>`;
    grid.appendChild(el);
    drawTimeline(el.querySelector('svg'), doc, 400, 64);
    el.querySelector('[data-open]').onclick = () => openReplay(doc, SAMPLES[name]);
  });
  compareDone = true;
}

/* ---------- VERIFY ---------- */
function showResult(res, name) {
  const box = $('result');
  if (res.ok) {
    box.className = 'result good';
    box.innerHTML = `<strong>Intact</strong>${res.events} events chain together correctly, and the rebuilt text matches the saved final text.${res.sealOk ? ' The seal code matches.' : ''}<div class="mono">Seal of this file: ${res.seal}</div>`;
  } else {
    box.className = 'result bad';
    box.innerHTML = `<strong>Does not verify</strong>${esc(res.reason)}${res.brokenAt != null ? `<div class="mono">First bad event: ${res.brokenAt + 1} of ${res.events}</div>` : ''}`;
  }
  $('result-replay').hidden = !verifyDoc?.events;
  $('result-replay').textContent = 'Replay this file';
  $('result-replay').onclick = () => openReplay(verifyDoc, name || 'Loaded file');
}
async function runVerify(name) {
  if (!verifyDoc) return;
  showResult(await verify(verifyDoc, $('seal-in').value), name);
}
async function takeFile(file) {
  try {
    verifyDoc = JSON.parse(await file.text());
    $('verify-btn').disabled = false;
    await runVerify(file.name);
  } catch {
    verifyDoc = null;
    $('result').className = 'result bad';
    $('result').innerHTML = '<strong>Could not read the file</strong>It is not valid JSON. Choose a recording saved by Drafttrail.';
  }
}
$('file').addEventListener('change', e => e.target.files[0] && takeFile(e.target.files[0]));
$('verify-btn').addEventListener('click', () => runVerify());
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && takeFile(e.dataTransfer.files[0]); });
$('tamper').addEventListener('click', async () => {
  const doc = await loadSample('sample-typed.json'); if (!doc) return;
  const k = Math.floor(doc.events.length / 2);
  const e = doc.events[k];
  // change what one event says it typed (the kind of edit someone would make to hide a paste)
  e.s = e.s === 'e' ? 'a' : 'e';
  verifyDoc = doc;
  $('verify-btn').disabled = false;
  await runVerify('Sample with event ' + (k + 1) + ' changed');
  $('result').insertAdjacentHTML('beforeend', `<div class="sample-note">SAMPLE: event ${k + 1} of the simulated typed sample was changed by this button.</div>`);
});

/* test hook: lets automated tests read the live recorder without exporting */
window.__drafttrail = { get recorder() { return rec; }, refreshSeal };
counters();
