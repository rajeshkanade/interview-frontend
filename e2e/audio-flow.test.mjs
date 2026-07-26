/**
 * End-to-end test of the Accurate mic path with a real microphone signal.
 *
 * Chrome can be fed a WAV file as the system microphone, so this exercises the
 * genuine chain with nothing stubbed: real mic stream -> Web Audio analyser ->
 * VAD segmentation -> MediaRecorder clip -> POST /transcribe-and-answer ->
 * transcription -> term correction -> classification -> streamed answer.
 *
 * Usage:
 *   1. backend:  uvicorn main:app --port 8123
 *   2. frontend: VITE_API_URL=http://localhost:8123 npx vite build && npx vite preview --port 4173
 *   3. node e2e/audio-flow.test.mjs
 *
 * Env: APP_URL, FAKE_AUDIO (path to a 16-bit PCM WAV), CHROME.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.APP_URL || 'http://localhost:4173';
const FAKE_AUDIO = process.env.FAKE_AUDIO;

function findChrome() {
  if (process.env.CHROME) {
    return process.env.CHROME;
  }

  for (const candidate of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execSync(`command -v ${candidate}`, { encoding: 'utf8' }).trim();
    } catch {
      // next
    }
  }

  throw new Error('No Chrome binary found; set CHROME=/path/to/chrome');
}

const INSTRUMENT = `
window.__probe = { audioPosts: 0, askPosts: 0, transcripts: [] };
const realFetch = window.fetch;
window.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes('/transcribe-and-answer')) { window.__probe.audioPosts += 1; }
  if (target.includes('/ask')) { window.__probe.askPosts += 1; }
  const response = await realFetch(url, options);
  const heard = response.headers.get('X-Transcript');
  if (heard) {
    try { window.__probe.transcripts.push(decodeURIComponent(heard)); } catch { window.__probe.transcripts.push(heard); }
  }
  return response;
};
`;

const results = [];
function record(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(page, predicate, { timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) {
      return true;
    }

    await sleep(interval);
  }

  return false;
}

async function run({ mobile }) {
  const label = mobile ? 'mobile (Pixel 7 emulation)' : 'desktop';
  console.log(`\n=== ${label} ===`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      // Grant mic permission and replace the mic with our WAV file.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_AUDIO}`,
    ],
  });

  const page = await browser.newPage();

  if (mobile) {
    // Real Android UA + touch, so the app takes its mobile code paths.
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    );
    await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 });
  }

  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

  await page.evaluateOnNewDocument(INSTRUMENT);
  await page.goto(APP_URL, { waitUntil: 'networkidle2' });

  const defaultMode = await page.$eval('.accuracy-toggle', (el) => el.textContent.trim());
  record(`${label}: Accurate mic is the default`, /accurate/i.test(defaultMode), defaultMode);

  await page.click('.session-button');

  // Microphone acquisition + Web Audio setup.
  const ready = await waitFor(
    page,
    () => !document.querySelector('.capture-audio-status')?.textContent.includes('Waiting for microphone'),
    { timeout: 15000 },
  );
  record(`${label}: microphone opened`, ready);

  // The VAD must detect the speech in the looped WAV.
  const detectedSpeech = await waitFor(
    page,
    () => Boolean(document.querySelector('.level-meter.speaking')) ||
          document.querySelector('.capture-audio-status')?.textContent.includes('Hearing'),
    { timeout: 20000 },
  );
  record(`${label}: VAD detected speech from the mic`, detectedSpeech);

  const meterMoved = await waitFor(page, () => document.querySelectorAll('.level-bar.lit').length > 0, {
    timeout: 10000,
  });
  record(`${label}: level meter reflects real audio`, meterMoved);

  // VAD cut an utterance and posted the clip.
  const posted = await waitFor(page, () => window.__probe.audioPosts >= 1, { timeout: 25000 });
  record(`${label}: audio clip posted to the transcription API`, posted);

  const usedTextEndpoint = await page.evaluate(() => window.__probe.askPosts);
  record(`${label}: text endpoint not used in Accurate mode`, usedTextEndpoint === 0, `askPosts=${usedTextEndpoint}`);

  // Server transcription came back and reached the UI.
  const gotTranscript = await waitFor(page, () => window.__probe.transcripts.some((t) => t.length > 3), {
    timeout: 30000,
  });
  const transcripts = await page.evaluate(() => window.__probe.transcripts.slice());
  record(`${label}: server returned a transcript`, gotTranscript, JSON.stringify(transcripts.slice(0, 3)));

  const heardReAct = transcripts.some((t) => /react/i.test(t));
  record(`${label}: spoken question was transcribed`, heardReAct, transcripts[0] || '(none)');

  const correctedToReAct = transcripts.some((t) => t.includes('ReAct'));
  record(`${label}: term corrected to ReAct`, correctedToReAct, transcripts.find((t) => /react/i.test(t)) || '');

  // An answer streamed and rendered.
  const answered = await waitFor(
    page,
    () => Array.from(document.querySelectorAll('.answer-bubble')).some((b) => b.textContent.length > 80),
    { timeout: 40000 },
  );
  record(`${label}: answer streamed and rendered`, answered);

  const answerText = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.answer-bubble')).find((x) => x.textContent.length > 80);
    return b ? b.textContent.slice(0, 200) : '';
  });
  record(
    `${label}: answer is the agent pattern, not React.js`,
    /thought|action|observation|reason/i.test(answerText) && !/jsx|hooks|component/i.test(answerText),
    answerText.slice(0, 110),
  );

  const errors = logs.filter((l) => l.startsWith('PAGEERROR'));
  record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));

  await page.click('.session-button');
  await sleep(600);

  const micReleased = await page.evaluate(
    () => !document.querySelector('.capture-audio-status')?.textContent.includes('Hearing'),
  );
  record(`${label}: mic released on stop`, micReleased);

  await browser.close();
}

async function main() {
  if (!FAKE_AUDIO || !existsSync(FAKE_AUDIO)) {
    console.error(`FAKE_AUDIO must point at a 16-bit PCM WAV file (got: ${FAKE_AUDIO || 'unset'})`);
    process.exit(2);
  }

  await run({ mobile: false });
  await run({ mobile: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} audio-path checks passed.`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
