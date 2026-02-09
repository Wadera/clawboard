import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Download, ChevronDown, ChevronRight, Activity, Zap, CheckCircle, Clock, Database, RefreshCw, BarChart3, Coins, TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import './AuditPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface AuditEvent {
  sessionId: string;
  eventType: string;
  toolName?: string;
  command?: string;
  resultSummary?: string;
  success?: boolean;
  durationMs?: number;
  timestamp: string;
  metadata?: Record<string, any>;
}

interface AuditStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByTool: Record<string, number>;
  successRate: number;
  totalSessions: number;
}

interface ModelUsageStats {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost?: number;
}

interface ModelStatsResponse {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalEstimatedCost: number;
  byModel: ModelUsageStats[];
  timeline: Array<{
    timestamp: string;
    models: Record<string, { calls: number; tokens: number }>;
  }>;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  toolCall: '#FF9800',
  toolResult: '#4CAF50',
  session: '#2196F3',
  model_change: '#9C27B0',
  message: '#607D8B',
};

const EVENT_TYPE_ICONS: Record<string, string> = {
  toolCall: '🛠️',
  toolResult: '📋',
  session: '🔄',
  model_change: '🔀',
  message: '💬',
};

export const AuditPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sessionFromUrl = searchParams.get('session') || '';
  
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [modelStats, setModelStats] = useState<ModelStatsResponse | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [modelStatsExpanded, setModelStatsExpanded] = useState(true);
  const [screenshots, setScreenshots] = useState<Record<string, string[]>>({});
  const [loadingScreenshots, setLoadingScreenshots] = useState<Record<string, boolean>>({});
  // @ts-ignore - TODO: Implement lightbox UI
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Filters
  const [eventType, setEventType] = useState('');
  const [toolName, setToolName] = useState('');
  const [search, setSearch] = useState(sessionFromUrl);
  const [hoursBack, setHoursBack] = useState(sessionFromUrl ? 168 : 48);
  const [searchInput, setSearchInput] = useState(sessionFromUrl);

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '50');
      params.set('hoursBack', String(hoursBack));
      if (eventType) params.set('eventType', eventType);
      if (toolName) params.set('toolName', toolName);
      if (search) params.set('search', search);

      const res = await authenticatedFetch(`${API_BASE_URL}/audit/events?${params}`);
      const data = await res.json();
      setEvents(data.events || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch audit events:', err);
      setError('Failed to load audit events.');
    }
  }, [page, hoursBack, eventType, toolName, search]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/audit/stats?hoursBack=${hoursBack}`);
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch audit stats:', err);
    }
  }, [hoursBack]);

  const fetchModelStats = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/audit/model-stats?hoursBack=${hoursBack}&bucketMinutes=60`);
      const data = await res.json();
      setModelStats(data);
    } catch (err) {
      console.error('Failed to fetch model stats:', err);
    }
  }, [hoursBack]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchEvents(), fetchStats(), fetchModelStats()]).finally(() => setLoading(false));
  }, [fetchEvents, fetchStats, fetchModelStats]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const handleExport = async () => {
    const params = new URLSearchParams();
    params.set('limit', '10000');
    params.set('hoursBack', String(hoursBack));
    if (eventType) params.set('eventType', eventType);
    if (toolName) params.set('toolName', toolName);
    if (search) params.set('search', search);

    const res = await authenticatedFetch(`${API_BASE_URL}/audit/events?${params}`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data.events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const topTools = stats ? Object.entries(stats.eventsByTool)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5) : [];

  const totalPages = Math.ceil(total / 50);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const fetchScreenshots = async (event: AuditEvent, idx: number) => {
    const entryId = `${event.sessionId}-${event.timestamp}-${idx}`;
    
    if (event.toolName !== 'browser' || screenshots[entryId] || loadingScreenshots[entryId]) {
      return;
    }
    
    setLoadingScreenshots(prev => ({ ...prev, [entryId]: true }));
    
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/audit/${entryId}/screenshots`);
      if (res.ok) {
        const data = await res.json();
        if (data.screenshots && data.screenshots.length > 0) {
          setScreenshots(prev => ({ ...prev, [entryId]: data.screenshots }));
        }
      }
    } catch (err) {
      console.error('Failed to fetch screenshots:', err);
    } finally {
      setLoadingScreenshots(prev => ({ ...prev, [entryId]: false }));
    }
  };

  const handleToggleExpand = (idx: number) => {
    const newIdx = expandedIdx === idx ? null : idx;
    setExpandedIdx(newIdx);
    
    if (newIdx !== null && events[idx].toolName === 'browser') {
      fetchScreenshots(events[idx], idx);
    }
  };

  return (
    <div className="audit-page">
      <div className="audit-header">
        <h2><Activity size={24} /> Audit Dashboard</h2>
        <div className="audit-header-actions">
          <select value={hoursBack} onChange={e => { setHoursBack(Number(e.target.value)); setPage(1); }}>
            <option value={6}>Last 6 hours</option>
            <option value={12}>Last 12 hours</option>
            <option value={24}>Last 24 hours</option>
            <option value={48}>Last 48 hours</option>
            <option value={168}>Last 7 days</option>
          </select>
          <button className="audit-btn" onClick={handleExport} title="Export as JSON" aria-label="Export audit events as JSON">
            <Download size={16} /> Export
          </button>
          <button className="audit-btn" onClick={() => { fetchEvents(); fetchStats(); fetchModelStats(); }} title="Refresh" aria-label="Refresh audit data">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="audit-stats-grid">
          <div className="audit-stat-card">
            <div className="stat-icon"><Database size={20} /></div>
            <div className="stat-content">
              <div className="stat-number">{stats.totalEvents.toLocaleString()}</div>
              <div className="stat-label">Total Events</div>
            </div>
          </div>
          <div className="audit-stat-card">
            <div className="stat-icon"><Activity size={20} /></div>
            <div className="stat-content">
              <div className="stat-number">{stats.totalSessions}</div>
              <div className="stat-label">Sessions</div>
            </div>
          </div>
          <div className="audit-stat-card">
            <div className="stat-icon"><CheckCircle size={20} /></div>
            <div className="stat-content">
              <div className="stat-number">{stats.successRate}%</div>
              <div className="stat-label">Success Rate</div>
            </div>
          </div>
          <div className="audit-stat-card">
            <div className="stat-icon"><Zap size={20} /></div>
            <div className="stat-content">
              <div className="stat-number">{topTools[0]?.[0] || '-'}</div>
              <div className="stat-label">Top Tool ({topTools[0]?.[1] || 0})</div>
            </div>
          </div>
        </div>
      )}

      {/* Model Usage Statistics */}
      {modelStats && modelStats.byModel.length > 0 && (
        <div className="model-stats-section">
          <div 
            className="model-stats-header"
            onClick={() => setModelStatsExpanded(!modelStatsExpanded)}
          >
            <h3>
              <BarChart3 size={20} /> Model Usage Statistics
              {modelStatsExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            </h3>
          </div>
          
          {modelStatsExpanded && (
            <div className="model-stats-content">
              {/* Summary Cards */}
              <div className="model-stats-summary">
                <div className="model-stat-card">
                  <div className="stat-icon"><TrendingUp size={18} /></div>
                  <div className="stat-content">
                    <div className="stat-number">{modelStats.totalCalls.toLocaleString()}</div>
                    <div className="stat-label">Total API Calls</div>
                  </div>
                </div>
                <div className="model-stat-card">
                  <div className="stat-icon"><Database size={18} /></div>
                  <div className="stat-content">
                    <div className="stat-number">{(modelStats.totalTokens / 1000).toFixed(1)}K</div>
                    <div className="stat-label">Total Tokens</div>
                    <div className="stat-detail">
                      {(modelStats.totalInputTokens / 1000).toFixed(1)}K in / {(modelStats.totalOutputTokens / 1000).toFixed(1)}K out
                    </div>
                  </div>
                </div>
                {modelStats.totalEstimatedCost > 0 && (
                  <div className="model-stat-card">
                    <div className="stat-icon"><Coins size={18} /></div>
                    <div className="stat-content">
                      <div className="stat-number">${modelStats.totalEstimatedCost.toFixed(4)}</div>
                      <div className="stat-label">Estimated Cost</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Bar Chart */}
              <div className="model-chart-container">
                <h4>Token Usage by Model</h4>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={modelStats.byModel.slice(0, 10)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis 
                      dataKey="model" 
                      angle={-45} 
                      textAnchor="end" 
                      height={100}
                      tick={{ fill: '#aaa', fontSize: 12 }}
                    />
                    <YAxis tick={{ fill: '#aaa' }} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '4px' }}
                      labelStyle={{ color: '#fff' }}
                    />
                    <Legend wrapperStyle={{ color: '#aaa' }} />
                    <Bar dataKey="inputTokens" stackId="a" fill="#4CAF50" name="Input Tokens" />
                    <Bar dataKey="outputTokens" stackId="a" fill="#FF9800" name="Output Tokens" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Detailed Table */}
              <div className="model-table-container">
                <h4>Detailed Breakdown</h4>
                <table className="model-stats-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>API Calls</th>
                      <th>Input Tokens</th>
                      <th>Output Tokens</th>
                      <th>Total Tokens</th>
                      {modelStats.byModel.some(m => m.estimatedCost) && <th>Est. Cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {modelStats.byModel.map((model) => (
                      <tr key={model.model}>
                        <td className="model-name">{model.model}</td>
                        <td>{model.calls.toLocaleString()}</td>
                        <td>{model.inputTokens.toLocaleString()}</td>
                        <td>{model.outputTokens.toLocaleString()}</td>
                        <td><strong>{model.totalTokens.toLocaleString()}</strong></td>
                        {modelStats.byModel.some(m => m.estimatedCost) && (
                          <td>{model.estimatedCost ? `$${model.estimatedCost.toFixed(4)}` : '-'}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top Tools Bar */}
      {topTools.length > 0 && (
        <div className="audit-tools-bar">
          <span className="tools-bar-label">Top tools:</span>
          {topTools.map(([name, count]) => (
            <button
              key={name}
              className={`tool-chip ${toolName === name ? 'active' : ''}`}
              onClick={() => { setToolName(toolName === name ? '' : name); setPage(1); }}
            >
              {name} <span className="chip-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="audit-filters">
        <select value={eventType} onChange={e => { setEventType(e.target.value); setPage(1); }}>
          <option value="">All Types</option>
          <option value="toolCall">Tool Calls</option>
          <option value="toolResult">Tool Results</option>
          <option value="session">Sessions</option>
          <option value="model_change">Model Changes</option>
        </select>
        <form onSubmit={handleSearch} className="audit-search-form">
          <input
            type="text"
            placeholder="Search commands, tools, results..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
          <button type="submit"><Search size={16} /></button>
        </form>
      </div>

      {/* Events Timeline */}
      <div className="audit-events">
        {loading ? (
          <div className="audit-loading">
            <div className="loading-spinner" aria-label="Loading events" />
            Loading events...
          </div>
        ) : error ? (
          <div className="audit-empty" role="alert">⚠️ {error} <button onClick={() => { fetchEvents(); fetchStats(); fetchModelStats(); }} className="retry-button">Retry</button></div>
        ) : events.length === 0 ? (
          <div className="audit-empty">No events found for the selected filters.</div>
        ) : (
          <>
            <div className="audit-event-list">
              {events.map((event, idx) => (
                <div
                  key={`${event.sessionId}-${event.timestamp}-${idx}`}
                  className={`audit-event-item ${expandedIdx === idx ? 'expanded' : ''}`}
                >
                  <div
                    className="audit-event-header"
                    onClick={() => handleToggleExpand(idx)}
                  >
                    <span className="event-expand-icon">
                      {expandedIdx === idx ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                    <span
                      className="event-type-badge"
                      style={{ backgroundColor: EVENT_TYPE_COLORS[event.eventType] || '#666' }}
                    >
                      {EVENT_TYPE_ICONS[event.eventType] || '•'} {event.eventType}
                    </span>
                    {event.toolName && (
                      <span className="event-tool-name">{event.toolName}</span>
                    )}
                    {event.command && (
                      <span className="event-command">{event.command.substring(0, 80)}{event.command.length > 80 ? '...' : ''}</span>
                    )}
                    <span className="event-spacer" />
                    {event.success !== undefined && (
                      <span className={`event-success ${event.success ? 'success' : 'failure'}`}>
                        {event.success ? '✓' : '✗'}
                      </span>
                    )}
                    {event.durationMs !== undefined && (
                      <span className="event-duration">
                        <Clock size={12} /> {formatDuration(event.durationMs)}
                      </span>
                    )}
                    <span className="event-time">{formatTime(event.timestamp)}</span>
                  </div>
                  {expandedIdx === idx && (
                    <div className="audit-event-details">
                      <div className="detail-row">
                        <span className="detail-label">Session:</span>
                        <span className="detail-value mono">{event.sessionId}</span>
                      </div>
                      {event.command && (
                        <div className="detail-row">
                          <span className="detail-label">Command:</span>
                          <span className="detail-value mono">{event.command}</span>
                        </div>
                      )}
                      {event.resultSummary && (
                        <div className="detail-row">
                          <span className="detail-label">Result:</span>
                          <pre className="detail-value mono result-pre">{event.resultSummary}</pre>
                        </div>
                      )}                      {event.toolName === 'browser' && (() => {
                        const entryId = `${event.sessionId}-${event.timestamp}-${idx}`;
                        const entryScreenshots = screenshots[entryId];
                        const isLoading = loadingScreenshots[entryId];
                        
                        if (isLoading) {
                          return (
                            <div className="detail-row">
                              <span className="detail-label">Screenshots:</span>
                              <span className="detail-value">Loading...</span>
                            </div>
                          );
                        }
                        
                        if (entryScreenshots && entryScreenshots.length > 0) {
                          return (
                            <div className="detail-row screenshots-row">
                              <span className="detail-label">Screenshots:</span>
                              <div className="screenshots-grid">
                                {entryScreenshots.map((base64: string, screenshotIdx: number) => (
                                  <img
                                    key={screenshotIdx}
                                    src={`data:image/png;base64,${base64}`}
                                    alt={`Screenshot ${screenshotIdx + 1}`}
                                    className="screenshot-thumbnail"
                                    onClick={() => setLightboxImage(`data:image/png;base64,${base64}`)}
                                    loading="lazy"
                                  />
                                ))}
                              </div>
                            </div>
                          );
                        }
                        
                        return null;
                      })()}
                      {event.metadata && Object.keys(event.metadata).length > 0 && (
                        <div className="detail-row">
                          <span className="detail-label">Metadata:</span>
                          <pre className="detail-value mono">{JSON.stringify(event.metadata, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="audit-pagination">
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
                <span>Page {page} of {totalPages} ({total} events)</span>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
