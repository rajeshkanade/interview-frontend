import { useCallback } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export function useStreamAnswer() {
  const streamAnswer = useCallback(async ({ question, sessionId, onTranscript, onChunk, onDone, onError, signal }) => {
    try {
      const payload = { question, session_id: sessionId };

      console.log('Sending payload to backend:', payload);

      const response = await fetch(`${API_URL}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Streaming not supported by this browser');
      }

      const nextSessionId = response.headers.get('X-Session-ID');
      const correctedTranscript = response.headers.get('X-Transcript');
      const originalTranscript = response.headers.get('X-Original-Transcript');

      onTranscript?.({
        sessionId: nextSessionId,
        transcript: correctedTranscript || question,
        originalTranscript: originalTranscript || question,
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });

        if (chunk) {
          const visibleChunk = chunk.replaceAll('[DONE]', '').replaceAll('[SKIP]', '');

          if (visibleChunk) {
            onChunk?.(visibleChunk);
          }
        }
      }

      const lastChunk = decoder.decode().replaceAll('[DONE]', '').replaceAll('[SKIP]', '');

      if (lastChunk) {
        onChunk?.(lastChunk);
      }

      onDone?.();
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }

      onError?.(error);
      onDone?.();
    }
  }, []);

  return { streamAnswer };
}
