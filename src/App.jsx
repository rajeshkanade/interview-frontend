import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header';
import CapturePanel from './components/CapturePanel';
import QAHistory from './components/QAHistory';
import { useStreamAnswer } from './hooks/useStreamAnswer';
import { useVoiceInput } from './hooks/useVoiceInput';

function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [currentInterim, setCurrentInterim] = useState('');
  const [qaHistory, setQaHistory] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const { streamAnswer } = useStreamAnswer();
  const answerQueuesRef = useRef(new Map());
  const answerTimersRef = useRef(new Map());

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
      previous.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              answer: `${entry.answer}${nextToken}`,
            }
          : entry,
      ),
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

  const finishAnswerStream = useCallback((entryId) => {
    const settleCompletion = () => {
      const queue = answerQueuesRef.current.get(entryId);
      const timerId = answerTimersRef.current.get(entryId);

      if ((queue && queue.length > 0) || timerId) {
        window.setTimeout(settleCompletion, 80);
        return;
      }

      setQaHistory((previous) =>
        previous.map((entry) =>
          entry.id === entryId
            ? {
                ...entry,
                isStreaming: false,
              }
            : entry,
        ),
      );
    };

    settleCompletion();
  }, []);

  const handleSentenceComplete = useCallback(
    (text) => {
      const question = text.trim();

      if (!question) {
        return;
      }

      const entryId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      setQaHistory((previous) => [
        ...previous,
        {
          id: entryId,
          question,
          answer: '',
          isStreaming: true,
        },
      ]);

      void streamAnswer({
        question,
        onChunk: (chunk) => {
          enqueueAnswerChunk(entryId, chunk);
        },
        onDone: () => {
          finishAnswerStream(entryId);
        },
        onError: (error) => {
          setErrorMessage(error.message || 'Unable to stream answer.');
          setQaHistory((previous) =>
            previous.map((entry) =>
              entry.id === entryId
                ? {
                    ...entry,
                    answer: entry.answer || 'Unable to fetch answer from backend.',
                  }
                : entry,
            ),
          );
        },
      });
    },
    [enqueueAnswerChunk, finishAnswerStream, streamAnswer],
  );

  const handleVoiceError = useCallback((error) => {
    setErrorMessage(error.message || 'Voice recognition failed.');
  }, []);

  const handleInterimChange = useCallback(
    (text) => {
      setCurrentInterim(text);

      if (text) {
        setErrorMessage('');
      }
    },
    [isSessionActive],
  );

  const { progress, isSupported } = useVoiceInput({
    isActive: isSessionActive,
    onInterimChange: handleInterimChange,
    onSentenceComplete: handleSentenceComplete,
    onError: handleVoiceError,
  });

  const statusMessage = useMemo(() => {
    if (!isSupported) {
      return 'Please use Chrome';
    }

    return errorMessage;
  }, [errorMessage, isSupported]);

  const handleToggleSession = () => {
    if (!isSupported) {
      setErrorMessage('Please use Chrome');
      return;
    }

    setErrorMessage('');
    setCurrentInterim('');
    setIsSessionActive((previous) => {
      const next = !previous;
      return next;
    });
  };

  useEffect(() => {
    setIsListening(isSessionActive);
  }, [isSessionActive]);

  return (
    <main className="app-shell">
      <div className="background-grid" aria-hidden="true" />
      <div className="content">
        <Header
          isListening={isListening && isSessionActive}
          isSessionActive={isSessionActive}
          onToggleSession={handleToggleSession}
          disabled={!isSupported}
        />

        <CapturePanel currentInterim={currentInterim} progress={progress} isSessionActive={isSessionActive} />

        {statusMessage ? <div className="status-banner">{statusMessage}</div> : null}

        <QAHistory qaHistory={qaHistory} />
      </div>
    </main>
  );
}

export default App;
