import { useEffect, useMemo, useRef, useState } from 'react';

import { accumulateResults, detectPlatform, looksIncomplete, normalizeSpokenText } from './transcriptUtils';

const SILENCE_DURATION = 1200;
// When the utterance looks cut off mid-thought, wait longer instead of
// submitting half a question -- a fragment produces a confidently wrong answer.
const FRAGMENT_SILENCE_DURATION = 2600;
const DUPLICATE_SUBMISSION_WINDOW = 2500;
const DESKTOP_RESTART_DELAY = 250;
// Mobile runs with continuous=false (Android Chrome ignores continuous and ends
// the session after each utterance anyway), so this delay is a window where the
// mic is deaf. It used to be 1200ms, which dropped the start of the
// interviewer's next sentence on every single turn.
const MOBILE_RESTART_DELAY = 350;
// If a restart fails we back off rather than hammering start() in a loop.
const RESTART_BACKOFF_MAX = 2000;
// Mobile recognizers die silently -- no onend, no onerror -- especially after a
// screen dim or a brief app switch. This watchdog is the only thing that brings
// the mic back in that case.
const WATCHDOG_INTERVAL = 3000;
// A mobile session ends mid-question often. Text that looks unfinished is
// carried into the next session instead of being submitted as a fragment, but
// it must not be held forever if the speaker simply stopped.
const CARRY_OVER_TIMEOUT = 4000;
const MAX_ALTERNATIVES = 3;
const AUDIO_TIMESLICE = 1000;
// Rolling audio buffer length; an interview question is comfortably shorter.
const MAX_BUFFERED_AUDIO_CHUNKS = 45;

export function useVoiceInput({
  isActive,
  highAccuracy = false,
  onInterimChange,
  onSentenceComplete,
  onError,
}) {
  const recognitionRef = useRef(null);
  const isRecognitionRunningRef = useRef(false);
  const isMobileRef = useRef(false);
  const restartRequestedRef = useRef(false);
  const restartTimerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const interimTranscriptRef = useRef('');
  // The browser keeps every finalized result in event.results for the whole
  // recognition session. Without this cursor, each new result event re-reads
  // sentences that were already submitted and sends them again.
  const consumedResultIndexRef = useRef(0);
  const alternativesRef = useRef([]);
  const lastSpeechAtRef = useRef(null);
  const lastSubmittedRef = useRef({ text: '', at: 0 });
  const silenceWindowRef = useRef(SILENCE_DURATION);
  // Unfinished text carried across a mobile session restart.
  const carryOverRef = useRef('');
  const carryOverTimerRef = useRef(null);
  const restartAttemptsRef = useRef(0);
  const watchdogRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  // With a timeslice, only MediaRecorder's very first chunk carries the WebM
  // container header. Every later slice must be prefixed with it or the file is
  // undecodable and transcription silently returns nothing.
  const audioHeaderChunkRef = useRef(null);
  const highAccuracyRef = useRef(highAccuracy);
  const onInterimChangeRef = useRef(onInterimChange);
  const onSentenceCompleteRef = useRef(onSentenceComplete);
  const onErrorRef = useRef(onError);
  const [progress, setProgress] = useState(0);

  const platform = useMemo(() => {
    if (typeof window === 'undefined') {
      return { isMobile: false, isIOS: false, isAndroid: false, supported: false, unsupportedMessage: '' };
    }

    const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const detected = detectPlatform(window.navigator.userAgent, supported);

    return { ...detected, supported };
  }, []);

  const isSupported = platform.supported;

  useEffect(() => {
    onInterimChangeRef.current = onInterimChange;
    onSentenceCompleteRef.current = onSentenceComplete;
    onErrorRef.current = onError;
    highAccuracyRef.current = highAccuracy;
  }, [highAccuracy, onError, onInterimChange, onSentenceComplete]);

  const takeBufferedAudio = () => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || audioChunksRef.current.length === 0) {
      return null;
    }

    const header = audioHeaderChunkRef.current;
    const parts = audioChunksRef.current;
    // Only prepend when the header is not already the first part, which is the
    // case for the very first utterance of a session.
    const blobParts = header && parts[0] !== header ? [header, ...parts] : parts;

    const blob = new Blob(blobParts, { type: recorder.mimeType || 'audio/webm' });
    audioChunksRef.current = [];

    // A sub-kilobyte clip is silence or a truncated container; sending it wastes
    // a request and usually transcribes to nothing.
    return blob.size > 1024 ? blob : null;
  };

  const currentTranscript = () =>
    normalizeSpokenText(
      `${carryOverRef.current} ${finalTranscriptRef.current} ${interimTranscriptRef.current}`,
    );

  const clearCarryOver = () => {
    carryOverRef.current = '';
    clearTimeout(carryOverTimerRef.current);
    carryOverTimerRef.current = null;
  };

  const flushTranscript = () => {
    const text = currentTranscript();
    const normalizedText = text.replace(/\s+/g, ' ').toLowerCase();
    const now = Date.now();

    clearCarryOver();

    const isDuplicateSubmission =
      normalizedText &&
      lastSubmittedRef.current.text === normalizedText &&
      now - lastSubmittedRef.current.at < DUPLICATE_SUBMISSION_WINDOW;

    if (text && !isDuplicateSubmission) {
      const alternatives = alternativesRef.current.filter(
        (alternative) => alternative && alternative.toLowerCase() !== normalizedText,
      );
      const audioBlob = highAccuracyRef.current ? takeBufferedAudio() : null;

      console.log('Flushing captured text:', text, { alternatives, audioBytes: audioBlob?.size ?? 0 });

      lastSubmittedRef.current = { text: normalizedText, at: now };
      onSentenceCompleteRef.current?.(text, { alternatives, audioBlob });
    } else if (isDuplicateSubmission) {
      console.log('Skipping duplicate speech submission:', text);
    }

    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    alternativesRef.current = [];
    audioChunksRef.current = [];
    lastSpeechAtRef.current = null;
    silenceWindowRef.current = SILENCE_DURATION;
    setProgress(0);
    onInterimChangeRef.current?.('');
  };

  const resetCaptureState = () => {
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    alternativesRef.current = [];
    audioChunksRef.current = [];
    consumedResultIndexRef.current = 0;
    lastSpeechAtRef.current = null;
    silenceWindowRef.current = SILENCE_DURATION;
    restartAttemptsRef.current = 0;
    clearCarryOver();
  };

  // Mobile ends the recognition session after each utterance. If it ended
  // mid-question, hold the text for the next session instead of submitting half
  // a question -- but never hold it indefinitely, in case the speaker stopped.
  const holdForNextSession = (text) => {
    carryOverRef.current = text;
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';

    clearTimeout(carryOverTimerRef.current);
    carryOverTimerRef.current = window.setTimeout(() => {
      if (carryOverRef.current) {
        flushTranscript();
      }
    }, CARRY_OVER_TIMEOUT);
  };

  // Audio capture for the high-accuracy path. A second getUserMedia stream can
  // run alongside SpeechRecognition, so we keep a rolling buffer and slice off
  // whatever accumulated when an utterance completes.
  useEffect(() => {
    if (!isActive || !highAccuracy) {
      return undefined;
    }

    let cancelled = false;

    const startRecorder = async () => {
      try {
        const stream = await window.navigator.mediaDevices.getUserMedia({
          // Let the browser clean up the signal; on a phone held at arm's length
          // this matters more than anything the model can do downstream.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        mediaStreamRef.current = stream;

        // Pick a container the browser will actually produce. Android Chrome and
        // desktop Chrome differ here, and an unsupported mimeType throws.
        const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
        const mimeType = preferred.find((type) => window.MediaRecorder?.isTypeSupported?.(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) {
            return;
          }

          if (!audioHeaderChunkRef.current) {
            audioHeaderChunkRef.current = event.data;
          }

          audioChunksRef.current.push(event.data);

          if (audioChunksRef.current.length > MAX_BUFFERED_AUDIO_CHUNKS) {
            audioChunksRef.current.shift();
          }
        };

        recorder.start(AUDIO_TIMESLICE);
        mediaRecorderRef.current = recorder;
      } catch (error) {
        // On mobile this usually means the recognizer already owns the mic.
        // Report it as something the user can act on rather than a raw DOM error.
        onErrorRef.current?.(
          new Error(
            platform.isMobile
              ? 'High accuracy mode could not open the mic on this phone. Switch back to Fast mode.'
              : `Microphone access for high accuracy mode failed: ${error.message}`,
          ),
        );
      }
    };

    void startRecorder();

    return () => {
      cancelled = true;

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch (error) {
          console.warn('Could not stop recorder:', error);
        }
      }

      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
      audioChunksRef.current = [];
      // The next recorder emits its own header, so this one must not be reused.
      audioHeaderChunkRef.current = null;
    };
  }, [highAccuracy, isActive, platform.isMobile]);

  useEffect(() => {
    if (!isActive) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      resetCaptureState();
      lastSubmittedRef.current = { text: '', at: 0 };
      setProgress(0);
      onInterimChangeRef.current?.('');

      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
          isRecognitionRunningRef.current = false;
        } catch (error) {
          onErrorRef.current?.(error);
        }
      }

      return undefined;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      onErrorRef.current?.(new Error(platform.unsupportedMessage || 'Live mic needs Chrome.'));
      return undefined;
    }

    const isMobile = platform.isMobile;
    isMobileRef.current = isMobile;

    const scheduleRestart = (delay) => {
      if (!restartRequestedRef.current) {
        return;
      }

      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = window.setTimeout(() => {
        // Must be cleared, or the watchdog below sees a pending restart forever
        // and never steps in when one is genuinely needed.
        restartTimerRef.current = null;
        startRecognition();
      }, delay);
    };

    function startRecognition() {
      if (isRecognitionRunningRef.current || !restartRequestedRef.current) {
        return;
      }

      try {
        recognitionRef.current.start();
        isRecognitionRunningRef.current = true;
        restartAttemptsRef.current = 0;
      } catch (error) {
        // InvalidStateError just means it is already running; anything else gets
        // an exponential retry so a transient failure does not end the session.
        if (error.name === 'InvalidStateError') {
          isRecognitionRunningRef.current = true;
          return;
        }

        restartAttemptsRef.current += 1;
        const backoff = Math.min(MOBILE_RESTART_DELAY * 2 ** restartAttemptsRef.current, RESTART_BACKOFF_MAX);

        if (restartAttemptsRef.current <= 5) {
          scheduleRestart(backoff);
        } else {
          onErrorRef.current?.(new Error('Mic could not restart. Tap Stop then Start again.'));
        }
      }
    }

    if (!recognitionRef.current) {
      const recognition = new SpeechRecognition();
      recognition.continuous = !isMobile;
      recognition.interimResults = true;
      recognition.lang = 'en-IN';
      // The correct technical term is often in alternative 2 or 3 even when the
      // top hypothesis mangles it; the backend picks whichever carries the most
      // known vocabulary.
      recognition.maxAlternatives = MAX_ALTERNATIVES;

      recognition.onresult = (event) => {
        // Reading from the consumed cursor rather than 0 is what stops already
        // flushed sentences being submitted a second time.
        const { finalText, interimText, alternatives, combinedText } = accumulateResults(
          event.results,
          consumedResultIndexRef.current,
          MAX_ALTERNATIVES,
        );

        finalTranscriptRef.current = finalText;
        interimTranscriptRef.current = interimText;
        alternativesRef.current = alternatives;

        const combinedTranscript = combinedText;

        onInterimChangeRef.current?.(combinedTranscript);
        lastSpeechAtRef.current = Date.now();
        setProgress(0);

        // Give an unfinished sentence more room rather than cutting it in half.
        silenceWindowRef.current = looksIncomplete(combinedTranscript)
          ? FRAGMENT_SILENCE_DURATION
          : SILENCE_DURATION;

        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          consumedResultIndexRef.current = event.results.length;
          flushTranscript();
        }, silenceWindowRef.current);
      };

      recognition.onerror = (event) => {
        const kind = event.error;

        // Routine on mobile: the recognizer reports these constantly between
        // utterances. Surfacing them would spam the user with false alarms.
        if (kind === 'aborted' || kind === 'no-speech') {
          isRecognitionRunningRef.current = false;
          return;
        }

        isRecognitionRunningRef.current = false;

        if (kind === 'not-allowed' || kind === 'service-not-allowed') {
          restartRequestedRef.current = false;
          onErrorRef.current?.(
            new Error('Microphone permission is blocked. Allow mic access for this site, then start again.'),
          );
          return;
        }

        if (kind === 'audio-capture') {
          // Almost always mic contention: on mobile the recorder used by high
          // accuracy mode and the recognizer fight over one microphone.
          onErrorRef.current?.(
            highAccuracyRef.current
              ? new Error('Mic is busy. Turn off High accuracy on mobile and try again.')
              : new Error('No microphone available. Check that another app is not using it.'),
          );
          return;
        }

        if (kind === 'network') {
          // Transient; the watchdog and onend restart will recover it silently.
          return;
        }

        onErrorRef.current?.(new Error(kind || 'Speech recognition error'));
      };

      recognition.onend = () => {
        isRecognitionRunningRef.current = false;
        clearTimeout(silenceTimerRef.current);

        const pending = currentTranscript();

        if (pending) {
          // On mobile the session ends after every utterance, so an unfinished
          // sentence here is normal -- hold it rather than submitting a fragment.
          if (isMobileRef.current && looksIncomplete(pending)) {
            holdForNextSession(pending);
            onInterimChangeRef.current?.(pending);
          } else {
            flushTranscript();
          }
        }

        // A fresh recognition session restarts result indexing from zero.
        consumedResultIndexRef.current = 0;

        scheduleRestart(isMobileRef.current ? MOBILE_RESTART_DELAY : DESKTOP_RESTART_DELAY);
      };

      recognitionRef.current = recognition;
    }

    restartRequestedRef.current = true;
    restartAttemptsRef.current = 0;
    startRecognition();

    // Mobile recognizers can die without firing onend or onerror -- after a
    // screen dim, an incoming notification, or a brief app switch. Nothing else
    // notices, so the mic just stops working for the rest of the interview.
    // This is the safety net that brings it back.
    watchdogRef.current = window.setInterval(() => {
      if (restartRequestedRef.current && !isRecognitionRunningRef.current && !restartTimerRef.current) {
        console.log('Watchdog: recognition stopped unexpectedly, restarting');
        startRecognition();
      }
    }, WATCHDOG_INTERVAL);

    // Returning to the tab is the other common way mobile recovers.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && restartRequestedRef.current && !isRecognitionRunningRef.current) {
        restartAttemptsRef.current = 0;
        scheduleRestart(MOBILE_RESTART_DELAY);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      restartRequestedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(watchdogRef.current);
      watchdogRef.current = null;
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      clearTimeout(carryOverTimerRef.current);
      carryOverTimerRef.current = null;
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      if (!lastSpeechAtRef.current) {
        setProgress(0);
        return;
      }

      const elapsed = Date.now() - lastSpeechAtRef.current;
      setProgress(Math.min((elapsed / silenceWindowRef.current) * 100, 100));
    }, 50);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isActive, platform]);

  return { progress, isSupported, platform };
}
