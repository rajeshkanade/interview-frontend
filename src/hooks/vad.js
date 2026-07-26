// Voice activity detection over a raw microphone stream.
//
// Why this exists: the browser's SpeechRecognition was previously the only thing
// that could tell us when an utterance ended, which meant the accurate
// transcription path still depended on the inaccurate recognizer -- and on
// mobile the two fought over a single microphone. Detecting speech boundaries
// from the audio signal directly removes both problems.
//
// Deliberately free of any React import so it can be unit-tested in Node.

// Frames are ~50ms; these are counts of frames, not milliseconds.
export const VAD_DEFAULTS = {
  frameMs: 50,
  // Speech must persist this long before we call it speech, so a cough or a
  // door does not open an utterance.
  onsetMs: 150,
  // Silence this long ends the utterance. Interviewers pause mid-sentence, so
  // this is deliberately not aggressive.
  hangoverMs: 1000,
  // A longer wait when the words so far sound unfinished.
  fragmentHangoverMs: 2200,
  // Ignore anything shorter than this -- it is a click, not a question.
  minUtteranceMs: 350,
  // Hard stop so a noisy room cannot record forever.
  maxUtteranceMs: 30000,
  // How far above the measured noise floor counts as speech.
  thresholdMargin: 0.008,
  // Absolute floor so a silent room with a very low noise floor does not make
  // the threshold hypersensitive.
  minThreshold: 0.012,
};

/**
 * Root-mean-square amplitude of a time-domain frame.
 * @param {Float32Array|number[]} samples values in [-1, 1]
 */
export function rms(samples) {
  if (!samples || samples.length === 0) {
    return 0;
  }

  let sum = 0;

  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }

  return Math.sqrt(sum / samples.length);
}

/**
 * Tracks the ambient noise floor so the speech threshold adapts to the room.
 *
 * Uses a slow decay toward quiet frames and never rises while speech is active,
 * which stops a long answer from dragging the floor up and deafening the VAD.
 */
export function createNoiseFloor({ initial = 0.005, adaptUp = 0.002, adaptDown = 0.05 } = {}) {
  let floor = initial;

  return {
    get value() {
      return floor;
    },
    update(level, isSpeech) {
      if (isSpeech) {
        return floor;
      }

      // Move quickly toward a quieter room, slowly toward a louder one.
      const rate = level < floor ? adaptDown : adaptUp;
      floor += (level - floor) * rate;
      return floor;
    },
    reset(value = initial) {
      floor = value;
    },
  };
}

/**
 * Frame-by-frame speech segmenter.
 *
 * Feed it one RMS level per frame; it returns an event describing what changed.
 * Pure and synchronous so the whole state machine is testable without audio
 * hardware.
 *
 * Events: 'speech-start' | 'speech-end' | null
 */
export function createSegmenter(options = {}) {
  const config = { ...VAD_DEFAULTS, ...options };
  const framesFor = (ms) => Math.max(1, Math.round(ms / config.frameMs));

  const onsetFrames = framesFor(config.onsetMs);
  const maxFrames = framesFor(config.maxUtteranceMs);

  const noiseFloor = createNoiseFloor();

  let speaking = false;
  let aboveCount = 0;
  let belowCount = 0;
  // Total frames since onset, used only for the runaway ceiling.
  let speechFrames = 0;
  // Frames that were actually loud. This is what "how long did they speak for"
  // means -- counting the trailing silence here made every short click look
  // long enough to transcribe.
  let voicedFrames = 0;
  let hangoverFrames = framesFor(config.hangoverMs);

  return {
    get isSpeaking() {
      return speaking;
    },
    get threshold() {
      return Math.max(noiseFloor.value + config.thresholdMargin, config.minThreshold);
    },
    /** Fraction of the silence window elapsed, for a progress indicator. */
    get silenceProgress() {
      if (!speaking || belowCount === 0) {
        return 0;
      }

      return Math.min(belowCount / hangoverFrames, 1);
    },
    /**
     * @param {number} level RMS for this frame
     * @param {boolean} looksUnfinished caller's view of the text so far; extends
     *   the silence window mid-sentence
     */
    push(level, looksUnfinished = false) {
      const threshold = Math.max(noiseFloor.value + config.thresholdMargin, config.minThreshold);
      const isLoud = level >= threshold;

      // Adapt on any frame that is not itself loud, including the pauses between
      // words. Those pauses are the best available sample of the room, so gating
      // adaptation on the whole utterance (as this once did) made the floor go
      // stale exactly when it mattered.
      noiseFloor.update(level, isLoud);

      hangoverFrames = framesFor(looksUnfinished ? config.fragmentHangoverMs : config.hangoverMs);

      if (!speaking) {
        aboveCount = isLoud ? aboveCount + 1 : 0;

        if (aboveCount >= onsetFrames) {
          speaking = true;
          belowCount = 0;
          speechFrames = aboveCount;
          voicedFrames = aboveCount;
          aboveCount = 0;
          return 'speech-start';
        }

        return null;
      }

      speechFrames += 1;

      if (isLoud) {
        voicedFrames += 1;
        belowCount = 0;
      } else {
        belowCount += 1;

        if (belowCount >= hangoverFrames) {
          const voicedMs = voicedFrames * config.frameMs;
          speaking = false;
          belowCount = 0;
          aboveCount = 0;
          speechFrames = 0;
          voicedFrames = 0;

          // Too short to be a question; drop it rather than paying to transcribe.
          return voicedMs >= config.minUtteranceMs ? 'speech-end' : 'speech-discard';
        }
      }

      if (speechFrames >= maxFrames) {
        speaking = false;
        belowCount = 0;
        aboveCount = 0;
        speechFrames = 0;
        voicedFrames = 0;
        return 'speech-end';
      }

      return null;
    },
    reset() {
      speaking = false;
      aboveCount = 0;
      belowCount = 0;
      speechFrames = 0;
      voicedFrames = 0;
      noiseFloor.reset();
    },
  };
}
