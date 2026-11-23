# Drafttrail

Write in the browser and keep a timed record of how the text was written. Save the record, hand it to a teacher, and they can replay the draft and check that nobody edited the record afterwards. No account, no server, nothing uploaded.

## Why

In a Stanford study, seven AI detectors labelled 61.22% of 91 human-written TOEFL essays as AI-generated on average, while essays by US eighth graders were classified almost perfectly ([Liang et al., 2023, *GPT detectors are biased against non-native English writers*](https://arxiv.org/abs/2304.02819)). A student who gets flagged has little to show except the essay itself, and the essay is exactly what the detector already misread.

A record of the writing process is different evidence. It has to be collected while the person writes; it cannot be produced afterwards from the finished text.

## What it does

- **Write**: a plain text box. Each change becomes an event with a time, a position, the characters removed and the characters added, and a label: typed, deleted, pasted, moved, or other.
- **Replay**: scrub or play the draft back. Pasted text is shaded, typed text is not. A timeline shows when the writing happened and where the pastes are.
- **Compare**: three sample recordings that end with byte-identical text (same SHA-256), produced three different ways. A checker that reads only the finished text gets the same input three times.
- **Verify**: every event stores a SHA-256 fingerprint of itself plus the previous event's fingerprint. Change, remove or reorder any event and the check fails at that event. The short *seal code* (head fingerprint + event count) is meant to be sent separately from the file; it catches a file that was rebuilt from scratch.

The sample recordings are simulated by `scripts/gen-samples.mjs` with seeded random timing. They are labelled as simulated in the file (`meta.simulated`) and on every screen that shows them.

## What it cannot do

- It cannot show who was typing.
- Someone can retype AI-generated text by hand, and the record will look like typing.
- Without the seal code, a person who controls the file can rebuild the whole chain. With the seal code given to the reader at the time of writing, the rebuilt file no longer matches.
- It is evidence about how text arrived in this text box. It is not a verdict and the page never gives one.

## Test results

All numbers below come from `results/results.json` (`npm run e2e`, then `node scripts/results.mjs`).

| Sample (simulated) | Events | Paste events | Final text pasted | Pauses ≥ 2 s | Span | Final text SHA-256 |
|---|---:|---:|---:|---:|---:|---|
| Typed by hand | 1,581 | 0 | 0% | 17 | 4:56 | 2fabe8fa4f96… |
| Pasted in one go | 1 | 1 | 100% | 0 | 0:00 | 2fabe8fa4f96… |
| Pasted, then 4 words edited | 80 | 1 | 97.1% | 4 | 0:30 | 2fabe8fa4f96… |

Tamper checks on the typed sample (1,581 events):

- 300 random single-field edits (text, time, kind, position, length): 300 caught, all 300 at the edited event. Average verify time 19 ms in Node.
- Relabelling the one-shot paste as typing: caught at event 1.
- Rebuilding every fingerprint after an edit: passes without the seal code (known limit), fails with the original seal code.

Browser tests (Chrome 157, real keyboard and clipboard through Playwright): typing with a correction, an outside paste, cutting and moving your own sentence, cutting and moving pasted text, saving and verifying the downloaded file with its seal code, a wrong seal code, the tamper demo, and the sample screens. All pass.

### What testing changed

The first browser run failed one check: when a writer cut one of their own sentences and pasted it somewhere else in the draft, 48.4% of the final text was shown as pasted. Rearranging your own paragraphs is normal writing, so this would have punished the people the tool is for.

Pastes of text that is already in the draft, or was cut from it, are now recorded as a *move*. During replay the moved text keeps the colour it had before. A separate test makes sure this cannot be used to launder an outside paste: paste text in, cut it, paste it back, and it is still shown as pasted. After the change the same scenario shows 0% pasted.

## Run it

Static files, no build step.

```
npm run serve        # http://127.0.0.1:5173/
npm test             # unit tests (node:test)
npm install          # only needed for the browser tests
npm run e2e          # browser tests, uses the Chrome already installed
node scripts/results.mjs
```

Opening `index.html` directly from disk works for writing and verifying; the samples need a web address because they are fetched.

## Recording format

`drafttrail/1` JSON: `started` (ISO time), `events` (`i` index, `t` ms since start, `k` kind, `p` position, `d` characters removed, `s` text inserted, `h` fingerprint), `final` (`length`, `textHash`), `seal`. Fingerprints: `h0 = SHA-256("drafttrail/1|" + started)`, `h(n) = SHA-256(h(n-1) + "|" + JSON([i,t,k,p,d,s]))`.

## Credits

- Fonts: IBM Plex Sans and IBM Plex Mono (SIL Open Font License), loaded from Google Fonts.
- Browser tests and the demo video: Playwright (`playwright-core`, Apache-2.0) driving the local Chrome; video converted with FFmpeg.
- Hashing: the browser's Web Crypto API. No other runtime libraries.
- Code was written with help from Claude Code (Anthropic), an AI coding assistant.
- Research cited: Liang, Yuksekgonul, Mao, Wu, Zou (2023), arXiv:2304.02819.

## License

MIT
