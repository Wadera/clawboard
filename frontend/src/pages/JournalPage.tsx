import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useCallback } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, LayoutGrid, List } from 'lucide-react';
import { marked } from 'marked';
import './JournalPage.css';
import { useRealtimeStatus } from '../hooks/useRealtimeStatus';
import { useBotStatus } from '../hooks/useBotStatus';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface JournalEntry {
  id: string;
  date: string;
  mood: string | null;
  reflection_text: string;
  image_path: string | null;
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pageSize = 10;

  // Real-time status hooks
  const { status: realtimeStatus, connected } = useRealtimeStatus();
  const { status: botStatus } = useBotStatus();
  
  // Model status state
  const [modelStatus, setModelStatus] = useState<{ model: string; contextPercent: number } | null>(null);

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
    <div className="journal-page">
      <div className="journal-header">
        <BookOpen size={28} className="journal-header-icon" />
        <div>
          <h1 className="journal-title">Journal</h1>
          <p className="journal-subtitle">Daily reflections, thoughts & mood art</p>
        </div>
        <div className="journal-view-toggle">
          <button
            className={`journal-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => { setViewMode('grid'); setExpandedId(null); }}
            title="Grid view"
          >
            <LayoutGrid size={18} />
          </button>
          <button
            className={`journal-view-btn ${viewMode === 'timeline' ? 'active' : ''}`}
            onClick={() => { setViewMode('timeline'); setExpandedId(null); }}
            title="Timeline view"
          >
            <List size={18} />
          </button>
        </div>
      </div>

      {/* Status Card */}
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

          {/* Model info row */}
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
          </div>
        </div>

        {/* Avatar image on the right */}
        <div className="journal-status-avatar">
          {botStatus?.avatar_url ? (
            <img 
              src={botStatus.avatar_url} 
              alt="Bot's current mood" 
              className="journal-avatar-image"
            />
          ) : (
            <div className="journal-avatar-placeholder">
              <span className="journal-avatar-emoji">🌀</span>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="journal-loading">
          <div className="journal-loading-spinner" />
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
                <article
                  key={entry.id}
                  className={`journal-grid-card ${expandedId === entry.id ? 'expanded' : ''}`}
                  onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                >
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
                    {expandedId === entry.id && (
                      <div className="journal-grid-expanded">
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
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="journal-timeline">
              {entries.map((entry) => (
                <article key={entry.id} className="journal-entry">
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
