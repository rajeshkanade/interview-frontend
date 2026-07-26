// Tests the VAD state machine that now decides utterance boundaries.
// Run with: node src/hooks/vad.test.mjs
//
// This logic replaced the browser recognizer as the source of utterance
// boundaries, so if it is wrong the accurate transcription path either never
// fires or cuts questions in half.

import assert from 'node:assert/strict';
import { createNoiseFloor, createSegmenter, rms, VAD_DEFAULTS } from './vad.js';

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

const FRAME = VAD_DEFAULTS.frameMs;
const frames = (ms) => Math.round(ms / FRAME);

// Drive the segmenter and collect the events it emits.
function drive(segmenter, script, looksUnfinished = false) {
  const events = [];

  for (const { level, ms } of script) {
    for (let i = 0; i < frames(ms); i += 1) {
      const event = segmenter.push(level, looksUnfinished);
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

const QUIET = 0.002;
const LOUD = 0.08;

check('rms measures amplitude', () => {
  assert.equal(rms([0, 0, 0, 0]), 0);
  assert.equal(rms([1, 1, 1, 1]), 1);
  assert.ok(Math.abs(rms([1, -1, 1, -1]) - 1) < 1e-9);
  assert.equal(rms([]), 0);
  assert.equal(rms(null), 0);
});

check('a normal utterance produces exactly one speech-end', () => {
  const s = createSegmenter();
  const events = drive(s, [
    { level: QUIET, ms: 500 },
    { level: LOUD, ms: 2000 },   // speaking
    { level: QUIET, ms: 1500 },  // past the 1000ms hangover
  ]);
  assert.deepEqual(events, ['speech-start', 'speech-end']);
});

check('silence alone never starts an utterance', () => {
  const s = createSegmenter();
  assert.deepEqual(drive(s, [{ level: QUIET, ms: 10000 }]), []);
});

check('a brief click is discarded, not transcribed', () => {
  const s = createSegmenter();
  const events = drive(s, [
    { level: QUIET, ms: 300 },
    { level: LOUD, ms: 200 },    // above onset (150ms) but under minUtterance (350ms)
    { level: QUIET, ms: 1500 },
  ]);
  assert.deepEqual(events, ['speech-start', 'speech-discard']);
});

check('a pause shorter than the hangover does not split the utterance', () => {
  const s = createSegmenter();
  const events = drive(s, [
    { level: LOUD, ms: 1000 },
    { level: QUIET, ms: 600 },   // mid-sentence breath, under 1000ms
    { level: LOUD, ms: 1000 },
    { level: QUIET, ms: 1500 },
  ]);
  assert.deepEqual(events, ['speech-start', 'speech-end'], 'should be one utterance, not two');
});

check('unfinished text extends the silence window', () => {
  // Same 1.4s pause: ends the utterance normally, but is tolerated when the
  // words so far look unfinished.
  const normal = createSegmenter();
  const normalEvents = drive(normal, [
    { level: LOUD, ms: 800 },
    { level: QUIET, ms: 1400 },
  ]);
  assert.deepEqual(normalEvents, ['speech-start', 'speech-end']);

  const unfinished = createSegmenter();
  const unfinishedEvents = drive(
    unfinished,
    [
      { level: LOUD, ms: 800 },
      { level: QUIET, ms: 1400 },
    ],
    true,
  );
  assert.deepEqual(unfinishedEvents, ['speech-start'], 'should still be waiting');
});

check('two separate questions produce two utterances', () => {
  const s = createSegmenter();
  const events = drive(s, [
    { level: LOUD, ms: 1200 },
    { level: QUIET, ms: 1600 },
    { level: LOUD, ms: 1200 },
    { level: QUIET, ms: 1600 },
  ]);
  assert.deepEqual(events, ['speech-start', 'speech-end', 'speech-start', 'speech-end']);
});

check('a runaway utterance is force-cut', () => {
  const s = createSegmenter();
  const events = drive(s, [{ level: LOUD, ms: 40000 }]);
  assert.ok(events.includes('speech-end'), 'maxUtteranceMs must force a cut');
});

check('adapts to a noisy room instead of hearing speech constantly', () => {
  const s = createSegmenter();
  // Steady background hum well above the initial floor.
  const hum = 0.02;
  const events = drive(s, [{ level: hum, ms: 8000 }]);
  // It may trigger once before the floor adapts, but must not fire repeatedly.
  const starts = events.filter((e) => e === 'speech-start').length;
  assert.ok(starts <= 1, `expected the noise floor to adapt, got ${starts} starts`);
});

check('speech is still detected after the floor adapts to room noise', () => {
  // Room noise sits below the threshold (Chrome's noiseSuppression is enabled,
  // so steady hum arrives attenuated). The floor rises toward it; speech must
  // still register clearly above.
  const s = createSegmenter();
  drive(s, [{ level: 0.009, ms: 6000 }]);
  assert.equal(s.isSpeaking, false, 'room noise must not read as speech');

  const events = drive(s, [
    { level: 0.15, ms: 1200 },
    { level: 0.009, ms: 1600 },
  ]);
  assert.deepEqual(events, ['speech-start', 'speech-end']);
});

check('a long utterance is not cut short by floor drift', () => {
  // A 20s answer with natural pauses between phrases must stay one utterance.
  const s = createSegmenter();
  const script = [];
  for (let i = 0; i < 10; i += 1) {
    script.push({ level: 0.08, ms: 1500 }, { level: 0.004, ms: 400 });
  }
  const events = drive(s, script);
  assert.equal(events.filter((e) => e === 'speech-start').length, 1, JSON.stringify(events));
  assert.equal(events.filter((e) => e === 'speech-end').length, 0, 'should still be open');
});

check('threshold never drops below the absolute minimum', () => {
  const s = createSegmenter();
  drive(s, [{ level: 0.0, ms: 5000 }]);   // dead silence
  assert.ok(s.threshold >= VAD_DEFAULTS.minThreshold);
});

check('silenceProgress rises during the hangover and is 0 when idle', () => {
  const s = createSegmenter();
  assert.equal(s.silenceProgress, 0);
  drive(s, [{ level: LOUD, ms: 800 }]);
  assert.equal(s.silenceProgress, 0, 'no progress while actively speaking');
  drive(s, [{ level: QUIET, ms: 500 }]);
  assert.ok(s.silenceProgress > 0 && s.silenceProgress < 1, `got ${s.silenceProgress}`);
});

check('isSpeaking reflects state', () => {
  const s = createSegmenter();
  assert.equal(s.isSpeaking, false);
  drive(s, [{ level: LOUD, ms: 400 }]);
  assert.equal(s.isSpeaking, true);
  drive(s, [{ level: QUIET, ms: 1500 }]);
  assert.equal(s.isSpeaking, false);
});

check('reset clears state', () => {
  const s = createSegmenter();
  drive(s, [{ level: LOUD, ms: 500 }]);
  assert.equal(s.isSpeaking, true);
  s.reset();
  assert.equal(s.isSpeaking, false);
  assert.equal(s.silenceProgress, 0);
});

check('noise floor tracks quiet and ignores speech frames', () => {
  const floor = createNoiseFloor({ initial: 0.01 });
  const before = floor.value;
  floor.update(0.9, true);   // speech must not raise the floor
  assert.equal(floor.value, before);

  for (let i = 0; i < 200; i += 1) {
    floor.update(0.001, false);
  }
  assert.ok(floor.value < before, 'floor should fall toward a quiet room');
});

if (failures.length > 0) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length} checks\n`);
  failures.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}

console.log(`All ${passed} VAD checks passed.`);
