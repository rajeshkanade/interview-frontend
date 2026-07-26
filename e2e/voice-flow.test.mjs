/**
 * Browser integration test for the always-on-mic flow.
 *
 * Drives the real built app in real Chrome with window.webkitSpeechRecognition
 * replaced by a scriptable fake, because Chrome's own recognizer needs a live
 * microphone and Google's speech service, neither of which exist in CI. Everything
 * downstream of the recognizer -- the hook's timers, the consumed-result cursor,
 * the adaptive silence window, the fetch to the backend, and the React rendering
 * -- is the genuine code path.
 *
 * Usage:
 *   1. backend:  uvicorn main:app --port 8123
 *   2. frontend: npx vite preview --port 4173   (after npm run build)
 *   3. node e2e/voice-flow.test.mjs
 *
 * Env: APP_URL (default http://localhost:4173), CHROME (auto-detected).
 */

import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.APP_URL || 'http://localhost:4173';

function findChrome() {
  if (process.env.CHROME) {
    return process.env.CHROME;
  }

  for (const candidate of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execSync(`command -v ${candidate}`, { encoding: 'utf8' }).trim();
    } catch {
      // try the next one
    }
  }

  throw new Error('No Chrome binary found; set CHROME=/path/to/chrome');
}

// Installed before the app's own scripts run, so the hook picks it up.
const FAKE_RECOGNITION = `
window.__fake = { instances: [], submissions: [] };

class FakeSpeechRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = '';
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this._results = [];
    this._started = false;
    window.__fake.instances.push(this);
  }

  start() {
    if (this._started) { throw Object.assign(new Error('already started'), { name: 'InvalidStateError' }); }
    this._started = true;
  }

  stop() { this._started = false; this.onend && this.onend(); }
  abort() { this._started = false; }

  // Test hook: fire onresult the way Chrome does. Two behaviours matter:
  //  1. the results list is CUMULATIVE for the whole recognition session --
  //     this is what the consumed-cursor fix exists to handle;
  //  2. an in-progress result occupies one slot and is updated in place until
  //     it finalizes -- a final result does NOT append next to its own interim.
  __say(text, { isFinal = true, alternatives = [] } = {}) {
    const entry = [{ transcript: text }, ...alternatives.map((a) => ({ transcript: a }))];
    entry.isFinal = isFinal;
    entry.length = 1 + alternatives.length;

    const lastIsInterim = this._results.length > 0 && !this._results[this._results.length - 1].isFinal;

    if (lastIsInterim) {
      this._results[this._results.length - 1] = entry;
    } else {
      this._results.push(entry);
    }

    const results = this._results.slice();
    results.length = this._results.length;
    this.onresult && this.onresult({ results, resultIndex: this._results.length - 1 });
  }
}

window.SpeechRecognition = FakeSpeechRecognition;
window.webkitSpeechRecognition = FakeSpeechRecognition;

// Record every question actually sent to the backend, so duplicate
// submissions are observable rather than inferred.
const realFetch = window.fetch;
window.fetch = async (url, options = {}) => {
  if (String(url).includes('/ask') && options.body) {
    try { window.__fake.submissions.push(JSON.parse(options.body).question); } catch {}
  }
  return realFetch(url, options);
};
`;

const results = [];
function record(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll instead of guessing at fixed sleeps, so a slow backend does not read as
// a failure. Returns false on timeout rather than throwing.
async function waitFor(page, predicate, { timeout = 15000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) {
      return true;
    }

    await sleep(interval);
  }

  return false;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream'],
  });

  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => consoleLines.push(`PAGEERROR: ${error.message}`));

  await page.evaluateOnNewDocument(FAKE_RECOGNITION);
  await page.goto(APP_URL, { waitUntil: 'networkidle2' });

  // Accurate mic (server transcription) is the default, so switch to the
  // browser recognizer path that this file covers.
  await page.click('.accuracy-toggle');
  await sleep(200);
  const modeLabel = await page.$eval('.accuracy-toggle', (el) => el.textContent.trim());
  record('can switch to the browser recognizer path', /fast/i.test(modeLabel), modeLabel);

  // Start the session.
  await page.click('.session-button');
  await sleep(400);

  const started = await page.evaluate(() => window.__fake.instances.length > 0);
  record('session start creates a recognizer', started);

  const config = await page.evaluate(() => {
    const r = window.__fake.instances[0];
    return { maxAlternatives: r.maxAlternatives, interimResults: r.interimResults, lang: r.lang };
  });
  record('maxAlternatives is raised to 3', config.maxAlternatives === 3, `got ${config.maxAlternatives}`);
  record('interim results enabled', config.interimResults === true);
  record('lang is en-IN', config.lang === 'en-IN', config.lang);

  // --- Utterance 1: interim then final, complete question ---
  await page.evaluate(() => window.__fake.instances[0].__say('what is', { isFinal: false }));
  await sleep(150);
  const interimShown = await page.$eval('.capture-box', (el) => el.textContent.trim());
  record('interim speech renders live', interimShown.includes('what is'), interimShown);

  await page.evaluate(() =>
    window.__fake.instances[0].__say('what is the ReAct pattern', {
      isFinal: true,
      alternatives: ['what is the react pattern', 'what is the reactor pattern'],
    }),
  );

  // Silence window is 1200ms for a complete question.
  await waitFor(page, () => window.__fake.submissions.length >= 1, { timeout: 6000 });
  await sleep(600); // let any erroneous second submission show up

  const afterFirst = await page.evaluate(() => window.__fake.submissions.slice());
  record(
    'complete question submitted exactly once',
    afterFirst.length === 1,
    `submissions=${JSON.stringify(afterFirst)}`,
  );

  // --- Utterance 2: THE REGRESSION. Chrome still holds utterance 1 in results[].
  await page.evaluate(() => window.__fake.instances[0].__say('what is FAISS', { isFinal: true }));
  await waitFor(page, () => window.__fake.submissions.length >= 2, { timeout: 6000 });
  await sleep(600);

  const afterSecond = await page.evaluate(() => window.__fake.submissions.slice());
  const second = afterSecond[1] || '';
  record(
    'second utterance is not polluted by the first',
    afterSecond.length === 2 && !second.toLowerCase().includes('react'),
    `second submission = ${JSON.stringify(second)}`,
  );
  record(
    'first question is never resubmitted',
    afterSecond.filter((q) => q.toLowerCase().includes('react')).length === 1,
    `all submissions=${JSON.stringify(afterSecond)}`,
  );

  // --- Adaptive silence: a fragment must wait longer than a complete question ---
  await page.evaluate(() => {
    window.__fake.submissions.length = 0;
    window.__fake.instances[0].__say('and what about the', { isFinal: true });
  });
  await sleep(1500); // past the 1200ms complete-question window
  const duringFragmentWait = await page.evaluate(() => window.__fake.submissions.length);
  record(
    'fragment waits longer than the normal silence window',
    duringFragmentWait === 0,
    `submitted after 1.5s: ${duringFragmentWait}`,
  );

  await waitFor(page, () => window.__fake.submissions.length >= 1, { timeout: 6000 });
  const afterFragmentWait = await page.evaluate(() => window.__fake.submissions.length);
  record('fragment eventually submits', afterFragmentWait === 1, `count=${afterFragmentWait}`);

  // Backend replies [FRAGMENT]; the placeholder must be dropped, not left spinning.
  await waitFor(page, () => Boolean(document.querySelector('.pending-fragment')), { timeout: 12000 });
  await sleep(500);
  const state = await page.evaluate(() => ({
    entries: document.querySelectorAll('.qa-entry').length,
    holding: document.querySelector('.pending-fragment')?.textContent || '',
    thinking: Array.from(document.querySelectorAll('.answer-bubble')).filter((b) =>
      b.textContent.includes('Thinking through your answer'),
    ).length,
  }));
  record(
    'fragment leaves no stuck "Thinking" bubble',
    state.thinking === 0,
    `stuck bubbles=${state.thinking}, entries=${state.entries}`,
  );
  record('fragment text is held for the next utterance', state.holding.length > 0, state.holding);

  // --- Filler must not leave an empty bubble ---
  const entriesBeforeFiller = await page.evaluate(() => document.querySelectorAll('.qa-entry').length);
  await page.evaluate(() => window.__fake.instances[0].__say('umm okay yes', { isFinal: true }));
  await sleep(4500);
  const entriesAfterFiller = await page.evaluate(() => document.querySelectorAll('.qa-entry').length);
  record(
    'filler adds no permanent entry',
    entriesAfterFiller <= entriesBeforeFiller + 1,
    `before=${entriesBeforeFiller} after=${entriesAfterFiller}`,
  );

  // --- An answer actually streamed in from the backend ---
  const answered = await waitFor(
    page,
    () => Array.from(document.querySelectorAll('.answer-bubble')).some((b) => b.textContent.length > 80),
    { timeout: 25000 },
  );
  record('an answer streamed and rendered', answered);

  const answerText = await page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('.answer-bubble'));
    return bubbles.length ? bubbles[0].textContent.slice(0, 140) : '';
  });
  record(
    'ReAct answer is the agent pattern, not React.js',
    /thought|action|observation|reason/i.test(answerText) && !/jsx|component|dom/i.test(answerText),
    answerText.slice(0, 110),
  );

  const leakedSentinel = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.answer-bubble, .question-bubble')).some((b) =>
      /\[(DONE|SKIP|FRAGMENT)\]/.test(b.textContent),
    ),
  );
  record('no sentinel text leaked into the UI', !leakedSentinel);

  // --- Corrected-vs-heard display ---
  const heardLine = await page.evaluate(() => document.querySelector('.heard-as')?.textContent || '');
  console.log(`\n  (heard-as line: ${heardLine || 'none — transcript needed no correction'})`);

  // --- No duplicate flush logs, and no page errors ---
  const flushCount = consoleLines.filter((l) => l.includes('Flushing captured text')).length;
  const dupSkips = consoleLines.filter((l) => l.includes('Skipping duplicate')).length;
  console.log(`  (flush logs: ${flushCount}, duplicate-skip logs: ${dupSkips})`);

  const pageErrors = consoleLines.filter((l) => l.startsWith('PAGEERROR'));
  record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

  // --- Mode toggle flips back to the API path ---
  await page.click('.accuracy-toggle');
  await sleep(300);
  const toggled = await page.evaluate(() => {
    const el = document.querySelector('.accuracy-toggle');
    return { on: el.classList.contains('on'), text: el.textContent.trim() };
  });
  record('mode toggle returns to Accurate mic', toggled.on && /accurate/i.test(toggled.text), toggled.text);

  // --- Stopping the session tears the recognizer down ---
  await page.click('.session-button');
  await sleep(500);
  const stopped = await page.evaluate(() => window.__fake.instances.every((r) => r._started === false));
  record('stopping the session stops recognition', stopped);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed.`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
