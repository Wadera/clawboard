import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { marked } from 'marked';
import { authenticatedFetch } from '../utils/auth';
import './ReportsPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface Report {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  project_id: string | null;
  project_name?: string | null;
  task_ids: string[];
  author: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

function renderMarkdown(text: string): string {
  marked.setOptions({ breaks: true, gfm: true });
  return marked.parse(text) as string;
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);

    authenticatedFetch(`${API_BASE_URL}/reports/${id}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        // API might return { report } or the report directly
        setReport(data.report || data);
      })
      .catch(err => {
        console.error('Failed to fetch report:', err);
        setError(err.message || 'Failed to load report');
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="report-detail-page">
        <div className="report-detail-loading">
          <div className="reports-spinner" />
          <p>Loading report...</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="report-detail-page">
        <div className="report-detail-error">
          <h2>Report not found</h2>
          <p>{error || 'The report you are looking for does not exist.'}</p>
          <Link to="/reports" className="report-back-link">
            <ArrowLeft size={16} />
            Back to Reports
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="report-detail-page fade-in">
      {/* Navigation */}
      <nav className="report-detail-nav">
        <Link to="/reports" className="report-back-link">
          <ArrowLeft size={16} />
          Back to Reports
        </Link>
      </nav>

      {/* Header */}
      <header className="report-detail-header">
        <div className="report-detail-title-row">
          {report.pinned && <span className="report-detail-pin">📌</span>}
          <h1 className="report-detail-title">{report.title}</h1>
        </div>

        <div className="report-detail-meta">
          {report.author && (
            <span className="report-detail-author">
              By <strong>{report.author}</strong>
            </span>
          )}
          <span className="report-detail-date">
            {formatFullDate(report.created_at)}
          </span>
          {report.updated_at !== report.created_at && (
            <span className="report-detail-updated">
              Updated {formatFullDate(report.updated_at)}
            </span>
          )}
        </div>

        {/* Tags */}
        {report.tags.length > 0 && (
          <div className="report-detail-tags">
            {report.tags.map((tag) => (
              <span
                key={tag}
                className="report-detail-tag"
                onClick={() => navigate(`/reports?tag=${encodeURIComponent(tag)}`)}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Project badge */}
        {report.project_name && (
          <Link
            to={`/projects`}
            className="report-detail-project"
          >
            📁 {report.project_name}
          </Link>
        )}
      </header>

      {/* Content */}
      <article className="report-detail-content">
        <div
          className="report-markdown"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(report.content),
          }}
        />
      </article>

      {/* Linked Tasks */}
      {report.task_ids && report.task_ids.length > 0 && (
        <div className="report-detail-tasks">
          <h3>🔗 Linked Tasks</h3>
          <div className="report-task-chips">
            {report.task_ids.map((taskId) => (
              <Link
                key={taskId}
                to={`/tasks?focus=${taskId}`}
                className="report-task-chip"
              >
                {taskId.substring(0, 8)}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Bottom nav */}
      <nav className="report-detail-nav report-detail-nav-bottom">
        <Link to="/reports" className="report-back-link">
          <ArrowLeft size={16} />
          Back to Reports
        </Link>
      </nav>
    </div>
  );
}
