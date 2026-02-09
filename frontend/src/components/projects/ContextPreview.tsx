import React, { useState, useCallback } from 'react';
import { authenticatedFetch } from '../../utils/auth';
import { Eye, Clipboard, Check, RefreshCw, Bot, Users } from 'lucide-react';
import './ContextPreview.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ContextPreviewProps {
  projectId: string;
  taskId?: string;
}

interface ContextData {
  project?: any;
  resources?: any;
  notebooks?: any;
  fileStructure?: any;
  toolInstructions?: any;
  orchestratorRules?: string[];
  agentRules?: string[];
  task?: any;
  tokenEstimate?: number;
}

export const ContextPreview: React.FC<ContextPreviewProps> = ({ projectId, taskId }) => {
  const [activeRole, setActiveRole] = useState<'agent' | 'orchestrator'>('agent');
  const [contextData, setContextData] = useState<{ agent: ContextData | null; orchestrator: ContextData | null }>({
    agent: null,
    orchestrator: null,
  });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchContext = useCallback(async (role: 'agent' | 'orchestrator') => {
    setLoading(true);
    setError(null);
    try {
      const url = taskId 
        ? `${API_BASE_URL}/projects/${projectId}/context?role=${role}&taskId=${taskId}`
        : `${API_BASE_URL}/projects/${projectId}/context?role=${role}`;
      const res = await authenticatedFetch(url);
      const data = await res.json();
      if (data.success) {
        setContextData(prev => ({ ...prev, [role]: data.context }));
      } else {
        setError(data.error || 'Failed to load context');
      }
    } catch (err) {
      setError('Failed to fetch context');
      console.error('Failed to fetch context:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId]);

  const handleRoleChange = (role: 'agent' | 'orchestrator') => {
    setActiveRole(role);
    if (!contextData[role]) {
      fetchContext(role);
    }
  };

  const handleRefresh = () => {
    fetchContext(activeRole);
  };

  const copyToClipboard = async () => {
    const ctx = contextData[activeRole];
    if (!ctx) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(ctx, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getTokenBadgeClass = (tokens: number): string => {
    if (tokens < 2000) return 'token-badge-green';
    if (tokens < 10000) return 'token-badge-yellow';
    return 'token-badge-red';
  };

  const formatContextAsYaml = (ctx: ContextData): string => {
    // Simple YAML-like formatting for display
    const lines: string[] = [];
    
    if (ctx.project) {
      lines.push('project:');
      lines.push(`  name: ${ctx.project.name}`);
      if (ctx.project.description) lines.push(`  description: ${ctx.project.description}`);
      lines.push(`  status: ${ctx.project.status}`);
    }
    
    if (ctx.resources) {
      lines.push('');
      lines.push('resources:');
      if (ctx.resources.repository) lines.push(`  repository: ${ctx.resources.repository}`);
      if (ctx.resources.production) lines.push(`  production: ${ctx.resources.production}`);
      if (ctx.resources.development) lines.push(`  development: ${ctx.resources.development}`);
      if (ctx.resources.nfsPath) lines.push(`  nfsPath: ${ctx.resources.nfsPath}`);
    }
    
    if (ctx.notebooks) {
      lines.push('');
      lines.push('notebooks:');
      Object.entries(ctx.notebooks).forEach(([key, nb]: [string, any]) => {
        if (nb) {
          lines.push(`  ${key}:`);
          lines.push(`    id: "${nb.id}"`);
          if (nb.description) lines.push(`    description: "${nb.description}"`);
          if (nb.queryTips?.length) {
            lines.push('    queryTips:');
            nb.queryTips.forEach((tip: string) => lines.push(`      - "${tip}"`));
          }
        }
      });
    }
    
    if (ctx.toolInstructions) {
      lines.push('');
      lines.push('toolInstructions:');
      Object.entries(ctx.toolInstructions).forEach(([key, value]) => {
        if (value) {
          lines.push(`  ${key}: |`);
          String(value).split('\n').forEach(line => lines.push(`    ${line}`));
        }
      });
    }
    
    if (ctx.task) {
      lines.push('');
      lines.push('task:');
      lines.push(`  id: ${ctx.task.id}`);
      lines.push(`  title: "${ctx.task.title}"`);
      if (ctx.task.subtasks?.length) {
        lines.push('  subtasks:');
        ctx.task.subtasks.forEach((st: any, i: number) => {
          const status = st.status || (st.completed ? 'completed' : 'new');
          const icon = status === 'completed' ? '✅' : status === 'in_review' ? '🔄' : '⬜';
          lines.push(`    - [${i}] ${icon} ${st.text}`);
        });
      }
    }
    
    const rules = activeRole === 'orchestrator' ? ctx.orchestratorRules : ctx.agentRules;
    if (rules?.length) {
      lines.push('');
      lines.push(`${activeRole}Rules:`);
      rules.forEach(rule => lines.push(`  - ${rule}`));
    }
    
    return lines.join('\n');
  };

  const currentContext = contextData[activeRole];

  return (
    <div className="context-preview">
      {/* Header */}
      <div className="context-preview-header">
        <h3 className="context-preview-title">
          <Eye size={16} />
          Context Preview
        </h3>
        <div className="context-preview-actions">
          <div className="role-toggle">
            <button
              className={`role-btn ${activeRole === 'agent' ? 'active' : ''}`}
              onClick={() => handleRoleChange('agent')}
            >
              <Bot size={14} />
              Agent
            </button>
            <button
              className={`role-btn ${activeRole === 'orchestrator' ? 'active' : ''}`}
              onClick={() => handleRoleChange('orchestrator')}
            >
              <Users size={14} />
              Orchestrator
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="context-preview-content">
        {loading ? (
          <div className="context-loading">
            <RefreshCw size={20} className="spinning" />
            <span>Loading context...</span>
          </div>
        ) : error ? (
          <div className="context-error">
            <p>{error}</p>
            <button className="retry-btn" onClick={handleRefresh}>Try again</button>
          </div>
        ) : currentContext ? (
          <>
            <div className="context-meta">
              <span className={`token-badge ${getTokenBadgeClass(currentContext.tokenEstimate || 0)}`}>
                ~{currentContext.tokenEstimate || 0} tokens
              </span>
              <button
                className="context-action-btn"
                onClick={handleRefresh}
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="context-action-btn"
                onClick={copyToClipboard}
                title="Copy to clipboard"
              >
                {copied ? <Check size={14} /> : <Clipboard size={14} />}
              </button>
            </div>
            <pre className="context-code">
              {formatContextAsYaml(currentContext)}
            </pre>
          </>
        ) : (
          <div className="context-empty">
            <p>Click a role to load context preview</p>
            <button className="load-btn" onClick={() => fetchContext(activeRole)}>
              Load {activeRole} context
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
