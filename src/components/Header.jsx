const MODE_LABEL = {
  api: 'Accurate mic',
  browser: 'Fast mic',
};

function Header({
  isListening,
  isSessionActive,
  onToggleSession,
  disabled,
  mode,
  onToggleMode,
  isMobile,
  browserSupported,
}) {
  const isApi = mode === 'api';

  const modeTitle = isApi
    ? 'Your voice is transcribed by the API with a technical vocabulary hint, so terms like RAG, ReAct and FAISS come through correctly. Answers start about a second later.'
    : browserSupported
      ? 'The browser transcribes locally. Instant, but it mishears technical terms and cannot be corrected for them.'
      : 'This browser has no built-in speech recognition, so Fast mic will not work here.';

  return (
    <header className="header-panel">
      <div>
        <p className="eyebrow">Live Interview Assistant</p>
        <h1>Interview Coach AI</h1>
      </div>

      <div className="header-actions">
        <div className={`listening-indicator ${isListening ? 'active' : ''}`}>
          <span className="pulse-dot" />
          <span>{isListening ? 'Listening...' : 'Mic idle'}</span>
        </div>

        <button
          className={`accuracy-toggle ${isApi ? 'on' : ''}`}
          type="button"
          onClick={onToggleMode}
          aria-pressed={isApi}
          title={modeTitle}
        >
          <span className="accuracy-dot" aria-hidden="true" />
          {MODE_LABEL[mode]}
          {isMobile && !isApi ? <span className="mode-warning"> · may miss words</span> : null}
        </button>

        <button className="session-button" type="button" onClick={onToggleSession} disabled={disabled}>
          {isSessionActive ? 'Stop Session' : 'Start Session'}
        </button>
      </div>
    </header>
  );
}

export default Header;
