function Header({ isListening, isSessionActive, onToggleSession, disabled }) {
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

        <button className="session-button" type="button" onClick={onToggleSession} disabled={disabled}>
          {isSessionActive ? 'Stop Session' : 'Start Session'}
        </button>
      </div>
    </header>
  );
}

export default Header;
