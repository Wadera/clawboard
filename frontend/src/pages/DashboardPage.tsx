import React, { useState, useEffect } from 'react';
import { HeroCard } from '../components/dashboard/HeroCard';
import { StatsCard } from '../components/dashboard/StatsCard';
import { ActiveWorkPreview } from '../components/dashboard/ActiveWorkPreview';
import { ModelStatusCard } from '../components/ModelStatusCard';
import { MessageQueueWidget } from '../components/widgets/MessageQueueWidget';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';
import { ProjectOverview } from '../components/dashboard/ProjectOverview';
import { SystemStatus } from '../components/dashboard/SystemStatus';
import { Task } from '../types/task';
import { authenticatedFetch } from '../utils/auth';
import './DashboardPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface DashboardSummary {
  ideas: number;
  inProgress: number;
  stuck: number;
  completed: number;
  archived: number;
  recentCompleted: number;
}

export const DashboardPage: React.FC = () => {
  const [summary, setSummary] = useState<DashboardSummary>({
    ideas: 0,
    inProgress: 0,
    stuck: 0,
    completed: 0,
    archived: 0,
    recentCompleted: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSummary();
    const interval = setInterval(fetchSummary, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchSummary = async () => {
    // Try the new summary endpoint first
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/dashboard/summary`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.summary) {
          setSummary({
            ideas: data.summary.ideas || 0,
            inProgress: data.summary.inProgress || 0,
            stuck: data.summary.stuck || 0,
            completed: data.summary.completed || 0,
            archived: data.summary.archived || 0,
            recentCompleted: data.summary.recentCompleted || 0,
          });
          setError(null);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Fall through to tasks endpoint
    }

    // Fallback: compute from /api/tasks
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.success) {
        const tasks: Task[] = data.tasks;
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const ideas = tasks.filter(t => t.status === 'ideas').length;
        const inProgress = tasks.filter(t => t.status === 'in-progress').length;
        const stuck = tasks.filter(t => t.status === 'stuck').length;
        const completed = tasks.filter(t => t.status === 'completed').length;
        const archived = tasks.filter(t => t.status === 'archived').length;
        const recentCompleted = tasks.filter(
          t => (t.status === 'completed' || t.status === 'archived') &&
               t.completedAt && new Date(t.completedAt) >= weekAgo
        ).length;

        setSummary({ ideas, inProgress, stuck, completed, archived, recentCompleted });
        setError(null);
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
      setError('Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-loading">
          <div className="loading-spinner" aria-label="Loading dashboard" />
          <p>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-error" role="alert">
          <span className="error-icon">⚠️</span>
          <p>{error}</p>
          <button onClick={fetchSummary} className="retry-button">Retry</button>
        </div>
      </div>
    );
  }

  const completedTotal = summary.completed + summary.archived;

  return (
    <div className="dashboard-page">
      {/* Hero Section */}
      <HeroCard />

      {/* Stats Grid - 4 cards */}
      <div className="dashboard-stats-grid">
        <StatsCard
          icon="💡"
          label="Ideas"
          value={summary.ideas}
          description="things to explore"
          color="purple"
        />

        <StatsCard
          icon="🔄"
          label="In Progress"
          value={summary.inProgress}
          description="actively working"
          color="orange"
          pulse={summary.inProgress > 0}
        />

        <StatsCard
          icon="⚠️"
          label="Stuck"
          value={summary.stuck}
          description="needs attention"
          color={summary.stuck > 0 ? 'red' : 'gray'}
          pulse={summary.stuck > 0}
        />

        <StatsCard
          icon="✅"
          label="Completed"
          value={completedTotal}
          description={summary.recentCompleted > 0 ? `${summary.recentCompleted} recent` : 'all time'}
          color="green"
        />
      </div>

      {/* Message Queue - Prominent position for time-sensitive messages */}
      <MessageQueueWidget />

      {/* Currently Working On - All in-progress tasks */}
      <ActiveWorkPreview />

      {/* Activity Feed - full width */}
      <ActivityFeed />

      {/* Projects + Model Status side by side */}
      <div className="dashboard-widget-grid">
        <ProjectOverview />
        <ModelStatusCard />
      </div>

      {/* System Status (live) */}
      <SystemStatus />
    </div>
  );
};
