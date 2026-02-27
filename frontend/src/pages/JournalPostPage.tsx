import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react';
import { marked } from 'marked';
import { authenticatedFetch } from '../utils/auth';
import './JournalPostPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

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

interface NavigationInfo {
  previousId: string | null;
  nextId: string | null;
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

export function JournalPostPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [navigation, setNavigation] = useState<NavigationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    const fetchEntry = async () => {
      setLoading(true);
      setError(null);

      try {
        // Fetch the entry
        const entryRes = await authenticatedFetch(`${API_BASE_URL}/journal/${id}`);
        const entryData = await entryRes.json();

        if (!entryData.success) {
          throw new Error(entryData.error || 'Failed to fetch entry');
        }

        setEntry(entryData.entry);

        // Fetch navigation info
        const navRes = await authenticatedFetch(`${API_BASE_URL}/journal/${id}/navigation`);
        const navData = await navRes.json();

        if (navData.success) {
          setNavigation(navData.navigation);
        }
      } catch (err) {
        console.error('Failed to fetch journal entry:', err);
        setError(err instanceof Error ? err.message : 'Failed to load entry');
      } finally {
        setLoading(false);
      }
    };

    fetchEntry();
  }, [id]);

  if (loading) {
    return (
      <div className="journal-post-page">
        <div className="journal-post-loading">
          <div className="journal-loading-spinner" />
          <p>Loading entry...</p>
        </div>
      </div>
    );
  }

  if (error || !entry) {
    return (
      <div className="journal-post-page">
        <div className="journal-post-error">
          <h2>Entry not found</h2>
          <p>{error || 'The journal entry you are looking for does not exist.'}</p>
          <Link to="/journal" className="journal-post-back-link">
            <ArrowLeft size={16} />
            Back to Journal
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="journal-post-page">
      {/* Navigation bar */}
      <nav className="journal-post-nav">
        <Link to="/journal" className="journal-post-back-link">
          <ArrowLeft size={16} />
          Back to Journal
        </Link>

        <div className="journal-post-nav-buttons">
          {navigation?.previousId ? (
            <button
              onClick={() => navigate(`/journal/${navigation.previousId}`)}
              className="journal-post-nav-btn"
              title="Previous entry"
            >
              <ChevronLeft size={18} />
              Previous
            </button>
          ) : (
            <button className="journal-post-nav-btn" disabled>
              <ChevronLeft size={18} />
              Previous
            </button>
          )}

          {navigation?.nextId ? (
            <button
              onClick={() => navigate(`/journal/${navigation.nextId}`)}
              className="journal-post-nav-btn"
              title="Next entry"
            >
              Next
              <ChevronRight size={18} />
            </button>
          ) : (
            <button className="journal-post-nav-btn" disabled>
              Next
              <ChevronRight size={18} />
            </button>
          )}
        </div>
      </nav>

      {/* Entry content */}
      <article className="journal-post-article">
        {/* Header with date and mood */}
        <header className="journal-post-header">
          <div className="journal-post-mood">
            <span className="journal-post-mood-emoji">{getMoodEmoji(entry.mood)}</span>
            {entry.mood && <span className="journal-post-mood-tag">{entry.mood}</span>}
          </div>
          <h1 className="journal-post-date">{formatDate(entry.date)}</h1>
        </header>

        {/* Image */}
        {entry.image_path && (
          <div className="journal-post-image">
            <img
              src={`${API_BASE_URL}/clawd-media/${entry.image_path}`}
              alt={`Mood art for ${entry.date}`}
            />
          </div>
        )}

        {/* Audio player */}
        {entry.voice_path && (
          <div className="journal-post-audio">
            <div className="journal-post-audio-label">
              <span className="voice-icon">🎙️</span>
              <span>Listen to the narration</span>
            </div>
            <audio controls preload="metadata" className="journal-post-audio-player">
              <source
                src={`${API_BASE_URL}/clawd-media/${entry.voice_path}`}
                type="audio/mpeg"
              />
              Your browser does not support the audio element.
            </audio>
          </div>
        )}

        {/* Reflection text */}
        <div
          className="journal-post-text"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(entry.reflection_text),
          }}
        />

        {/* Highlights */}
        {entry.highlights && entry.highlights.length > 0 && (
          <div className="journal-post-highlights">
            <h3>✨ Highlights</h3>
            <ul>
              {entry.highlights.map((highlight, i) => (
                <li key={i}>{highlight}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer with timestamp */}
        <footer className="journal-post-footer">
          <span className="journal-post-created">
            Created {new Date(entry.created_at).toLocaleString('en-GB')}
          </span>
        </footer>
      </article>

      {/* Bottom navigation */}
      <nav className="journal-post-nav journal-post-nav-bottom">
        <Link to="/journal" className="journal-post-back-link">
          <ArrowLeft size={16} />
          Back to Journal
        </Link>

        <div className="journal-post-nav-buttons">
          {navigation?.previousId ? (
            <button
              onClick={() => navigate(`/journal/${navigation.previousId}`)}
              className="journal-post-nav-btn"
              title="Previous entry"
            >
              <ChevronLeft size={18} />
              Previous
            </button>
          ) : (
            <button className="journal-post-nav-btn" disabled>
              <ChevronLeft size={18} />
              Previous
            </button>
          )}

          {navigation?.nextId ? (
            <button
              onClick={() => navigate(`/journal/${navigation.nextId}`)}
              className="journal-post-nav-btn"
              title="Next entry"
            >
              Next
              <ChevronRight size={18} />
            </button>
          ) : (
            <button className="journal-post-nav-btn" disabled>
              Next
              <ChevronRight size={18} />
            </button>
          )}
        </div>
      </nav>
    </div>
  );
}
