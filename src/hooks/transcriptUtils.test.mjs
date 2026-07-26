// Tests the real transcript helpers used by useVoiceInput.js.
// No test framework and no DOM required -- run with:
//   node src/hooks/transcriptUtils.test.mjs
//
// The accumulateResults cases are the important ones: they reproduce the
// double-submission bug (reading event.results from 0 while continuous=true)
// and prove the consumed-cursor fix stops it.

import assert from 'node:assert/strict';
import { accumulateResults, detectPlatform, looksIncomplete, normalizeSpokenText } from './transcriptUtils.js';

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

// Build a SpeechRecognition-like results list.
function makeResults(entries) {
  const results = entries.map(({ text, isFinal, alternatives = [] }) => {
    const result = [{ transcript: text }, ...alternatives.map((a) => ({ transcript: a }))];
    result.isFinal = isFinal;
    result.length = 1 + alternatives.length;
    return result;
  });
  results.length = entries.length;
  return results;
}

// ---------------------------------------------------------------------------
// The regression: a continuous session keeps every finalized result forever.
// ---------------------------------------------------------------------------

check('reads only unconsumed results after a flush', () => {
  // Utterance 1 finalizes, gets flushed; cursor moves to 1.
  const afterFirst = makeResults([{ text: 'what is RAG', isFinal: true }]);
  const first = accumulateResults(afterFirst, 0);
  assert.equal(first.combinedText, 'what is RAG');

  // Utterance 2 arrives. The browser still holds utterance 1 in results[0].
  const afterSecond = makeResults([
    { text: 'what is RAG', isFinal: true },
    { text: 'what is FAISS', isFinal: true },
  ]);

  // Buggy behaviour (fromIndex 0) resubmits the first question.
  const buggy = accumulateResults(afterSecond, 0);
  assert.equal(buggy.combinedText, 'what is RAG what is FAISS');

  // Fixed behaviour: cursor at 1 yields only the new utterance.
  const fixed = accumulateResults(afterSecond, 1);
  assert.equal(fixed.combinedText, 'what is FAISS');
});

check('third utterance is not polluted by the first two', () => {
  const results = makeResults([
    { text: 'tell me about yourself', isFinal: true },
    { text: 'what is RAG', isFinal: true },
    { text: 'explain the ReAct pattern', isFinal: true },
  ]);
  assert.equal(accumulateResults(results, 2).combinedText, 'explain the ReAct pattern');
  assert.equal(accumulateResults(results, 0).combinedText.split(' ').length > 8, true);
});

check('interim results accumulate within one utterance', () => {
  const results = makeResults([
    { text: 'what is', isFinal: false },
  ]);
  assert.equal(accumulateResults(results, 0).combinedText, 'what is');

  const grown = makeResults([{ text: 'what is the ReAct pattern', isFinal: false }]);
  assert.equal(accumulateResults(grown, 0).interimText, 'what is the ReAct pattern');
  assert.equal(accumulateResults(grown, 0).finalText, '');
});

check('final and interim are kept separate', () => {
  const results = makeResults([
    { text: 'what is RAG', isFinal: true },
    { text: 'and how do you', isFinal: false },
  ]);
  const out = accumulateResults(results, 0);
  assert.equal(out.finalText, 'what is RAG');
  assert.equal(out.interimText, 'and how do you');
  assert.equal(out.combinedText, 'what is RAG and how do you');
});

check('collects n-best alternatives from final results only', () => {
  const results = makeResults([
    { text: 'what is rock', isFinal: true, alternatives: ['what is rog', 'what is rack'] },
    { text: 'ignored interim', isFinal: false, alternatives: ['not collected'] },
  ]);
  const out = accumulateResults(results, 0);
  assert.deepEqual(out.alternatives, ['what is rog', 'what is rack']);
});

check('respects the maxAlternatives cap', () => {
  const results = makeResults([
    { text: 'a', isFinal: true, alternatives: ['b', 'c', 'd', 'e'] },
  ]);
  assert.equal(accumulateResults(results, 0, 3).alternatives.length, 2);
});

check('empty and out-of-range input is safe', () => {
  assert.equal(accumulateResults(makeResults([]), 0).combinedText, '');
  const results = makeResults([{ text: 'hello there', isFinal: true }]);
  assert.equal(accumulateResults(results, 5).combinedText, '');
  assert.equal(accumulateResults(results, 1).combinedText, '');
});

check('skips blank transcripts', () => {
  const results = makeResults([
    { text: '   ', isFinal: true },
    { text: 'real question here', isFinal: true },
  ]);
  assert.equal(accumulateResults(results, 0).combinedText, 'real question here');
});

// ---------------------------------------------------------------------------
// Stutter collapsing and the end-of-utterance heuristic.
// ---------------------------------------------------------------------------

check('collapses duplicated words and phrases', () => {
  assert.equal(normalizeSpokenText('what what is RAG'), 'what is RAG');
  assert.equal(normalizeSpokenText('what is RAG what is RAG'), 'what is RAG');
  assert.equal(normalizeSpokenText('  spaced    out   text '), 'spaced out text');
  assert.equal(normalizeSpokenText(''), '');
});

check('does not mangle legitimately repeated content', () => {
  assert.equal(normalizeSpokenText('what is the difference between RAG and fine tuning'),
    'what is the difference between RAG and fine tuning');
});

check('looksIncomplete flags cut-off speech', () => {
  for (const text of ['and what about the', 'so how do you', 'what is the', 'in', '']) {
    assert.equal(looksIncomplete(text), true, `expected incomplete: ${text}`);
  }
});

check('looksIncomplete allows complete questions', () => {
  for (const text of [
    'what is RAG',
    'explain the ReAct pattern',
    'how would you scale it',
    'tell me about yourself',
    'have you used Pinecone',
    'why RAG',
  ]) {
    assert.equal(looksIncomplete(text), false, `expected complete: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// Platform detection drives the mobile code paths, so it is worth pinning.
// ---------------------------------------------------------------------------

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  desktopChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

check('detects Android as mobile', () => {
  const p = detectPlatform(UA.androidChrome, true);
  assert.equal(p.isMobile, true);
  assert.equal(p.isAndroid, true);
  assert.equal(p.isIOS, false);
});

check('detects iPhone as mobile and iOS', () => {
  for (const ua of [UA.iphoneSafari, UA.iphoneChrome]) {
    const p = detectPlatform(ua, true);
    assert.equal(p.isMobile, true, ua);
    assert.equal(p.isIOS, true, ua);
  }
});

check('desktop is not mobile', () => {
  const p = detectPlatform(UA.desktopChrome, true);
  assert.equal(p.isMobile, false);
  assert.equal(p.isIOS, false);
  assert.equal(p.isAndroid, false);
});

check('unsupported message points at Accurate mic, not a browser switch', () => {
  // Telling an iPhone user to install Chrome is wrong advice -- every iOS
  // browser is WebKit, so it would not help. Accurate mic works there, so the
  // message must send them to it.
  const ios = detectPlatform(UA.iphoneChrome, false);
  assert.match(ios.unsupportedMessage, /iPhone|iPad/);
  assert.match(ios.unsupportedMessage, /Accurate mic/);
  assert.doesNotMatch(ios.unsupportedMessage, /Please use Chrome on/i);

  const other = detectPlatform(UA.desktopChrome, false);
  assert.match(other.unsupportedMessage, /Accurate mic/);
});

check('no message when speech recognition is available', () => {
  assert.equal(detectPlatform(UA.androidChrome, true).unsupportedMessage, '');
  assert.equal(detectPlatform(UA.desktopChrome, true).unsupportedMessage, '');
});

if (failures.length > 0) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks\n`);
  failures.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}

console.log(`All ${passed} transcript-helper checks passed.`);
