import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart
} from 'recharts';
import { BarChart3, RefreshCw, TrendingUp, Activity, CheckCircle, Zap, Clock, Hash } from 'lucide-react';
import './StatsPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface AuditStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByTool: Record<string, number>;
  successRate: number;
  totalSessions: number;
}

interface TimelineBucket {
  timestamp: string;
  count: number;
}

interface Task {
  id: string;
  status: string;
  completed?: string;
  created?: string;
}

const CHART_COLORS = [
  '#818cf8', '#f472b6', '#34d399', '#fbbf24', '#f87171',
  '#a78bfa', '#38bdf8', '#fb923c', '#4ade80', '#e879f9',
];

const CustomTooltipStyle: React.CSSProperties = {
  background: '#1a1a2e',
  border: '1px solid #333',
  borderRadius: '8px',
  padding: '10px 14px',
  color: '#e0e0e0',
  fontSize: '13px',
};

export const StatsPage: React.FC = () => {
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hoursBack, setHoursBack] = useState(48);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, timelineRes, tasksRes] = await Promise.all([
        authenticatedFetch(`${API_BASE_URL}/audit/stats?hoursBack=${hoursBack}`),
        authenticatedFetch(`${API_BASE_URL}/audit/timeline?hoursBack=${hoursBack}&bucketMinutes=${hoursBack <= 24 ? 60 : 180}`),
        authenticatedFetch(`${API_BASE_URL}/tasks`),
      ]);
      const [statsData, timelineData, tasksData] = await Promise.all([
        statsRes.json(), timelineRes.json(), tasksRes.json(),
      ]);
      setStats(statsData);
      setTimeline(Array.isArray(timelineData) ? timelineData : []);
      setTasks(tasksData.tasks || []);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
      setError('Failed to load stats. The API may be unavailable.');
    } finally {
      setLoading(false);
    }
  }, [hoursBack]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Derived data
  const toolCallCount = stats?.eventsByType?.toolCall || 0;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const totalTasks = tasks.length;

  const toolPieData = stats ? Object.entries(stats.eventsByTool)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, value]) => ({ name, value })) : [];

  const toolBarData = stats ? Object.entries(stats.eventsByTool)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 12)
    .map(([name, count]) => ({ name, count })) : [];

  const timelineFormatted = timeline.map(b => ({
    time: new Date(b.timestamp).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
    count: b.count,
  }));

  // Tasks completed per day
  const tasksByDay: Record<string, number> = {};
  tasks.filter(t => t.completed).forEach(t => {
    const day = new Date(t.completed!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    tasksByDay[day] = (tasksByDay[day] || 0) + 1;
  });
  const taskCompletionData = Object.entries(tasksByDay).map(([day, count]) => ({ day, completed: count }));

  const eventTypeData = stats ? Object.entries(stats.eventsByType)
    .map(([name, value]) => ({ name, value })) : [];

  if (loading && !stats) {
    return (
      <div className="stats-page">
        <div className="stats-loading">
          <div className="loading-spinner" aria-label="Loading stats" />
          Loading stats...
        </div>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="stats-page">
        <div className="stats-error" role="alert">
          <span className="error-icon">⚠️</span>
          <p>{error}</p>
          <button onClick={fetchAll} className="retry-button">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stats-page">
      <div className="stats-header">
        <h2><BarChart3 size={24} /> Stats & Analytics</h2>
        <div className="stats-header-actions">
          <select value={hoursBack} onChange={e => setHoursBack(Number(e.target.value))}>
            <option value={6}>Last 6 hours</option>
            <option value={12}>Last 12 hours</option>
            <option value={24}>Last 24 hours</option>
            <option value={48}>Last 48 hours</option>
            <option value={168}>Last 7 days</option>
          </select>
          <button className="stats-btn" onClick={fetchAll} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="stats-cards-grid">
        <StatCard icon={<Zap size={20} />} label="Tool Calls" value={toolCallCount} color="#FF9800" />
        <StatCard icon={<Activity size={20} />} label="Sessions" value={stats?.totalSessions || 0} color="#2196F3" />
        <StatCard icon={<CheckCircle size={20} />} label="Success Rate" value={`${stats?.successRate || 0}%`} color="#4CAF50" />
        <StatCard icon={<Hash size={20} />} label="Total Events" value={stats?.totalEvents || 0} color="#9C27B0" />
        <StatCard icon={<TrendingUp size={20} />} label="Tasks Done" value={`${completedTasks}/${totalTasks}`} color="#f472b6" />
        <StatCard icon={<Clock size={20} />} label="Time Range" value={`${hoursBack}h`} color="#818cf8" />
      </div>

      {/* Charts Grid */}
      <div className="stats-charts-grid">
        {/* Usage Over Time */}
        <div className="stats-chart-card stats-chart-wide">
          <h3>📈 Usage Over Time</h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={timelineFormatted}>
              <defs>
                <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#818cf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="time" stroke="#666" fontSize={11} angle={-30} textAnchor="end" height={60} />
              <YAxis stroke="#666" fontSize={12} />
              <Tooltip contentStyle={CustomTooltipStyle} />
              <Area type="monotone" dataKey="count" stroke="#818cf8" fill="url(#colorCount)" strokeWidth={2} name="Events" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Tool Usage Pie */}
        <div className="stats-chart-card">
          <h3>🔧 Tool Usage</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={toolPieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={90}
                paddingAngle={3}
                dataKey="value"
                label={({ name, percent }: any) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}
                labelLine={false}
                fontSize={11}
              >
                {toolPieData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={CustomTooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Command Frequency Bar */}
        <div className="stats-chart-card">
          <h3>📊 Command Frequency</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={toolBarData} layout="vertical" margin={{ left: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis type="number" stroke="#666" fontSize={12} />
              <YAxis type="category" dataKey="name" stroke="#666" fontSize={12} width={55} />
              <Tooltip contentStyle={CustomTooltipStyle} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} name="Calls">
                {toolBarData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Event Types */}
        <div className="stats-chart-card">
          <h3>🏷️ Event Types</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={eventTypeData}
                cx="50%"
                cy="50%"
                outerRadius={90}
                dataKey="value"
                label={({ name, value }) => `${name}: ${value}`}
                fontSize={11}
              >
                {eventTypeData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={CustomTooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Task Completion Over Time */}
        <div className="stats-chart-card">
          <h3>✅ Tasks Completed</h3>
          {taskCompletionData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={taskCompletionData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="day" stroke="#666" fontSize={12} />
                <YAxis stroke="#666" fontSize={12} allowDecimals={false} />
                <Tooltip contentStyle={CustomTooltipStyle} />
                <Bar dataKey="completed" fill="#4ade80" radius={[4, 4, 0, 0]} name="Completed" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="stats-chart-empty">No completed tasks with dates</div>
          )}
        </div>
      </div>
    </div>
  );
};

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  return (
    <div className="stats-stat-card">
      <div className="stats-stat-icon" style={{ background: `${color}20`, color }}>
        {icon}
      </div>
      <div className="stats-stat-content">
        <div className="stats-stat-number">{typeof value === 'number' ? value.toLocaleString() : value}</div>
        <div className="stats-stat-label">{label}</div>
      </div>
    </div>
  );
}
