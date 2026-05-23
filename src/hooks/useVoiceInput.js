import { useEffect, useRef, useState } from 'react';

const SILENCE_DURATION = 1500;
const DUPLICATE_SUBMISSION_WINDOW = 2500;

function collapseRepeatedPhrases(words) {
  const result = [];
  let index = 0;

  while (index < words.length) {
    let collapsed = false;
    const maxPhraseLength = Math.min(6, Math.floor((words.length - index) / 2));

    for (let phraseLength = maxPhraseLength; phraseLength >= 1; phraseLength -= 1) {
      const phrase = words.slice(index, index + phraseLength).map((word) => word.toLowerCase());

      if (phrase.length === 0) {
        continue;
      }

      let repeatCount = 1;
      let cursor = index + phraseLength;

      while (cursor + phraseLength <= words.length) {
        const nextPhrase = words.slice(cursor, cursor + phraseLength).map((word) => word.toLowerCase());

        if (phrase.join(' ') !== nextPhrase.join(' ')) {
          break;
        }

        repeatCount += 1;
        cursor += phraseLength;
      }

      if (repeatCount > 1) {
        result.push(...words.slice(index, index + phraseLength));
        index += phraseLength * repeatCount;
        collapsed = true;
        break;
      }
    }

    if (!collapsed) {
      result.push(words[index]);
      index += 1;
    }
  }

  return result;
}

function normalizeSpokenText(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();

  if (!cleaned) {
    return '';
  }

  const words = cleaned.split(' ');
  const deduped = [];

  for (let index = 0; index < words.length; index += 1) {
    const currentWord = words[index];
    const previousWord = deduped[deduped.length - 1];

    if (previousWord && previousWord.toLowerCase() === currentWord.toLowerCase()) {
      continue;
    }

    deduped.push(currentWord);
  }

  return collapseRepeatedPhrases(deduped).join(' ');
}

export function useVoiceInput({ isActive, onInterimChange, onSentenceComplete, onError }) {
  const recognitionRef = useRef(null);
  const restartRequestedRef = useRef(false);
  const silenceTimerRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const interimTranscriptRef = useRef('');
  const lastSpeechAtRef = useRef(null);
  const lastSubmittedRef = useRef({ text: '', at: 0 });
  const onInterimChangeRef = useRef(onInterimChange);
  const onSentenceCompleteRef = useRef(onSentenceComplete);
  const onErrorRef = useRef(onError);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    onInterimChangeRef.current = onInterimChange;
    onSentenceCompleteRef.current = onSentenceComplete;
    onErrorRef.current = onError;
  }, [onError, onInterimChange, onSentenceComplete]);

  const flushTranscript = () => {
    const text = normalizeSpokenText(`${finalTranscriptRef.current} ${interimTranscriptRef.current}`);
    const normalizedText = text.replace(/\s+/g, ' ').toLowerCase();
    const now = Date.now();

    console.log('Flushing captured text:', text);

    const isDuplicateSubmission =
      normalizedText &&
      lastSubmittedRef.current.text === normalizedText &&
      now - lastSubmittedRef.current.at < DUPLICATE_SUBMISSION_WINDOW;

    if (text && !isDuplicateSubmission) {
      lastSubmittedRef.current = { text: normalizedText, at: now };
      onSentenceCompleteRef.current?.(text);
    } else if (isDuplicateSubmission) {
      console.log('Skipping duplicate mobile speech submission:', text);
    }

    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    lastSpeechAtRef.current = null;
    setProgress(0);
    onInterimChangeRef.current?.('');
  };

  useEffect(() => {
    if (!isActive) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
      finalTranscriptRef.current = '';
      interimTranscriptRef.current = '';
      lastSpeechAtRef.current = null;
      lastSubmittedRef.current = { text: '', at: 0 };
      setProgress(0);
      onInterimChangeRef.current?.('');
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (error) {
          onErrorRef.current?.(error);
        }
      }
      return undefined;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      onErrorRef.current?.(new Error('Please use Chrome'));
      return undefined;
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);

    if (!recognitionRef.current) {
      const recognition = new SpeechRecognition();
      recognition.continuous = !isMobile;
      recognition.interimResults = true;

      recognition.onresult = (event) => {
        let nextFinal = '';
        let nextInterim = '';

        for (let index = 0; index < event.results.length; index += 1) {
          const transcript = event.results[index][0].transcript.trim();

          if (!transcript) {
            continue;
          }

          if (event.results[index].isFinal) {
            nextFinal += `${transcript} `;
          } else {
            nextInterim += `${transcript} `;
          }
        }

        finalTranscriptRef.current = nextFinal.trim();
        interimTranscriptRef.current = nextInterim.trim();
        const combinedTranscript = normalizeSpokenText(`${finalTranscriptRef.current} ${interimTranscriptRef.current}`);

        console.log('Speech result:', {
          finalText: finalTranscriptRef.current,
          interimText: interimTranscriptRef.current,
          combinedText: combinedTranscript,
        });

        onInterimChangeRef.current?.(combinedTranscript);
        lastSpeechAtRef.current = Date.now();
        setProgress(0);

        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          console.log('Silence timer fired');
          flushTranscript();
        }, SILENCE_DURATION);
      };

      recognition.onspeechend = () => {
        console.log('Speech ended, waiting for silence window');
      };

      recognition.onerror = (event) => {
        if (event.error === 'aborted') {
          return;
        }

        onErrorRef.current?.(new Error(event.error || 'Speech recognition error'));
      };

      recognition.onend = () => {
        if (restartRequestedRef.current) {
          try {
            recognition.start();
          } catch (error) {
            window.setTimeout(() => {
              try {
                recognition.start();
              } catch (startError) {
                onErrorRef.current?.(startError);
              }
            }, 150);
          }
        }
      };

      recognitionRef.current = recognition;
    }

    restartRequestedRef.current = true;

    try {
      recognitionRef.current.start();
    } catch (error) {
      if (error.name !== 'InvalidStateError') {
        onError?.(error);
      }
    }

    return () => {
      restartRequestedRef.current = false;
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
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
      const nextProgress = Math.min((elapsed / SILENCE_DURATION) * 100, 100);
      setProgress(nextProgress);
    }, 50);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isActive]);

  return {
    progress,
    isSupported: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
  };
}
