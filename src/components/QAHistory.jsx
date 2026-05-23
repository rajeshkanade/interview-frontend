import AnswerBubble from './AnswerBubble';

function QAHistory({ qaHistory }) {
  return (
    <section className="history-panel">
      <div className="history-header">
        <h2>Q&A History</h2>
      </div>

      <div className="history-list">
        {qaHistory.length === 0 ? (
          <div className="empty-history">
            Questions you ask will appear here, and answers will stream in while the mic keeps listening.
          </div>
        ) : (
          qaHistory.map((entry) => (
            <article key={entry.id} className="qa-entry">
              <div className="question-row">
                <div className="question-bubble">{entry.question}</div>
              </div>
              <div className="answer-row">
                <AnswerBubble answer={entry.answer} isStreaming={entry.isStreaming} />
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export default QAHistory;
