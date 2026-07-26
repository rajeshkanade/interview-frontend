# Interview Coach AI — Frontend

Always-on mic that captures interview questions and streams back an answer.

## Two mic modes

| | Accurate mic (default) | Fast mic |
|---|---|---|
| Transcription | OpenAI audio API, with a technical vocabulary bias prompt | Browser `SpeechRecognition` |
| Utterance boundaries | Voice activity detection on the audio signal | Recognizer silence timer |
| Technical terms | Reliable — "RAG", "ReAct", "FAISS" come through | Frequently misheard |
| Latency | ~1s extra per question | Instant |
| Cost | Billed per second of audio | Free |
| iOS / iPad | Works | Not available (no `SpeechRecognition`) |

**Accurate mic is the default** because the browser recognizer is what mangled
domain terms in the first place. It does not use `SpeechRecognition` at all, so
there is only one mic consumer and nothing to contend with on mobile.

`Fast mic` remains for when latency matters more than accuracy. It sends the
browser's n-best hypotheses to the backend, which picks whichever carries the
most known technical vocabulary.

## Mobile

Accurate mic is the recommended mode on phones and the only one that works on
iOS. Fast mic on Android is usable but hardened for the platform's quirks:

- **Restart gap cut from 1200 ms to 350 ms.** Android ends the recognition
  session after every utterance, so that delay was a window where the mic was
  deaf and the start of the next sentence was lost.
- **Watchdog.** Mobile recognizers die silently — no `onend`, no `onerror` —
  after a screen dim or a brief app switch. A 3 s watchdog restarts them; without
  it the mic simply stops working for the rest of the interview.
- **Carry-over.** If a session ends mid-question, the partial text is held and
  joined to the next one instead of being submitted as half a question.
- **Visibility handling.** Returning to the tab resumes the recognizer, and the
  `AudioContext` in Accurate mode.
- **Actionable errors.** Blocked permission, a busy mic, and network blips are
  each reported as something the user can act on, and routine `no-speech` noise
  is suppressed.

## Running

```bash
npm install
npm run dev
```

Point `.env` at your backend:

```env
VITE_API_URL=http://127.0.0.1:8000
```

`VITE_API_URL` is baked in at **build** time, so rebuild after changing it.

## Tests

```bash
npm test                # VAD + transcript helpers (no browser, no network)
npm run test:e2e        # Fast mic path in real Chrome
npm run test:e2e:audio  # Accurate mic path with a fake microphone
```

`npm test` is pure logic: the VAD state machine, the utterance accumulator (which
covers the double-submission regression), and platform detection.

The e2e suites need the backend on `:8123` and a preview server on `:4173`:

```bash
VITE_API_URL=http://localhost:8123 npx vite build
npx vite preview --port 4173
```

`test:e2e:audio` needs a 16-bit PCM WAV to act as the microphone, passed as
`FAKE_AUDIO`. Chrome loops it via `--use-file-for-fake-audio-capture`, so the
whole chain runs for real — mic stream, Web Audio analyser, VAD, MediaRecorder,
upload, transcription, and the streamed answer. It runs twice: once as desktop,
once with Pixel 7 emulation.

## Deploying

```bash
npm run build
vercel --prod
```
