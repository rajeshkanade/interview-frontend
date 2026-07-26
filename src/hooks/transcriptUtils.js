// Pure transcript helpers, deliberately free of any React import so they can be
// imported and tested directly by Node (see transcriptUtils.test.mjs) without a
// test framework or a DOM. useVoiceInput.js is the only consumer.

// Mirrors _TRAILING_INCOMPLETE in the backend's classify.py. Kept in sync by
// hand; a false positive here only delays submission, so this list can be
// slightly more eager than the backend's.
const TRAILING_INCOMPLETE_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'about',
  'from', 'by', 'is', 'are', 'was', 'were', 'can', 'could', 'would', 'should',
  'will', 'your', 'my', 'our', 'their', 'its', 'how', 'what', 'why', 'when',
  'which', 'who', 'if', 'or', 'but', 'as', 'than', 'between', 'into', 'because',
  'while', 'where', 'some', 'any', 'very', 'do', 'does', 'did',
]);

// An auxiliary followed by a pronoun at the end still needs its main verb:
// "so how do you" is unfinished, "how about you" is not.
const TRAILING_AUXILIARIES = new Set([
  'do', 'does', 'did', 'have', 'has', 'had', 'are', 'is', 'was', 'were',
  'can', 'could', 'would', 'should', 'will', 'must', 'am',
]);

const TRAILING_PRONOUNS = new Set(['you', 'i', 'we', 'they', 'he', 'she', 'it']);

const QUESTION_WORDS = new Set([
  'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whose', 'explain',
  'describe', 'tell', 'give', 'walk', 'define', 'compare', 'difference', 'can',
  'could', 'would', 'do', 'does', 'did', 'is', 'are', 'have', 'has', 'should',
  'will', 'list', 'name',
]);

export function collapseRepeatedPhrases(words) {
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

export function normalizeSpokenText(text) {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();

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

export function looksIncomplete(text) {
  const words = (text || '').toLowerCase().match(/[a-z0-9']+/g) || [];

  if (words.length === 0) {
    return true;
  }

  if (TRAILING_INCOMPLETE_WORDS.has(words[words.length - 1])) {
    return true;
  }

  if (
    words.length >= 2 &&
    TRAILING_AUXILIARIES.has(words[words.length - 2]) &&
    TRAILING_PRONOUNS.has(words[words.length - 1])
  ) {
    return true;
  }

  return words.length < 3 && !words.some((word) => QUESTION_WORDS.has(word));
}

/**
 * Read a SpeechRecognition result list starting at `fromIndex`.
 *
 * This is where the double-submission bug lived. The browser keeps every
 * finalized result in `event.results` for the whole recognition session, so
 * reading from 0 on each event re-collects sentences that were already
 * submitted and sends them a second time. Callers must pass a cursor that
 * advances past everything already flushed.
 *
 * @param {object} results   SpeechRecognition results (array-like)
 * @param {number} fromIndex first unconsumed result index
 * @param {number} maxAlternatives cap on n-best hypotheses to collect
 */
export function accumulateResults(results, fromIndex, maxAlternatives = 3) {
  let finalText = '';
  let interimText = '';
  const alternatives = [];

  for (let index = fromIndex; index < results.length; index += 1) {
    const result = results[index];
    const transcript = result?.[0]?.transcript?.trim() ?? '';

    if (!transcript) {
      continue;
    }

    if (result.isFinal) {
      finalText += `${transcript} `;

      for (let choice = 1; choice < Math.min(result.length ?? 1, maxAlternatives); choice += 1) {
        const alternative = result[choice]?.transcript?.trim();

        if (alternative) {
          alternatives.push(alternative);
        }
      }
    } else {
      interimText += `${transcript} `;
    }
  }

  finalText = finalText.trim();
  interimText = interimText.trim();

  return {
    finalText,
    interimText,
    alternatives,
    combinedText: normalizeSpokenText(`${finalText} ${interimText}`),
  };
}

export function detectPlatform(userAgent = '', hasSpeechRecognition = true) {
  const ua = userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && 'ontouchend' in (globalThis.document || {}));
  const isAndroid = /Android/i.test(ua);

  return {
    isMobile: isIOS || isAndroid,
    isIOS,
    isAndroid,
    // Only the browser-recognizer mode needs SpeechRecognition. Accurate mic
    // mode just needs a microphone, which works everywhere including iOS -- so
    // the message points there rather than telling people to switch browser.
    // ("Install Chrome" is useless advice on iOS anyway: every iOS browser is
    // WebKit underneath.)
    unsupportedMessage: hasSpeechRecognition
      ? ''
      : isIOS
        ? 'Fast mic needs built-in speech recognition, which iPhone and iPad do not provide. Accurate mic works here — keep it switched on.'
        : 'Fast mic needs Chrome. Accurate mic works in this browser — keep it switched on.',
  };
}
