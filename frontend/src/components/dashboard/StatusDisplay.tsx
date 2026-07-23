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

interface HistoryResponse {
  success: boolean;
  history: BotStatus[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export const StatusDisplay: React.FC = () => {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFullAvatar, setShowFullAvatar] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<BotStatus[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<BotStatus | null>(null);

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

  const fetchHistory = async (page: number = 1) => {
    setHistoryLoading(true);
    try {
      const response = await authenticatedFetch(
        `${API_BASE_URL}/nim-status/history?page=${page}&limit=20`
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data: HistoryResponse = await response.json();
      if (data.success) {
        if (page === 1) {
          setHistory(data.history);
        } else {
          setHistory(prev => [...prev, ...data.history]);
        }
        setHasMoreHistory(data.hasMore);
        setHistoryPage(page);
      }
    } catch (err) {
      console.error('Failed to fetch history:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleShowHistory = () => {
    if (!showHistory && history.length === 0) {
      fetchHistory(1);
    }
    setShowHistory(!showHistory);
  };

  const handleLoadMore = () => {
    if (!historyLoading && hasMoreHistory) {
      fetchHistory(historyPage + 1);
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
        <div className="status-actions">
          <button 
            className="history-toggle-btn"
            onClick={handleShowHistory}
            aria-label={showHistory ? 'Hide history' : 'Show history'}
          >
            {showHistory ? '📖 Hide History' : '📖 Show History'}
          </button>
          <span className="status-timestamp" title={new Date(status.updated_at).toLocaleString()}>
            {formatTimestamp(status.updated_at)}
          </span>
        </div>
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
          <div 
            className="status-avatar" 
            onClick={() => setShowFullAvatar(true)}
            style={{ cursor: 'pointer' }}
            title="Click to enlarge"
          >
            <img 
              src={status.avatar_url} 
              alt="Current avatar" 
              className="avatar-preview"
            />
          </div>
        )}
      </div>

      {/* History Timeline */}
      {showHistory && (
        <div className="status-history">
          <h3 className="history-title">Status History</h3>
          <div className="history-timeline">
            {history.map((item) => (
              <div 
                key={item.id} 
                className="history-item"
                onClick={() => setSelectedHistoryItem(item)}
              >
                <div className="history-item-time">
                  {formatTimestamp(item.updated_at)}
                </div>
                <div className="history-item-content">
                  <span className="history-mood">{getMoodEmoji(item.mood)}</span>
                  <span className="history-mood-label">{item.mood}</span>
                  <p className="history-text">{item.status_text}</p>
                  {item.avatar_url && (
                    <img 
                      src={item.avatar_url} 
                      alt={`Avatar from ${item.updated_at}`}
                      className="history-avatar-thumb"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          
          {historyLoading && (
            <div className="history-loading">
              <div className="loading-spinner" />
            </div>
          )}
          
          {hasMoreHistory && !historyLoading && (
            <button 
              className="load-more-btn"
              onClick={handleLoadMore}
            >
              Load More
            </button>
          )}
        </div>
      )}

      {/* Full Avatar Lightbox */}
      {showFullAvatar && status.avatar_url && (
        <div 
          className="avatar-lightbox" 
          onClick={() => setShowFullAvatar(false)}
        >
          <img 
            src={status.avatar_url} 
            alt="Full size avatar" 
            className="avatar-full"
          />
        </div>
      )}

      {/* History Item Detail Modal */}
      {selectedHistoryItem && (
        <div 
          className="avatar-lightbox" 
          onClick={() => setSelectedHistoryItem(null)}
        >
          <div className="history-detail-modal" onClick={(e) => e.stopPropagation()}>
            <button 
              className="modal-close"
              onClick={() => setSelectedHistoryItem(null)}
            >
              ✕
            </button>
            <div className="history-detail-content">
              <div className="history-detail-header">
                <span className="history-detail-mood">
                  {getMoodEmoji(selectedHistoryItem.mood)} {selectedHistoryItem.mood}
                </span>
                <span className="history-detail-time">
                  {new Date(selectedHistoryItem.updated_at).toLocaleString()}
                </span>
              </div>
              <p className="history-detail-text">{selectedHistoryItem.status_text}</p>
              {selectedHistoryItem.avatar_url && (
                <img 
                  src={selectedHistoryItem.avatar_url} 
                  alt="Full avatar"
                  className="history-detail-avatar"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
