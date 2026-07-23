import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import './ReportsCard.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface Report {
  id: string;
  title: string;
  summary: string | null;
  tags: string[];
  pinned: boolean;
  created_at: string;
}

const timeAgo = (dateStr: string): string => {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
};

export const ReportsCard: React.FC = () => {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/reports?limit=3&offset=0`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.reports) {
        setReports(data.reports);
      }
    } catch (err) {
      console.error('Failed to fetch reports:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="reports-card">
        <div className="reports-card-loading">
          <div className="reports-card-spinner" />
          <span>Loading reports...</span>
        </div>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="reports-card">
        <div className="reports-card-header">
          <h3>📋 Reports</h3>
        </div>
        <div className="reports-card-empty">
          <span>No reports yet</span>
        </div>
      </div>
    );
  }

  return (
    <div className="reports-card">
      <div className="reports-card-header">
        <h3>📋 Reports</h3>
        <div
          className="reports-card-view-all"
          onClick={() => navigate('/reports')}
        >
          <span>View All Reports</span>
          <ChevronRight size={16} className="reports-card-arrow" />
        </div>
      </div>

      <div className="reports-card-list">
        {reports.map((report) => (
          <div
            key={report.id}
            className="reports-card-row"
            onClick={() => navigate(`/reports/${report.id}`)}
          >
            <div className="reports-card-row-icon">
              {report.pinned ? '📌' : '📄'}
            </div>
            <div className="reports-card-row-content">
              <span className="reports-card-row-title">{report.title}</span>
              <div className="reports-card-row-meta">
                <span className="reports-card-row-date">{timeAgo(report.created_at)}</span>
                {report.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="reports-card-tag">{tag}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
