// Generates the three SAMPLE recordings in /samples. They are simulated by this script
// (seeded random timing), not recorded from a person. Each file says so in meta.simulated.
import { Recorder } from '../src/core.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ESSAY = `The tram stops outside the fish market at six in the morning, and that is when the street is most honest. Crates are stacked higher than the people carrying them. Nobody is selling anything yet, so the vendors argue about football and about whose turn it is to hose down the floor.

I used to think the market was loud because it was cheap. After a few months of walking through it on the way to class, I changed my mind. It is loud because everyone there has to trust a stranger within about ten seconds. A buyer cannot test the fish. She looks at the eyes, the gills, and the face of the person selling it, then decides.

That habit of reading a person quickly has followed me into other places. In my seminar, the quiet students are not the ones with nothing to say. They are checking whether the room will take a half-finished idea seriously. When it does, they speak, and the idea usually turns out better than the confident ones.

Writing in a second language feels the same. Every sentence is a small bet that the reader will give me the benefit of the doubt. I choose plain words because they are the ones I am sure of, and I have learned that sure words are not the same as simple thoughts.

So when I imagine the people who will read this, I picture the vendor wiping her hands on her apron and looking up. She does not need a perfect sentence. She needs to know that what I am handing her is what it appears to be, and that I made it myself.`;

// The same four word changes are made in the typed and the pasted-then-edited runs, and the
// one-shot paste uses the already-edited text, so all three samples end with byte-identical text.
export const SWAPS = [['honest', 'truthful'], ['cheap', 'inexpensive'], ['a half-finished', 'an unfinished'], ['looking up', 'glancing up']];
export const FINAL = SWAPS.reduce((t, [f, r]) => t.replace(f, r), ESSAY);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

async function simulate({ seed, mode, startedISO }) {
  const rand = rng(seed);
  let clock = 0;
  const rec = new Recorder({ now: () => clock, started: startedISO });
  let value = '';
  const push = (next, type) => { rec.record(next, type); value = next; };
  const wait = ms => { clock += Math.round(ms); };
  const typeText = (text, speed = 1) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/[a-z]/.test(ch) && rand() < 0.025) { // typo, notice, fix
        push(value + 'qwertyuiopasdfghjklzxcvbnm'[Math.floor(rand() * 26)], 'insertText');
        wait(160 + rand() * 200);
        push(value.slice(0, -1), 'deleteContentBackward');
        wait(120 + rand() * 120);
      }
      push(value + ch, ch === '\n' ? 'insertLineBreak' : 'insertText');
      wait((75 + rand() * 120) * speed);
      if (/[.?!]/.test(ch) && rand() < 0.7) wait(1500 + rand() * 4500);
      else if (ch === ',' && rand() < 0.4) wait(600 + rand() * 900);
    }
  };
  const swap = (from, to) => {
    const at = value.indexOf(from);
    if (at < 0) return;
    wait(1800 + rand() * 2500);
    let v = value;
    for (let k = from.length; k > 0; k--) { v = v.slice(0, at + k - 1) + v.slice(at + k); push(v, 'deleteContentBackward'); wait(100 + rand() * 40); }
    for (let k = 0; k < to.length; k++) { v = v.slice(0, at + k) + to[k] + v.slice(at + k); push(v, 'insertText'); wait(90 + rand() * 80); }
  };
  if (mode === 'typed') {
    wait(1200);
    typeText(ESSAY);
    wait(6000);
    for (const [f, t] of SWAPS) swap(f, t);
  } else if (mode === 'pasted') {
    wait(4300);
    push(FINAL, 'insertFromPaste');
  } else if (mode === 'pasted-edited') {
    wait(4300);
    push(ESSAY, 'insertFromPaste');
    wait(9000);
    for (const [f, t] of SWAPS) swap(f, t);
  }
  const doc = await rec.snapshot();
  doc.meta = {
    simulated: true,
    label: 'SAMPLE: simulated by scripts/gen-samples.mjs, not written by a person',
    scenario: mode,
  };
  return doc;
}

const specs = [
  ['sample-typed.json', { seed: 11, mode: 'typed', startedISO: '2026-11-25T09:00:00.000Z' }],
  ['sample-pasted.json', { seed: 22, mode: 'pasted', startedISO: '2026-11-25T09:30:00.000Z' }],
  ['sample-pasted-edited.json', { seed: 33, mode: 'pasted-edited', startedISO: '2026-11-25T10:00:00.000Z' }],
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, spec] of specs) {
    const doc = await simulate(spec);
    writeFileSync(path.join(here, '..', 'samples', name), JSON.stringify(doc));
    console.log(name, doc.events.length, 'events', doc.seal);
  }
}
