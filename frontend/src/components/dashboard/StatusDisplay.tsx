import { authenticatedFetch } from '../../utils/auth';
import React, { useState, useEffect } from 'react';
import './StatusDisplay.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface BotStatus {
  id: string;
  mood: string;
  status_text: string;
  avatar_url: string | null;
  updated_at: string;
}

export const StatusDisplay: React.FC = () => {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStatus();
    
    // Refresh every 60 seconds
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/nim-status/current`);
      if (!response.ok) {
        if (response.status === 404) {
          setError('No status available');
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      if (data.success && data.status) {
        setStatus(data.status);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
      setError('Failed to load status');
    } finally {
      setLoading(false);
    }
  };

  const getMoodEmoji = (mood: string): string => {
    const moodMap: Record<string, string> = {
      happy: '😊',
      excited: '🤩',
      focused: '🧐',
      creative: '🎨',
      thinking: '🤔',
      relaxed: '😌',
      neutral: '😐',
      tired: '😴',
      curious: '🤨',
      energetic: '⚡',
    };
    return moodMap[mood.toLowerCase()] || '🙂';
  };

  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="status-display status-loading">
        <div className="loading-spinner" aria-label="Loading status" />
        <p>Loading status...</p>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="status-display status-error">
        <span className="error-icon">ℹ️</span>
        <p>{error || 'No status available'}</p>
      </div>
    );
  }

  return (
    <div className="status-display">
      <div className="status-header">
        <h2 className="status-title">Current Status</h2>
        <span className="status-timestamp" title={new Date(status.updated_at).toLocaleString()}>
          {formatTimestamp(status.updated_at)}
        </span>
      </div>
      
      <div className="status-content">
        <div className="status-mood">
          <span className="mood-emoji" aria-label={status.mood}>
            {getMoodEmoji(status.mood)}
          </span>
          <span className="mood-label">{status.mood}</span>
        </div>
        
        <p className="status-text">{status.status_text}</p>
        
        {status.avatar_url && (
          <div className="status-avatar">
            <img 
              src={status.avatar_url} 
              alt="Current avatar" 
              className="avatar-preview"
            />
          </div>
        )}
      </div>
    </div>
  );
};
