function AnswerBubble({ answer, isStreaming }) {
  return (
    <div className="answer-bubble">
      <p>{answer || 'Thinking through your answer...'}</p>
      {isStreaming ? <span className="answer-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

export default AnswerBubble;
