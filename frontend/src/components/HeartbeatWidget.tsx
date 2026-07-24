import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect } from 'react';
import { Heart, Clock, ChevronDown, ChevronUp, Activity } from 'lucide-react';
import './HeartbeatWidget.css';

interface HeartbeatData {
  content: string;
  modified: string;
  size: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const HeartbeatWidget: React.FC = () => {
  const [heartbeat, setHeartbeat] = useState<HeartbeatData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [expanded, setExpanded] = useState(true);

  // Fetch HEARTBEAT.md
  const fetchHeartbeat = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/memory/heartbeat`);
      const data = await response.json();
      
      if (data.success) {
        setHeartbeat({
          content: data.content,
          modified: data.modified,
          size: data.size
        });
        setLastRefresh(new Date());
        setError(null);
      } else {
        setError(data.error || 'Failed to load HEARTBEAT');
      }
    } catch (err) {
      setError('Failed to fetch HEARTBEAT.md');
      console.error('Heartbeat fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchHeartbeat();
  }, []);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchHeartbeat();
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // Update "seconds ago" counter every second
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const diff = Math.floor((now.getTime() - lastRefresh.getTime()) / 1000);
      setSecondsAgo(diff);
    }, 1000);

    return () => clearInterval(interval);
  }, [lastRefresh]);

  // Extract first section from HEARTBEAT (Active Projects)
  const getActiveProjects = () => {
    if (!heartbeat) return '';
    
    // Get everything between "## Active Projects" and next "##"
    const match = heartbeat.content.match(/## Active Projects\n\n([\s\S]*?)(?=\n##|$)/);
    if (match && match[1]) {
      // Limit to first 500 chars
      return match[1].substring(0, 500).trim();
    }
    return heartbeat.content.substring(0, 300);
  };

  if (loading) {
    return (
      <div className="heartbeat-loading">
        <div className="heartbeat-loading-content">
          <Activity size={20} style={{ color: '#f97316' }} className="pulse" />
          <span>Loading mental state...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="heartbeat-error">
        <div className="heartbeat-error-content">
          <Heart size={20} />
          <span>Error: {error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="heartbeat-widget">
      <div className="heartbeat-header" onClick={() => setExpanded(!expanded)}>
        <div className="heartbeat-title-section">
          <div className="heartbeat-icon-wrapper">
            <Heart 
              className={`heartbeat-icon ${secondsAgo < 3 ? 'pulse' : ''}`}
              size={24} 
              fill={secondsAgo < 3 ? "currentColor" : "none"}
            />
            {secondsAgo > 25 && (
              <div className="heartbeat-ping" />
            )}
          </div>
          <div>
            <h3 className="heartbeat-title">💓 Mental State</h3>
            <div className="heartbeat-subtitle">
              <Clock size={12} />
              <span>
                {secondsAgo < 3 ? (
                  <span className="heartbeat-status-fresh">Just refreshed!</span>
                ) : secondsAgo > 25 ? (
                  <span className="heartbeat-status-refreshing">Refreshing...</span>
                ) : (
                  `Updated ${secondsAgo}s ago`
                )}
              </span>
            </div>
          </div>
        </div>
        
        <button 
          className="heartbeat-collapse-btn"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {expanded ? (
            <ChevronUp size={20} />
          ) : (
            <ChevronDown size={20} />
          )}
        </button>
      </div>

      {expanded && (
        <div className="heartbeat-content">
          <div className="heartbeat-text-box">
            <pre className="heartbeat-text">
              {getActiveProjects()}
            </pre>
          </div>
          
          <div className="heartbeat-footer">
            <span className="heartbeat-modified">
              Last modified: {new Date(heartbeat?.modified || '').toLocaleTimeString()}
            </span>
            <span className="heartbeat-size">
              {(heartbeat?.size || 0)} bytes
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
