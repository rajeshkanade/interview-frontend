import { useEffect, useRef } from 'react';
import AnswerBubble from './AnswerBubble';

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function QAHistory({ qaHistory }) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) {
      return;
    }

    listRef.current.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: 'smooth',
    });

    window.requestAnimationFrame(() => {
      listRef.current?.lastElementChild?.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
      });
    });
  }, [qaHistory]);

  return (
    <section className="history-panel">
      <div className="history-header">
        <h2>Q&A History</h2>
      </div>

      <div className="history-list" ref={listRef}>
        {qaHistory.length === 0 ? (
          <div className="empty-history">
            Questions you ask will appear here, and answers will stream in while the mic keeps listening.
          </div>
        ) : (
          qaHistory.map((entry) => {
            // Surface the raw transcript when a term was corrected, so the fix is
            // visible rather than silently changing what was asked.
            const showOriginal =
              entry.originalQuestion && normalize(entry.originalQuestion) !== normalize(entry.question);

            return (
              <article key={entry.id} className="qa-entry">
                <div className="question-row">
                  <div className="question-bubble">
                    {entry.question}
                    {showOriginal ? <span className="heard-as">heard: {entry.originalQuestion}</span> : null}
                  </div>
                </div>
                <div className="answer-row">
                  <AnswerBubble answer={entry.answer} isStreaming={entry.isStreaming} />
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

export default QAHistory;
