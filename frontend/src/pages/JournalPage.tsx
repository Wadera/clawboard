import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BookOpen, ChevronLeft, ChevronRight, LayoutGrid, List, Clock, Music2, X } from 'lucide-react';
import { marked } from 'marked';
import './JournalPage.css';
import { useRealtimeStatus } from '../hooks/useRealtimeStatus';
import { useBotStatus } from '../hooks/useBotStatus';
import { useMindscapeUi } from '../contexts/MindscapeUiContext';
import { JournalLogsDrawer } from '../components/JournalLogsDrawer';

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

function journalMediaUrl(mediaPath: string): string {
  return mediaPath.startsWith('/journal-publication-media/')
    ? `${API_BASE_URL}${mediaPath}`
    : `${API_BASE_URL}/clawd-media/${mediaPath}`;
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

function StatusAvatarImage({
  status,
  alt,
  className,
  placeholderClassName = 'journal-avatar-placeholder',
  emojiClassName = 'journal-avatar-emoji',
  onOpen,
}: {
  status: BotStatusEntry | null | undefined;
  alt: string;
  className?: string;
  placeholderClassName?: string;
  emojiClassName?: string;
  onOpen?: (url: string) => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setBlobUrl(null);
    if (!status?.avatar_url) return;

    authenticatedFetch(`${API_BASE_URL}/nim-status/${encodeURIComponent(status.id)}/avatar`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setBlobUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [status?.id, status?.avatar_url]);

  if (!status?.avatar_url || !blobUrl) {
    return (
      <div className={placeholderClassName} aria-label="Generated status avatar pending">
        <span className={emojiClassName}>🌀</span>
      </div>
    );
  }

  return <img src={blobUrl} alt={alt} className={className} loading="lazy" onClick={() => onOpen?.(blobUrl)} />;
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
  const [logsOpen, setLogsOpen] = useState(false);
  const { openMindscape } = useMindscapeUi();
  const pageSize = 12;

  // Real-time status hooks
  const { status: realtimeStatus, connected } = useRealtimeStatus();
  const { status: botStatus } = useBotStatus();
  

  // Lightbox state
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Status history state
  const [showHistory, setShowHistory] = useState(false);
  const [statusHistory, setStatusHistory] = useState<BotStatusEntry[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);


  // Fetch status history
  const fetchHistory = useCallback(async (pg: number = 1) => {
    setHistoryLoading(true);
    try {
      const res = await authenticatedFetch(
        `${API_BASE_URL}/nim-status/history?page=${pg}&limit=10`
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
        <div className="journal-header-actions">
          <button className="journal-header-tool" onClick={() => setLogsOpen(true)} aria-label="Open journal pipeline logs"><Activity size={18}/><span>Logs</span></button>
          <button className="journal-header-tool journal-header-tool-primary" onClick={openMindscape} aria-label="Open Daily Mindscape player"><Music2 size={18}/><span>Mindscape</span></button>
        <div className="journal-view-toggle" role="group" aria-label="Journal view">
          <button
            className={`journal-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
            aria-pressed={viewMode === 'grid'}
          >
            <LayoutGrid size={18} />
          </button>
          <button
            className={`journal-view-btn ${viewMode === 'timeline' ? 'active' : ''}`}
            onClick={() => setViewMode('timeline')}
            aria-label="Timeline view"
            aria-pressed={viewMode === 'timeline'}
          >
            <List size={18} />
          </button>
        </div></div>
      </div>

      <JournalLogsDrawer open={logsOpen} onClose={() => setLogsOpen(false)} />

      {/* Status Card with NimOrb */}
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

          {/* History button */}
          <div className="journal-status-model-row">
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
          style={{ cursor: botStatus?.avatar_url ? 'pointer' : 'default' }}
          title={botStatus?.avatar_url ? 'Click to enlarge' : undefined}
        >
          <StatusAvatarImage
            status={botStatus}
            alt="Current generated status avatar"
            className="journal-avatar-image"
            onOpen={setLightboxUrl}
          />
        </div>
      </div>

      {/* Status History Timeline */}
      {showHistory && (
        <div className="journal-status-history">
          <h3 className="journal-history-title">Status History</h3>
          <div className="journal-history-timeline">
            {statusHistory.map((item, idx) => {
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
                  <div
                    className={`journal-history-thumb ${item.avatar_url ? '' : 'journal-history-thumb-empty'}`}
                    title={item.avatar_url ? 'Click to enlarge' : undefined}
                  >
                    <StatusAvatarImage
                      status={item}
                      alt={`Generated avatar from ${dateLabel}`}
                      placeholderClassName="journal-history-thumb-placeholder"
                      emojiClassName=""
                      onOpen={setLightboxUrl}
                    />
                  </div>
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
                        src={journalMediaUrl(entry.image_path)}
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
                          src={journalMediaUrl(entry.image_path)}
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
                          <source src={journalMediaUrl(entry.voice_path)} type="audio/mpeg" />
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
