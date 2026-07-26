import { useEffect, useRef, useState } from 'react';

import { createSegmenter, rms, VAD_DEFAULTS } from './vad';

// Small enough that an utterance boundary lands within one chunk, large enough
// that we are not allocating constantly.
const TIMESLICE_MS = 250;
// Chunks kept before speech onset, so the first phoneme is not clipped.
const PREROLL_CHUNKS = 2;
const MAX_CHUNKS = 160; // ~40s ceiling, matched to VAD maxUtteranceMs
const MIN_BLOB_BYTES = 2048;

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

/**
 * Microphone capture driven by voice activity detection.
 *
 * This is the accurate path: it owns the only getUserMedia stream, decides
 * utterance boundaries from the audio signal, and hands complete audio clips to
 * the caller for server-side transcription. It never touches SpeechRecognition,
 * so there is no mic contention and no dependency on the browser's recognizer.
 */
export function useAudioCapture({ isActive, onUtterance, onError, looksUnfinishedRef }) {
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const headerChunkRef = useRef(null);
  const onsetChunkIndexRef = useRef(0);
  const frameTimerRef = useRef(null);
  const segmenterRef = useRef(null);
  const onUtteranceRef = useRef(onUtterance);
  const onErrorRef = useRef(onError);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
    onErrorRef.current = onError;
  }, [onError, onUtterance]);

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    let cancelled = false;

    const cutUtterance = (discard) => {
      const start = Math.max(0, onsetChunkIndexRef.current - PREROLL_CHUNKS);
      const parts = chunksRef.current.slice(start);
      chunksRef.current = [];

      if (discard || parts.length === 0) {
        return;
      }

      const header = headerChunkRef.current;
      // Only the first chunk of a MediaRecorder session carries the container
      // header; without it every later clip is undecodable.
      const blobParts = header && parts[0] !== header ? [header, ...parts] : parts;
      const type = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(blobParts, { type });

      if (blob.size < MIN_BLOB_BYTES) {
        return;
      }

      onUtteranceRef.current?.(blob);
    };

    const start = async () => {
      try {
        const stream = await window.navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContextClass();
        // Mobile browsers hand back a suspended context until a gesture resumes
        // it; the session button is that gesture.
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.2;
        source.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          // Opus at 32 kbps is transparent for speech and roughly a third the
          // size of the browser default -- worth having on a phone's data plan,
          // and it shortens the upload before transcription can even start.
          audioBitsPerSecond: 32000,
        });

        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) {
            return;
          }

          if (!headerChunkRef.current) {
            headerChunkRef.current = event.data;
          }

          chunksRef.current.push(event.data);

          if (chunksRef.current.length > MAX_CHUNKS) {
            const dropped = chunksRef.current.length - MAX_CHUNKS;
            chunksRef.current.splice(0, dropped);
            onsetChunkIndexRef.current = Math.max(0, onsetChunkIndexRef.current - dropped);
          }
        };

        recorder.onerror = (event) => {
          onErrorRef.current?.(new Error(`Recorder error: ${event.error?.name || 'unknown'}`));
        };

        recorder.start(TIMESLICE_MS);
        recorderRef.current = recorder;

        const segmenter = createSegmenter();
        segmenterRef.current = segmenter;

        const buffer = new Float32Array(analyser.fftSize);

        frameTimerRef.current = window.setInterval(() => {
          if (!analyserRef.current) {
            return;
          }

          // getFloatTimeDomainData is the raw waveform; RMS over it is a good
          // cheap proxy for loudness.
          analyserRef.current.getFloatTimeDomainData(buffer);
          const currentLevel = rms(buffer);

          const event = segmenter.push(currentLevel, Boolean(looksUnfinishedRef?.current));

          setLevel(currentLevel);
          setProgress(segmenter.silenceProgress * 100);

          if (event === 'speech-start') {
            onsetChunkIndexRef.current = chunksRef.current.length;
            setIsSpeaking(true);
          } else if (event === 'speech-end') {
            setIsSpeaking(false);
            cutUtterance(false);
          } else if (event === 'speech-discard') {
            setIsSpeaking(false);
            cutUtterance(true);
          }
        }, VAD_DEFAULTS.frameMs);

        setIsReady(true);
      } catch (error) {
        const name = error?.name || '';
        const message =
          name === 'NotAllowedError'
            ? 'Microphone permission was denied. Allow mic access for this site, then start again.'
            : name === 'NotFoundError'
              ? 'No microphone found on this device.'
              : name === 'NotReadableError'
                ? 'The microphone is being used by another app. Close it and try again.'
                : `Could not start the microphone: ${error?.message || name}`;

        onErrorRef.current?.(new Error(message));
      }
    };

    void start();

    return () => {
      cancelled = true;
      setIsReady(false);
      setIsSpeaking(false);
      setLevel(0);
      setProgress(0);

      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;

      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch (error) {
          console.warn('Could not stop recorder:', error);
        }
      }

      audioContextRef.current?.close?.().catch?.(() => {});
      streamRef.current?.getTracks().forEach((track) => track.stop());

      recorderRef.current = null;
      audioContextRef.current = null;
      analyserRef.current = null;
      streamRef.current = null;
      segmenterRef.current = null;
      chunksRef.current = [];
      headerChunkRef.current = null;
      onsetChunkIndexRef.current = 0;
    };
  }, [isActive, looksUnfinishedRef]);

  // Mobile suspends the AudioContext when the tab is backgrounded; without this
  // the mic silently stops working for the rest of the session.
  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isActive]);

  return { isSpeaking, level, progress, isReady };
}
