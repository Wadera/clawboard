import { useEffect, useState } from 'react';
import './StatusIndicator.css';

export type StatusType = 'idle' | 'thinking' | 'working';

interface StatusIndicatorProps {
  status: StatusType;
  details?: string;
  subAgentCount?: number;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, details, subAgentCount }) => {
  const [bubbles, setBubbles] = useState<number[]>([]);

  useEffect(() => {
    // Generate random bubbles for animations
    if (status === 'thinking') {
      const interval = setInterval(() => {
        setBubbles(prev => [...prev.slice(-2), Date.now()]);
      }, 800);
      return () => clearInterval(interval);
    } else {
      setBubbles([]);
    }
  }, [status]);

  const getStatusConfig = () => {
    switch (status) {
      case 'idle':
        return {
          emoji: '😴',
          label: 'Idle',
          animation: 'zzz',
          color: '#6b7280'
        };
      case 'thinking':
        return {
          emoji: '🤔',
          label: 'Thinking',
          animation: 'pulse',
          color: '#8b5cf6'
        };
      case 'working':
        return {
          emoji: '⚙️',
          label: 'Working',
          animation: 'spin',
          color: '#f59e0b'
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div className="status-indicator" title={details || config.label}>
      <div className={`status-emoji ${config.animation}`}>
        {config.emoji}
      </div>
      <div className="status-details">
        <span className="status-label" style={{ color: config.color }}>
          {config.label}
          {subAgentCount !== undefined && subAgentCount > 0 && (
            <span className="sub-agent-count"> ({subAgentCount})</span>
          )}
        </span>
        {details && (
          <div className="status-tooltip">{details}</div>
        )}
        {status === 'idle' && (
          <div className="zzz-container">
            <span className="zzz zzz-1">z</span>
            <span className="zzz zzz-2">z</span>
            <span className="zzz zzz-3">z</span>
          </div>
        )}
        {status === 'thinking' && (
          <div className="thought-bubbles">
            {bubbles.map((key) => (
              <span key={key} className="thought-bubble">💭</span>
            ))}
          </div>
        )}
        {status === 'working' && (
          <div className="work-indicator">
            <span className="work-dot work-dot-1">●</span>
            <span className="work-dot work-dot-2">●</span>
            <span className="work-dot work-dot-3">●</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default StatusIndicator;
