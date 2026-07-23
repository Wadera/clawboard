import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Bot, ArrowLeft, Star, ExternalLink, CheckCircle, Clock } from 'lucide-react';
import { AgentTypeDetail, getAgentTypeColor } from '../types/agentType';
import { authenticatedFetch } from '../utils/auth';
import './AgentTypeDetailPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const AgentTypeDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AgentTypeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetch_ = async () => {
      try {
        setLoading(true);
        const res = await authenticatedFetch(`${API_BASE_URL}/agent-types/${id}`);
        const data = await res.json();
        if (data.success) {
          setDetail({ ...data.agentType, linkedSessions: data.linkedSessions, linkedTasks: data.linkedTasks });
        } else {
          setError(data.error || 'Not found');
        }
      } catch {
        setError('Failed to load');
      } finally {
        setLoading(false);
      }
    };
    fetch_();
  }, [id]);

  if (loading) return <div className="agent-detail-loading">Loading...</div>;
  if (error) return <div className="agent-detail-error">{error}</div>;
  if (!detail) return null;

  const color = getAgentTypeColor(detail.color);

  // Parse markdown content sections for a nicer display
  const sections = detail.content ? parseMarkdownSections(detail.content) : [];

  return (
    <div className="agent-detail-page">
      <div className="agent-detail-nav">
        <button className="back-btn" onClick={() => navigate('/agent-types')}>
          <ArrowLeft size={14} /> Agent Types
        </button>
      </div>

      <div className="agent-detail-header" style={{ '--agent-color': color } as React.CSSProperties}>
        <div className="agent-detail-accent" />
        <div className="agent-detail-hero">
          <div className="agent-detail-icon">
            <Bot size={32} color={color} />
          </div>
          <div className="agent-detail-meta">
            <div className="agent-detail-name-row">
              <h1>{detail.name}</h1>
              {detail.is_custom && (
                <span className="agent-custom-badge" title="Custom persona">
                  <Star size={14} /> Custom
                </span>
              )}
            </div>
            {detail.category && (
              <span className="agent-detail-category">{detail.category}</span>
            )}
            {detail.description && (
              <p className="agent-detail-desc">{detail.description}</p>
            )}
          </div>
        </div>
      </div>

      <div className="agent-detail-layout">
        <div className="agent-detail-main">
          {sections.length > 0 ? (
            <div className="agent-detail-sections">
              {sections.map((section, i) => (
                <div key={i} className="agent-section">
                  {section.heading && <h2 className="agent-section-heading">{section.heading}</h2>}
                  <div className="agent-section-content" dangerouslySetInnerHTML={{ __html: simpleMarkdown(section.body) }} />
                </div>
              ))}
            </div>
          ) : (
            <pre className="agent-detail-raw">{detail.content}</pre>
          )}
        </div>

        <div className="agent-detail-sidebar">
          {/* Linked Tasks */}
          <div className="agent-sidebar-section">
            <h3>Linked Tasks <span className="count-badge">{detail.linkedTasks.length}</span></h3>
            {detail.linkedTasks.length === 0 ? (
              <p className="sidebar-empty">No tasks yet</p>
            ) : (
              <ul className="linked-list">
                {detail.linkedTasks.map(task => (
                  <li key={task.id}>
                    <Link to={`/tasks?id=${task.id}`} className="linked-task">
                      <span className={`task-status-dot status-${task.status}`} />
                      <span className="linked-title">{task.title}</span>
                      <ExternalLink size={11} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Linked Sessions */}
          <div className="agent-sidebar-section">
            <h3>Linked Sessions <span className="count-badge">{detail.linkedSessions.length}</span></h3>
            {detail.linkedSessions.length === 0 ? (
              <p className="sidebar-empty">No sessions yet</p>
            ) : (
              <ul className="linked-list">
                {detail.linkedSessions.map(sess => (
                  <li key={sess.session_key}>
                    <Link to={`/sessions?key=${encodeURIComponent(sess.session_key)}`} className="linked-session">
                      {sess.ended_at ? <CheckCircle size={12} /> : <Clock size={12} />}
                      <span className="linked-title">{sess.label || sess.session_key}</span>
                      {sess.total_cost_usd != null && (
                        <span className="session-cost">${sess.total_cost_usd.toFixed(4)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Splits markdown into heading+body sections */
function parseMarkdownSections(md: string): Array<{ heading: string; body: string }> {
  // Skip frontmatter
  const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const lines = withoutFm.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    if (line.match(/^#{1,3} /)) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
      current = { heading: line.replace(/^#{1,3} /, ''), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      // Content before first heading
      if (!current && line.trim()) {
        if (!sections[0] || sections[0].heading) {
          sections.push({ heading: '', body: line });
        }
      }
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
  return sections.filter(s => s.heading || s.body);
}

/** Very minimal markdown → HTML (just bold, italic, code, lists) */
function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^/, '<p>').replace(/$/, '</p>');
}
