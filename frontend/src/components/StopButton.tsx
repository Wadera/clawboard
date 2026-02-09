import { authenticatedFetch } from '../utils/auth';
import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './StopButton.css';

interface StopButtonProps {
  variant: 'main' | 'agent' | 'emergency';
  /** For agent variant: the session key to stop */
  agentKey?: string;
  /** Whether bot is actively working (controls visibility for main variant) */
  isActive?: boolean;
  /** Called after stop completes */
  onStopped?: (success: boolean) => void;
}

export function StopButton({ variant, agentKey, isActive = false, onStopped }: StopButtonProps) {
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<'success' | 'error' | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const performStop = useCallback(async () => {
    setLoading(true);
    setStopping(true);
    setFeedback(null);

    try {
      let success = false;

      if (variant === 'main') {
        // Fetch the main session ID from the gateway queue, then abort it
        const queueRes = await authenticatedFetch(`${API_BASE}/gateway/queue`);
        const queueData = await queueRes.json();
        const mainSession = queueData.sessions?.find((s: any) => s.label === 'Main Session' || s.sessionKey?.endsWith(':main'));
        if (mainSession) {
          const res = await authenticatedFetch(`${API_BASE}/gateway/session/${mainSession.sessionId}/abort`, { method: 'POST' });
          const data = await res.json();
          success = data.success !== false;
        }
      } else if (variant === 'agent' && agentKey) {
        // agentKey could be sessionId or sessionKey — try abort by sessionId first
        const res = await authenticatedFetch(`${API_BASE}/gateway/session/${encodeURIComponent(agentKey)}/abort`, { method: 'POST' });
        const data = await res.json();
        success = data.success !== false;
      } else if (variant === 'emergency') {
        // Abort all non-idle sessions
        const queueRes = await authenticatedFetch(`${API_BASE}/gateway/queue`);
        const queueData = await queueRes.json();
        const activeSessions = queueData.sessions?.filter((s: any) => s.state !== 'idle') || [];
        const results = await Promise.all(
          activeSessions.map((s: any) =>
            authenticatedFetch(`${API_BASE}/gateway/session/${s.sessionId}/abort`, { method: 'POST' })
              .then(r => r.json())
              .catch(() => ({ success: false }))
          )
        );
        success = results.length === 0 || results.some((r: any) => r.success);
      }

      setFeedback(success ? 'success' : 'error');
      onStopped?.(success);

      // Clear feedback after 1.5s
      setTimeout(() => {
        setFeedback(null);
        setStopping(false);
      }, 1500);
    } catch {
      setFeedback('error');
      onStopped?.(false);
      setTimeout(() => {
        setFeedback(null);
        setStopping(false);
      }, 1500);
    } finally {
      setLoading(false);
      setShowConfirm(false);
    }
  }, [variant, agentKey, API_BASE, onStopped]);

  const handleClick = () => {
    // Only emergency needs confirmation
    if (variant === 'emergency') {
      setShowConfirm(true);
      return;
    }
    // Main and agent stops are instant
    performStop();
  };

  // Hide main button when idle
  if (variant === 'main' && !isActive && !loading && !feedback) {
    return null;
  }

  const label = (() => {
    if (feedback === 'success') return '✓ Stopped';
    if (feedback === 'error') return '✗ Failed';
    if (loading) return 'Stopping…';
    switch (variant) {
      case 'main': return '⏹ Stop Bot';
      case 'agent': return '⏹';
      case 'emergency': return '🛑 Emergency Stop All';
    }
  })();

  return (
    <>
      <button
        className={`stop-button ${variant} ${isActive ? 'active' : ''} ${stopping ? 'stopping' : ''}`}
        onClick={handleClick}
        disabled={loading}
        title={
          variant === 'main'
            ? 'Stop current task (Ctrl+Shift+X)'
            : variant === 'agent'
            ? `Stop agent: ${agentKey}`
            : 'Stop all sessions immediately'
        }
      >
        {loading ? <span className="stop-spinner" /> : null}
        {feedback ? <span className="stop-feedback">{label}</span> : label}
      </button>

      {showConfirm && createPortal(
        <div className="stop-confirm-overlay" onClick={() => setShowConfirm(false)}>
          <div className="stop-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="stop-confirm-title">
              🛑 Emergency Stop All
            </h3>
            <p className="stop-confirm-message">
              This will immediately stop the main session and ALL active sub-agents. Are you sure?
            </p>
            <div className="stop-confirm-actions">
              <button className="stop-confirm-cancel" onClick={() => setShowConfirm(false)}>
                Cancel
              </button>
              <button className="stop-confirm-confirm" onClick={performStop}>
                Stop Everything
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
