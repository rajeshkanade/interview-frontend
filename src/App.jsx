import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header';
import CapturePanel from './components/CapturePanel';
import QAHistory from './components/QAHistory';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useStreamAnswer } from './hooks/useStreamAnswer';
import { useVoiceInput } from './hooks/useVoiceInput';
import { looksIncomplete } from './hooks/transcriptUtils';

// 'api'     -- microphone audio goes to the transcription API. Accurate on
//              technical terms because the request carries a vocabulary bias
//              prompt, and utterance boundaries come from voice activity
//              detection rather than the browser recognizer.
// 'browser' -- the browser's own recognizer. Instant and free, but it mishears
//              domain terms and cannot be steered.
const DEFAULT_MODE = 'api';

function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [mode, setMode] = useState(DEFAULT_MODE);
  const [currentInterim, setCurrentInterim] = useState('');
  const [qaHistory, setQaHistory] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const { streamAnswer, streamAnswerFromAudio } = useStreamAnswer();
  const answerQueuesRef = useRef(new Map());
  const answerTimersRef = useRef(new Map());
  const sessionIdRef = useRef(null);
  // Text from an utterance the backend judged incomplete, prepended to whatever
  // the speaker says next so a paused question is not answered in halves. The
  // ref drives the logic (always current inside callbacks); the state mirrors it
  // purely so the capture panel can show what is being held.
  const pendingFragmentRef = useRef('');
  const [pendingFragment, setPendingFragment] = useState('');

  const setPending = useCallback((value) => {
    pendingFragmentRef.current = value;
    setPendingFragment(value);
  }, []);

  useEffect(
    () => () => {
      answerTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      answerTimersRef.current.clear();
      answerQueuesRef.current.clear();
    },
    [],
  );

  const flushAnswerQueue = useCallback((entryId) => {
    const queue = answerQueuesRef.current.get(entryId);

    if (!queue || queue.length === 0) {
      answerTimersRef.current.delete(entryId);
      return;
    }

    const nextToken = queue.shift();

    setQaHistory((previous) =>
      previous.map((entry) => (entry.id === entryId ? { ...entry, answer: `${entry.answer}${nextToken}` } : entry)),
    );

    const timerId = window.setTimeout(() => {
      flushAnswerQueue(entryId);
    }, 70);

    answerTimersRef.current.set(entryId, timerId);
  }, []);

  const enqueueAnswerChunk = useCallback(
    (entryId, chunk) => {
      const tokens = chunk.match(/\S+\s*|\s+/g) || [];

      if (tokens.length === 0) {
        return;
      }

      const queue = answerQueuesRef.current.get(entryId) || [];
      queue.push(...tokens);
      answerQueuesRef.current.set(entryId, queue);

      if (!answerTimersRef.current.has(entryId)) {
        flushAnswerQueue(entryId);
      }
    },
    [flushAnswerQueue],
  );

  const discardEntry = useCallback((entryId) => {
    const timerId = answerTimersRef.current.get(entryId);

    if (timerId) {
      window.clearTimeout(timerId);
      answerTimersRef.current.delete(entryId);
    }

    answerQueuesRef.current.delete(entryId);
    setQaHistory((previous) => previous.filter((entry) => entry.id !== entryId));
  }, []);

  const finishAnswerStream = useCallback((entryId) => {
    const settleCompletion = () => {
      const queue = answerQueuesRef.current.get(entryId);
      const timerId = answerTimersRef.current.get(entryId);

      if ((queue && queue.length > 0) || timerId) {
        window.setTimeout(settleCompletion, 80);
        return;
      }

      setQaHistory((previous) =>
        previous.map((entry) => (entry.id === entryId ? { ...entry, isStreaming: false } : entry)),
      );
    };

    settleCompletion();
  }, []);

  const submitUtterance = useCallback(
    ({ text = '', alternatives = [], audioBlob = null }) => {
      // Re-attach whatever the previous utterance left unfinished.
      const question = `${pendingFragmentRef.current} ${text}`.trim();
      setPending('');

      // The audio path has no transcript yet -- the server produces it -- so an
      // empty question is expected there and must not short-circuit.
      if (!question && !audioBlob) {
        return;
      }

      const entryId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      setQaHistory((previous) => [
        ...previous,
        { id: entryId, question: question || 'Transcribing…', answer: '', isStreaming: true },
      ]);

      const handlers = {
        question,
        sessionId: sessionIdRef.current,
        onTranscript: ({ sessionId, transcript, originalTranscript, corrections }) => {
          if (sessionId) {
            sessionIdRef.current = sessionId;
          }

          setQaHistory((previous) =>
            previous.map((entry) =>
              entry.id === entryId
                ? {
                    ...entry,
                    question: transcript || entry.question,
                    originalQuestion: originalTranscript,
                    corrections,
                  }
                : entry,
            ),
          );
        },
        onChunk: (chunk) => {
          enqueueAnswerChunk(entryId, chunk);
        },
        onSkip: () => {
          // Filler or the candidate speaking -- drop the placeholder instead of
          // leaving an empty bubble stuck in "thinking" forever.
          discardEntry(entryId);
        },
        onFragment: (partial) => {
          setPending(partial || question);
          discardEntry(entryId);
        },
        onDone: ({ skipped } = {}) => {
          if (!skipped) {
            finishAnswerStream(entryId);
          }
        },
        onError: (error) => {
          setErrorMessage(error.message || 'Unable to stream answer.');
          setQaHistory((previous) =>
            previous.map((entry) =>
              entry.id === entryId
                ? { ...entry, answer: entry.answer || 'Unable to fetch answer from backend.' }
                : entry,
            ),
          );
        },
      };

      if (audioBlob) {
        void streamAnswerFromAudio({ ...handlers, audioBlob });
        return;
      }

      void streamAnswer({ ...handlers, alternatives });
    },
    [discardEntry, enqueueAnswerChunk, finishAnswerStream, setPending, streamAnswer, streamAnswerFromAudio],
  );

  // Browser-recognizer path.
  const handleSentenceComplete = useCallback(
    (text, { alternatives = [], audioBlob = null } = {}) => {
      submitUtterance({ text, alternatives, audioBlob });
    },
    [submitUtterance],
  );

  // Audio path: VAD cut an utterance, so send the clip and let the server
  // transcribe it with the vocabulary bias prompt.
  const handleUtterance = useCallback(
    (audioBlob) => {
      submitUtterance({ audioBlob });
    },
    [submitUtterance],
  );

  const handleVoiceError = useCallback((error) => {
    setErrorMessage(error.message || 'Voice recognition failed.');
  }, []);

  const handleInterimChange = useCallback((text) => {
    setCurrentInterim(text);

    if (text) {
      setErrorMessage('');
    }
  }, []);

  // The held fragment tells the VAD to wait longer before cutting, so a paused
  // question is not chopped into pieces. A ref keeps it readable from the audio
  // frame loop without re-subscribing 20 times a second.
  const looksUnfinishedRef = useRef(false);
  // In api mode there is no interim transcript, and looksIncomplete('') is true
  // -- reading it there would pin the VAD to its long window on every utterance.
  looksUnfinishedRef.current =
    Boolean(pendingFragment) || (mode === 'browser' && Boolean(currentInterim) && looksIncomplete(currentInterim));

  const browserVoice = useVoiceInput({
    isActive: isSessionActive && mode === 'browser',
    onInterimChange: handleInterimChange,
    onSentenceComplete: handleSentenceComplete,
    onError: handleVoiceError,
  });

  const audioCapture = useAudioCapture({
    isActive: isSessionActive && mode === 'api',
    onUtterance: handleUtterance,
    onError: handleVoiceError,
    looksUnfinishedRef,
  });

  const { platform } = browserVoice;
  // Only the browser path depends on SpeechRecognition existing; the audio path
  // needs a microphone, which every mobile browser has.
  const isSupported = mode === 'api' ? true : browserVoice.isSupported;
  const progress = mode === 'api' ? audioCapture.progress : browserVoice.progress;

  const statusMessage = useMemo(() => {
    if (!isSupported) {
      return platform.unsupportedMessage || 'Live mic needs Chrome.';
    }

    return errorMessage;
  }, [errorMessage, isSupported, platform.unsupportedMessage]);

  const handleToggleSession = () => {
    if (!isSupported) {
      setErrorMessage(platform.unsupportedMessage || 'Live mic needs Chrome.');
      return;
    }

    setErrorMessage('');
    setCurrentInterim('');
    setPending('');
    setIsSessionActive((previous) => {
      const next = !previous;

      if (!next) {
        sessionIdRef.current = null;
      }

      return next;
    });
  };

  return (
    <main className="app-shell">
      <div className="background-grid" aria-hidden="true" />
      <div className="content">
        <Header
          isListening={isSessionActive}
          isSessionActive={isSessionActive}
          onToggleSession={handleToggleSession}
          disabled={!isSupported}
          mode={mode}
          onToggleMode={() => setMode((previous) => (previous === 'api' ? 'browser' : 'api'))}
          isMobile={platform.isMobile}
          browserSupported={browserVoice.isSupported}
        />

        <CapturePanel
          currentInterim={currentInterim}
          progress={progress}
          isSessionActive={isSessionActive}
          pendingFragment={pendingFragment}
          mode={mode}
          micLevel={audioCapture.level}
          isSpeaking={audioCapture.isSpeaking}
          micReady={audioCapture.isReady}
        />

        {statusMessage ? <div className="status-banner">{statusMessage}</div> : null}

        <QAHistory qaHistory={qaHistory} />
      </div>
    </main>
  );
}

export default App;
