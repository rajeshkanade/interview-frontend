function CapturePanel({ currentInterim, progress, isSessionActive }) {
  return (
    <section className="capture-panel">
      <div className="capture-header">
        <span className="capture-label">Capturing...</span>
      </div>

      <div className={`capture-box ${isSessionActive ? 'active' : ''}`}>
        {currentInterim || (
          <span className="capture-placeholder">
            {isSessionActive ? 'Your speech will appear here in real time.' : 'Start a session to begin live capture.'}
          </span>
        )}
      </div>

      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </section>
  );
}

export default CapturePanel;
