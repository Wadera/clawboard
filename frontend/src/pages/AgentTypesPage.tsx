import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Search, RefreshCw, Star } from 'lucide-react';
import { AgentTypeSummary, getAgentTypeColor } from '../types/agentType';
import { authenticatedFetch } from '../utils/auth';
import './AgentTypesPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const AgentTypesPage: React.FC = () => {
  const navigate = useNavigate();
  const [agentTypes, setAgentTypes] = useState<AgentTypeSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [syncing, setSyncing] = useState(false);

  const fetchAgentTypes = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (categoryFilter) params.set('category', categoryFilter);
      const query = params.toString();
      const response = await authenticatedFetch(`${API_BASE_URL}/agent-types${query ? `?${query}` : ''}`);
      const data = await response.json();
      if (data.success) {
        setAgentTypes(data.agentTypes || []);
        setCategories(data.categories || []);
      } else {
        setError(data.error || 'Failed to fetch agent types');
      }
    } catch (err) {
      setError('Failed to connect to API');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter]);

  useEffect(() => {
    fetchAgentTypes();
  }, [fetchAgentTypes]);

  const handleSync = async () => {
    try {
      setSyncing(true);
      const response = await authenticatedFetch(`${API_BASE_URL}/agent-types/sync`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        await fetchAgentTypes();
      } else {
        setError(data.error || 'Sync failed');
      }
    } catch {
      setError('Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const filtered = agentTypes.filter(at => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return at.name.toLowerCase().includes(q) ||
      (at.description || '').toLowerCase().includes(q) ||
      (at.category || '').toLowerCase().includes(q);
  });

  const grouped = filtered.reduce<Record<string, AgentTypeSummary[]>>((acc, at) => {
    const cat = at.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(at);
    return acc;
  }, {});

  return (
    <div className="agent-types-page">
      <div className="agent-types-header">
        <div className="agent-types-title">
          <Bot size={24} />
          <h1>Agent Types</h1>
          <span className="agent-types-count">{agentTypes.length} personas</span>
        </div>
        <div className="agent-types-actions">
          <button
            className="btn-sync"
            onClick={handleSync}
            disabled={syncing}
            title="Re-sync from agency-agents repo"
          >
            <RefreshCw size={14} className={syncing ? 'spinning' : ''} />
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
        </div>
      </div>

      <div className="agent-types-filters">
        <div className="search-box">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search personas..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="category-filter"
        >
          <option value="">All categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {error && <div className="agent-types-error">{error}</div>}

      {loading ? (
        <div className="agent-types-loading">Loading agent types...</div>
      ) : filtered.length === 0 ? (
        <div className="agent-types-empty">
          <Bot size={40} />
          <p>No agent types found</p>
          <button onClick={handleSync}>Sync from repo</button>
        </div>
      ) : (
        <div className="agent-types-groups">
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([category, types]) => (
            <div key={category} className="agent-type-category">
              <h2 className="category-heading">
                {category}
                <span className="category-count">{types.length}</span>
              </h2>
              <div className="agent-type-grid">
                {types.map(at => (
                  <button
                    key={at.id}
                    className="agent-type-card"
                    onClick={() => navigate(`/agent-types/${at.id}`)}
                    style={{ '--agent-color': getAgentTypeColor(at.color) } as React.CSSProperties}
                  >
                    <div className="agent-card-accent" />
                    <div className="agent-card-body">
                      <div className="agent-card-header">
                        <span className="agent-card-name">{at.name}</span>
                        {at.is_custom && (
                          <span className="agent-card-custom" title="Custom persona">
                            <Star size={12} />
                          </span>
                        )}
                      </div>
                      {at.description && (
                        <p className="agent-card-desc">{at.description}</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
