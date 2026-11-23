// Builds results/results.json: every number quoted in the README and the submission comes from here.
// Run: node scripts/results.mjs   (run `npm run e2e` first to refresh the browser numbers)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, replayAt, stats, sha256Hex } from '../src/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = n => JSON.parse(readFileSync(path.join(root, 'samples', n), 'utf8'));
const names = { typed: 'sample-typed.json', pasted: 'sample-pasted.json', pastedEdited: 'sample-pasted-edited.json' };
const out = { generatedAt: new Date().toISOString(), note: 'Samples are simulated by scripts/gen-samples.mjs (seeded), not written by a person.', samples: {}, textOnly: {}, tamper: {} };

for (const [k, n] of Object.entries(names)) {
  const doc = load(n), s = stats(doc);
  out.samples[k] = {
    file: n, events: s.events, words: s.words, finalChars: s.finalChars, finalTextSha256: await sha256Hex(replayAt(doc).text),
    pasteEvents: s.pasteEvents, largestPaste: s.largestPaste, pastedSharePct: Math.round(s.pastedShare * 1000) / 10,
    typedEvents: s.typedEvents, deleteEvents: s.deleteEvents, pauses2s: s.pauses, removedPer100Added: Math.round(s.revisionShare * 100),
    spanSeconds: Math.round(s.spanMs / 1000), seal: doc.seal,
  };
}
const hashes = Object.values(out.samples).map(x => x.finalTextSha256);
out.textOnly = {
  identicalFinalText: new Set(hashes).size === 1,
  meaning: 'Any checker that only reads the finished essay (an AI detector, a language model, a teacher reading it) gets the same input for all three samples, so it must give all three the same answer.',
};

// Tamper test: random single-field edits to the typed sample. Fixed seed so the run repeats.
let seed = 7;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const base = load(names.typed);
const fields = ['s', 't', 'k', 'p', 'd'];
let tries = 0, caught = 0, caughtAtExactEvent = 0;
const times = [];
const t0 = performance.now();
while (tries < 300) {
  const doc = structuredClone(base);
  const i = Math.floor(rand() * doc.events.length), f = fields[Math.floor(rand() * fields.length)], e = doc.events[i];
  if (f === 's') e.s = e.s + 'x'; else if (f === 'k') e.k = e.k === 'paste' ? 'type' : 'paste'; else e[f] = e[f] + 1;
  tries++;
  const ts = performance.now();
  const r = await verify(doc);
  times.push(performance.now() - ts);
  if (!r.ok) { caught++; if (r.brokenAt === i) caughtAtExactEvent++; }
}
const ms = performance.now() - t0;
times.sort((a, b) => a - b);
out.tamper = { edits: tries, caught, caughtAtExactEvent, avgVerifyMs: Math.round(ms / tries), medianVerifyMs: Math.round(times[Math.floor(times.length / 2)]), eventsPerFile: base.events.length, timingNote: 'Wall-clock time in Node on the dev laptop; varies with machine load. The median is the figure quoted.' };

// Relabel the paste in the one-shot sample as typing (the obvious cheat).
const cheat = load(names.pasted); cheat.events[0].k = 'type';
const rc = await verify(cheat);
out.tamper.relabelPasteAsTyped = { caught: !rc.ok, reason: rc.reason };

// Full rebuild (recompute every fingerprint) passes without the seal code, fails with it.
const rebuilt = load(names.typed); const seal = rebuilt.seal;
rebuilt.events[50].s = 'Z';
const { genesisHash, chainHash } = await import('../src/core.js');
let prev = await genesisHash(rebuilt.started);
for (const e of rebuilt.events) { e.h = await chainHash(prev, e); prev = e.h; }
rebuilt.final.textHash = await sha256Hex(replayAt(rebuilt).text);
out.tamper.fullRebuild = { passesWithoutSeal: (await verify(rebuilt)).ok, passesWithOriginalSeal: (await verify(rebuilt, seal)).ok };

const e2e = path.join(root, 'results', 'browser-e2e.json');
if (existsSync(e2e)) out.browser = JSON.parse(readFileSync(e2e, 'utf8'));
const before = path.join(root, 'results', 'browser-e2e.run1-before-fix.json');
if (existsSync(before)) {
  const b = JSON.parse(readFileSync(before, 'utf8'));
  out.iteration = {
    found: 'First browser run: a writer who cut one of their own sentences and pasted it elsewhere was shown with part of the essay "pasted".',
    beforeFixPastedSharePct: Math.round(b.scenarios['writer moves own sentence (cut, paste)'].pastedShareSeen * 1000) / 10,
    afterFixPastedSharePct: out.browser?.scenarios['writer moves own sentence (cut, paste)']?.pastedSharePct ?? null,
    change: 'Pastes of text that is already in the draft, or was cut from it, are now recorded as a "move" and keep their original colour. Pasted text that is cut and moved stays marked as pasted.',
  };
}
writeFileSync(path.join(root, 'results', 'results.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ textOnly: out.textOnly.identicalFinalText, tamper: out.tamper, iteration: out.iteration }, null, 1));
