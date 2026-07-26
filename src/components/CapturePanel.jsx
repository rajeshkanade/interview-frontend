// The accurate path sends audio, not text, so there is no interim transcript to
// show. A live level meter is the honest substitute: it proves the mic is
// actually hearing the room, which is what the interim text was really telling
// the user anyway.
const METER_BARS = 24;

function LevelMeter({ level, isSpeaking }) {
  // Speech RMS sits well under 1.0, so scale up before clamping or the meter
  // barely moves.
  const scaled = Math.min(level * 12, 1);
  const litBars = Math.round(scaled * METER_BARS);

  return (
    <div className={`level-meter ${isSpeaking ? 'speaking' : ''}`} aria-hidden="true">
      {Array.from({ length: METER_BARS }, (_, index) => (
        <span key={index} className={`level-bar ${index < litBars ? 'lit' : ''}`} />
      ))}
    </div>
  );
}

function CapturePanel({
  currentInterim,
  progress,
  isSessionActive,
  pendingFragment,
  mode,
  micLevel = 0,
  isSpeaking = false,
  micReady = false,
}) {
  const isApi = mode === 'api';

  return (
    <section className="capture-panel">
      <div className="capture-header">
        <span className="capture-label">Capturing...</span>
      </div>

      {pendingFragment ? (
        <div className="pending-fragment" title="Waiting for the rest of this question">
          <span className="pending-label">Holding</span>
          {pendingFragment}
        </div>
      ) : null}

      <div className={`capture-box ${isSessionActive ? 'active' : ''}`}>
        {isApi ? (
          <div className="capture-audio">
            <LevelMeter level={micLevel} isSpeaking={isSpeaking} />
            <span className={`capture-audio-status ${isSpeaking ? 'speaking' : ''}`}>
              {!isSessionActive
                ? 'Start a session to begin listening.'
                : !micReady
                  ? 'Waiting for microphone access...'
                  : isSpeaking
                    ? 'Hearing the question...'
                    : 'Listening for the next question.'}
            </span>
          </div>
        ) : (
          currentInterim || (
            <span className="capture-placeholder">
              {isSessionActive
                ? 'Your speech will appear here in real time.'
                : 'Start a session to begin live capture.'}
            </span>
          )
        )}
      </div>

      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </section>
  );
}

export default CapturePanel;
