import { useCallback } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const SKIP = '[SKIP]';
const FRAGMENT = '[FRAGMENT]';
const DONE = '[DONE]';

// Headers are percent-encoded server-side because HTTP headers are latin-1 only.
function readHeader(response, name) {
  const raw = response.headers.get(name);

  if (!raw) {
    return '';
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function consumeStream({ response, question, onTranscript, onChunk, onSkip, onFragment, onDone }) {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error('Streaming not supported by this browser');
  }

  const correctedTranscript = readHeader(response, 'X-Transcript');
  const originalTranscript = readHeader(response, 'X-Original-Transcript');
  const corrections = readHeader(response, 'X-Corrections');

  onTranscript?.({
    sessionId: response.headers.get('X-Session-ID'),
    transcript: correctedTranscript || question,
    originalTranscript: originalTranscript || question,
    corrections: corrections ? corrections.split(' | ') : [],
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let terminated = false;
  // A sentinel can straddle two network chunks ("[DO" then "NE]"), so any
  // trailing text that could still become one is held back rather than shown.
  let heldTail = '';

  const longestSentinelPrefix = (text) => {
    for (const sentinel of [DONE, SKIP, FRAGMENT]) {
      for (let length = Math.min(sentinel.length - 1, text.length); length > 0; length -= 1) {
        if (text.endsWith(sentinel.slice(0, length))) {
          return length;
        }
      }
    }

    return 0;
  };

  const emit = (text, isFinal) => {
    const combined = heldTail + (text || '');

    if (!combined) {
      return;
    }

    heldTail = '';
    buffered += text || '';

    // Sentinels are handled explicitly rather than stripped. Stripping them left
    // an empty streaming bubble in the history for every filler utterance.
    if (combined.includes(SKIP)) {
      terminated = true;
      onSkip?.();
      return;
    }

    if (combined.includes(FRAGMENT)) {
      terminated = true;
      onFragment?.(correctedTranscript || question);
      return;
    }

    let visible = combined.replaceAll(DONE, '');

    if (!isFinal) {
      const holdBack = longestSentinelPrefix(visible);

      if (holdBack > 0) {
        heldTail = visible.slice(visible.length - holdBack);
        visible = visible.slice(0, visible.length - holdBack);
      }
    }

    if (visible) {
      onChunk?.(visible);
    }
  };

  while (!terminated) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    emit(decoder.decode(value, { stream: true }), false);
  }

  if (!terminated) {
    emit(decoder.decode(), true);
  }

  if (terminated) {
    // A skipped or fragmentary utterance produces no answer, so the caller must
    // still be told the exchange is over in order to clean up its placeholder.
    reader.cancel().catch(() => {});
  }

  onDone?.({ skipped: terminated });
}

export function useStreamAnswer() {
  const streamAnswer = useCallback(
    async ({ question, alternatives, sessionId, onTranscript, onChunk, onSkip, onFragment, onDone, onError, signal }) => {
      try {
        const response = await fetch(`${API_URL}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            session_id: sessionId,
            alternatives: alternatives?.length ? alternatives : undefined,
          }),
          signal,
        });

        await consumeStream({ response, question, onTranscript, onChunk, onSkip, onFragment, onDone });
      } catch (error) {
        if (error.name === 'AbortError') {
          return;
        }

        onError?.(error);
        onDone?.({ skipped: false });
      }
    },
    [],
  );

  // High-accuracy path: the raw audio goes to the OpenAI transcription API with
  // a vocabulary bias prompt, which handles domain terms the browser recognizer
  // cannot be steered toward.
  const streamAnswerFromAudio = useCallback(
    async ({ audioBlob, question, sessionId, onTranscript, onChunk, onSkip, onFragment, onDone, onError, signal }) => {
      try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'utterance.webm');

        if (sessionId) {
          formData.append('session_id', sessionId);
        }

        const response = await fetch(`${API_URL}/transcribe-and-answer`, {
          method: 'POST',
          body: formData,
          signal,
        });

        await consumeStream({ response, question, onTranscript, onChunk, onSkip, onFragment, onDone });
      } catch (error) {
        if (error.name === 'AbortError') {
          return;
        }

        onError?.(error);
        onDone?.({ skipped: false });
      }
    },
    [],
  );

  return { streamAnswer, streamAnswerFromAudio };
}
