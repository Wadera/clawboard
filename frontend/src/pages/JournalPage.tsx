import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronLeft, ChevronRight, LayoutGrid, List, Clock, X } from 'lucide-react';
import { marked } from 'marked';
import './JournalPage.css';
import { useRealtimeStatus } from '../hooks/useRealtimeStatus';
import { useBotStatus } from '../hooks/useBotStatus';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface BotStatusEntry {
  id: string;
  mood: string;
  status_text: string;
  avatar_url: string | null;
  updated_at: string;
}

interface HistoryResponse {
  success: boolean;
  history: BotStatusEntry[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Resolve avatar URL — ensures relative paths get the API base prefix.
 * Handles: full URLs (https://...), already-prefixed paths (/api/...),
 * and relative paths (/media/generated/...).
 */
function resolveAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Full URL — use as-is
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // Already has /api prefix
  if (url.startsWith('/api/')) return url;
  // Relative path like /media/generated/foo.png → prepend API base
  if (url.startsWith('/')) return `${API_BASE_URL}${url}`;
  // Bare filename — assume generated
  return `${API_BASE_URL}/media/generated/${url}`;
}

interface JournalEntry {
  id: string;
  date: string;
  mood: string | null;
  reflection_text: string;
  image_path: string | null;
  voice_path: string | null;
  highlights: string[] | null;
  created_at: string;
}

const MOOD_EMOJIS: Record<string, string> = {
  excited: '🤩',
  curious: '🧐',
  proud: '🥹',
  tired: '😴',
  focused: '🎯',
  happy: '😊',
  creative: '🎨',
  grateful: '🙏',
  reflective: '🪞',
  energized: '⚡',
  calm: '🌊',
  determined: '💪',
  playful: '🎭',
  nostalgic: '🌅',
  inspired: '✨',
};

function getMoodEmoji(mood: string | null): string {
  if (!mood) return '📝';
  return MOOD_EMOJIS[mood.toLowerCase()] || '📝';
}

function formatDate(dateStr: string): string {
  // Handle both "2026-01-31" and "2026-01-31T00:00:00.000Z" formats
  const cleanDate = dateStr.split('T')[0];
  const date = new Date(cleanDate + 'T12:00:00');
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function renderMarkdown(text: string): string {
  marked.setOptions({ breaks: true, gfm: true });
  return marked.parse(text) as string;
}

// Get state emoji and display text
function getStateDisplay(state: string) {
  switch (state) {
    case 'thinking':
      return { emoji: '🤔', text: 'Thinking', color: '#FFD700' };
    case 'typing':
      return { emoji: '✍️', text: 'Typing', color: '#4CAF50' };
    case 'tool-use':
      return { emoji: '🛠️', text: 'Working', color: '#FF9800' };
    case 'waiting':
      return { emoji: '⏳', text: 'Processing', color: '#2196F3' };
    case 'error':
      return { emoji: '⚠️', text: 'Error', color: '#F44336' };
    default:
      return { emoji: '😴', text: 'Idle', color: '#9E9E9E' };
  }
}

export function JournalPage() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'timeline' | 'grid'>('grid');
  const pageSize = 12;

  // Real-time status hooks
  const { status: realtimeStatus, connected } = useRealtimeStatus();
  const { status: botStatus } = useBotStatus();
  
  // Model status state
  const [modelStatus, setModelStatus] = useState<{ model: string; contextPercent: number } | null>(null);

  // Lightbox state
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Status history state
  const [showHistory, setShowHistory] = useState(false);
  const [statusHistory, setStatusHistory] = useState<BotStatusEntry[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);

  // Fetch model status
  useEffect(() => {
    const fetchModelStatus = async () => {
      try {
        const res = await authenticatedFetch(`${API_BASE_URL}/model-status`);
        if (res.ok) {
          const data = await res.json();
          if (data.success !== false) {
            setModelStatus({
              model: data.modelAlias || data.model || 'Unknown',
              contextPercent: data.contextUsage?.percent || 0,
            });
          }
        }
      } catch {
        // Silently fail
      }
    };
    fetchModelStatus();
    const interval = setInterval(fetchModelStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch status history
  const fetchHistory = useCallback(async (pg: number = 1) => {
    setHistoryLoading(true);
    try {
      const res = await authenticatedFetch(
        `${API_BASE_URL}/bot-status/history?page=${pg}&limit=10`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HistoryResponse = await res.json();
      if (data.success) {
        setStatusHistory(prev => pg === 1 ? data.history : [...prev, ...data.history]);
        setHasMoreHistory(data.hasMore);
        setHistoryPage(pg);
      }
    } catch (err) {
      console.error('Failed to fetch status history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleShowHistory = () => {
    if (!showHistory && statusHistory.length === 0) {
      fetchHistory(1);
    }
    setShowHistory(prev => !prev);
  };

  const handleLoadMore = () => {
    if (!historyLoading && hasMoreHistory) {
      fetchHistory(historyPage + 1);
    }
  };

  // Close lightbox on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && lightboxUrl) {
        setLightboxUrl(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [lightboxUrl]);

  // Get status message and state
  const statusMessage = botStatus?.status_text || "Building something amazing...";
  const currentState = realtimeStatus?.main?.state || 'idle';
  const stateDisplay = getStateDisplay(currentState);
  const resolvedAvatarUrl = resolveAvatarUrl(botStatus?.avatar_url);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch(
        `${API_BASE_URL}/journal?limit=${pageSize}&offset=${page * pageSize}`
      );
      const data = await res.json();
      if (data.success) {
        setEntries(data.entries);
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch journal entries:', err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="journal-page fade-in">
      <div className="journal-header">
        <BookOpen size={28} className="journal-header-icon" />
        <div>
          <h1 className="journal-title">Journal</h1>
          <p className="journal-subtitle">Daily reflections, thoughts & mood art</p>
        </div>
        <div className="journal-view-toggle">
          <button
            className={`journal-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <LayoutGrid size={18} />
          </button>
          <button
            className={`journal-view-btn ${viewMode === 'timeline' ? 'active' : ''}`}
            onClick={() => setViewMode('timeline')}
            title="Timeline view"
          >
            <List size={18} />
          </button>
        </div>
      </div>

      {/* Status Card with Avatar Orb */}
      <div className="journal-status-card">
        <div className="journal-status-content">
          {/* State row */}
          <div className="journal-status-state-row">
            <span className="journal-status-emoji">{stateDisplay.emoji}</span>
            <span className="journal-status-state-text" style={{ color: stateDisplay.color }}>
              {stateDisplay.text}
            </span>
            <div className={`journal-status-online ${connected ? 'online' : 'offline'}`}>
              <span className="journal-status-online-dot" />
              <span>{connected ? 'Online' : 'Offline'}</span>
            </div>
          </div>

          {/* Full status message */}
          <p className="journal-status-message">
            "{statusMessage}"
          </p>

          {/* Model info row + History button */}
          <div className="journal-status-model-row">
            <div className="journal-status-model">
              <span className="journal-status-model-icon">🤖</span>
              <span className="journal-status-model-name">{modelStatus?.model || 'Loading...'}</span>
            </div>
            <div className="journal-status-context">
              <span className="journal-status-context-icon">📊</span>
              <span className="journal-status-context-value">
                {modelStatus ? `${modelStatus.contextPercent}% context` : '—'}
              </span>
            </div>
            <button
              className="journal-history-toggle-btn"
              onClick={handleShowHistory}
              aria-label={showHistory ? 'Hide status history' : 'Show status history'}
            >
              <Clock size={14} />
              <span>{showHistory ? 'Hide history' : 'History'}</span>
            </button>
          </div>
        </div>

        {/* Avatar image on the right — clickable for lightbox */}
        <div
          className="journal-status-avatar"
          onClick={() => resolvedAvatarUrl && setLightboxUrl(resolvedAvatarUrl)}
          style={{ cursor: resolvedAvatarUrl ? 'pointer' : 'default' }}
          title={resolvedAvatarUrl ? 'Click to enlarge' : undefined}
        >
          {resolvedAvatarUrl ? (
            <img 
              src={resolvedAvatarUrl} 
              alt="Current mood" 
              className="journal-avatar-image"
            />
          ) : (
            <div className="journal-avatar-placeholder">
              <span className="journal-avatar-emoji">🌀</span>
            </div>
          )}
        </div>
      </div>

      {/* Status History Timeline */}
      {showHistory && (
        <div className="journal-status-history">
          <h3 className="journal-history-title">Status History</h3>
          <div className="journal-history-timeline">
            {statusHistory.map((item, idx) => {
              const itemAvatarUrl = resolveAvatarUrl(item.avatar_url);
              const itemDate = new Date(item.updated_at);
              const dateLabel = itemDate.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              });
              const timeLabel = itemDate.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
              });

              return (
                <div key={item.id} className="journal-history-entry">
                  {/* Date column (left of line) */}
                  <div className="journal-history-date">
                    <span className="journal-history-date-label">{dateLabel}</span>
                    <span className="journal-history-time-label">{timeLabel}</span>
                  </div>

                  {/* Timeline dot + connecting line */}
                  <div className="journal-history-line">
                    <span className="journal-history-dot" />
                    {idx < statusHistory.length - 1 && (
                      <span className="journal-history-connector" />
                    )}
                  </div>

                  {/* Content card (right of line) */}
                  <div className="journal-history-card">
                    <div className="journal-history-card-header" data-date={`${dateLabel} ${timeLabel}`}>
                      <span className="journal-history-mood-emoji">
                        {getMoodEmoji(item.mood)}
                      </span>
                      <span className="journal-history-mood-label">{item.mood}</span>
                    </div>
                    <p className="journal-history-text">{item.status_text}</p>
                  </div>

                  {/* Avatar thumbnail (far right, clickable) */}
                  {itemAvatarUrl ? (
                    <div
                      className="journal-history-thumb"
                      onClick={() => setLightboxUrl(itemAvatarUrl)}
                      title="Click to enlarge"
                    >
                      <img
                        src={itemAvatarUrl}
                        alt={`Avatar from ${dateLabel}`}
                        loading="lazy"
                      />
                    </div>
                  ) : (
                    <div className="journal-history-thumb journal-history-thumb-empty">
                      <span>🌀</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Loading indicator */}
          {historyLoading && (
            <div className="journal-history-loading">
              <div className="journal-loading-spinner" />
            </div>
          )}

          {/* Load more button */}
          {hasMoreHistory && !historyLoading && (
            <button
              className="journal-history-load-more"
              onClick={handleLoadMore}
            >
              Load more
            </button>
          )}

          {!historyLoading && statusHistory.length === 0 && (
            <p className="journal-history-empty">No status history available.</p>
          )}
        </div>
      )}

      {/* Avatar Lightbox */}
      {lightboxUrl && (
        <div
          className="journal-lightbox-overlay"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            className="journal-lightbox-close"
            onClick={() => setLightboxUrl(null)}
            aria-label="Close lightbox"
          >
            <X size={24} />
          </button>
          <img
            src={lightboxUrl}
            alt="Full size avatar"
            className="journal-lightbox-image"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {loading ? (
        <div className="page-loading">
          <div className="loading-spinner" />
          <p>Loading entries...</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="journal-empty">
          <BookOpen size={48} />
          <h2>No entries yet</h2>
          <p>Journal entries will appear here as your bot reflects.</p>
        </div>
      ) : (
        <>
          {viewMode === 'grid' ? (
            <div className="journal-grid">
              {entries.map((entry) => (
                <Link
                  key={entry.id}
                  to={`/journal/${entry.id}`}
                  className="journal-grid-card-link"
                >
                  <article className="journal-grid-card">
                  {entry.image_path && (
                    <div className="journal-grid-art">
                      <img
                        src={`${API_BASE_URL}/clawd-media/${entry.image_path}`}
                        alt={`Mood art for ${entry.date}`}
                        loading="lazy"
                      />
                    </div>
                  )}
                  <div className="journal-grid-info">
                    <div className="journal-grid-date-row">
                      <span className="journal-entry-mood-emoji">
                        {getMoodEmoji(entry.mood)}
                      </span>
                      <time className="journal-grid-date">
                        {formatDate(entry.date)}
                      </time>
                    </div>
                    {entry.mood && (
                      <span className="journal-entry-mood-tag">
                        {entry.mood}
                      </span>
                    )}
                  </div>
                </article>
                </Link>
              ))}
            </div>
          ) : (
            <div className="journal-timeline">
              {entries.map((entry) => (
                <Link key={entry.id} to={`/journal/${entry.id}`} className="journal-entry-link">
                  <article className="journal-entry">
                  <div className="journal-entry-date-bar">
                    <span className="journal-entry-mood-emoji">
                      {getMoodEmoji(entry.mood)}
                    </span>
                    <time className="journal-entry-date">
                      {formatDate(entry.date)}
                    </time>
                    {entry.mood && (
                      <span className="journal-entry-mood-tag">
                        {entry.mood}
                      </span>
                    )}
                  </div>

                  <div className="journal-entry-body">
                    {entry.image_path && (
                      <div className="journal-entry-art">
                        <img
                          src={`${API_BASE_URL}/clawd-media/${entry.image_path}`}
                          alt={`Mood art for ${entry.date}`}
                          loading="lazy"
                        />
                      </div>
                    )}

                    {entry.voice_path && (
                      <div className="journal-voice-player">
                        <div className="voice-player-label">
                          <span className="voice-icon">🎙️</span>
                          <span>Listen to the narration</span>
                        </div>
                        <audio controls preload="metadata" className="voice-audio">
                          <source src={`${API_BASE_URL}/clawd-media/${entry.voice_path}`} type="audio/mpeg" />
                        </audio>
                      </div>
                    )}

                    <div
                      className="journal-entry-text"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(entry.reflection_text),
                      }}
                    />

                    {entry.highlights && entry.highlights.length > 0 && (
                      <div className="journal-entry-highlights">
                        <h4>✨ Highlights</h4>
                        <ul>
                          {entry.highlights.map((h, i) => (
                            <li key={i}>{h}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </article>
                </Link>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="journal-pagination">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="journal-page-btn"
              >
                <ChevronLeft size={16} /> Newer
              </button>
              <span className="journal-page-info">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="journal-page-btn"
              >
                Older <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
