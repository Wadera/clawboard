import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';
import {
  Brain, RefreshCw, FileText, Boxes, Target, HardDrive, ShieldCheck, ShieldAlert,
  CheckCircle, XCircle, Network, Share2, Plug, Database, GitBranch, Archive,
  ExternalLink,
} from 'lucide-react';
import './SecondBrain.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// Scope palette (validated for the dark surface): sources / shared / projects / users
export const SB_SCOPE_COLORS: Record<string, string> = {
  sources: '#6366f1',
  shared: '#0d9668',
  projects: '#a87407',
  users: '#8b5cf6',
};

const TooltipStyle: React.CSSProperties = {
  background: '#1a1a2e', border: '1px solid #333', borderRadius: '8px',
  padding: '10px 14px', color: '#e0e0e0', fontSize: '13px',
};

interface SbStats {
  generated_at: string;
  notes: { by_source: Record<string, number>; shared: number; projects: number; users_total: number; total: number };
  vectors: {
    ledger_notes: Record<string, number>;
    ledger_chunks: Record<string, number>;
    live: { collections?: { name: string; points_count: number; status?: string }[] | null; error?: string };
  };
  ingestion: Record<string, Record<string, number | null>>;
  sync: { couchdb_up: number | null; daemon_up: number | null; couchdb_vault_size_bytes: number | null };
  storage: { fs_total_bytes: number | null; fs_free_bytes: number | null; mounted: number | null };
  git_snapshot: { last_age_s: number | null; local_bare_ok: number | null; gitea_ok: number | null };
  backup: { last_run_age_s: number | null; success: number | null; size_bytes: number | null };
  restore_test: { last_run_age_s: number | null; success: number | null; doc_count: number | null };
  privacy_canary: { shared_leaks: number | null; rag_shared_leaks: number | null; last_run_age_s: number | null };
  vault_health: Record<string, number | null>;
  retrieval_eval: { evaluated_at: string; hybrid: Record<string, number>; lexical_baseline: Record<string, number> };
  search_mode_default: string;
}

export function fmtAge(s: number | null | undefined): string {
  if (s === null || s === undefined) return 'never';
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return '—';
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

export const SecondBrainSubnav: React.FC = () => (
  <nav className="sb-subnav" aria-label="Second Brain pages">
    <NavLink to="/second-brain" end className={({ isActive }) => (isActive ? 'active' : '')}>
      <Brain size={14} /> Overview
    </NavLink>
    <NavLink to="/second-brain/map" className={({ isActive }) => (isActive ? 'active' : '')}>
      <Share2 size={14} /> Notes Map
    </NavLink>
    <NavLink to="/second-brain/sync" className={({ isActive }) => (isActive ? 'active' : '')}>
      <Plug size={14} /> Sync &amp; Integration
    </NavLink>
  </nav>
);

function StatusChip({ ok, label, age, warn }: { ok: boolean; label: string; age?: string; warn?: boolean }) {
  const cls = ok ? 'ok' : warn ? 'warn' : 'bad';
  const Icon = ok ? CheckCircle : warn ? ShieldAlert : XCircle;
  return (
    <span className={`sb-chip ${cls}`}>
      <Icon size={14} aria-hidden />
      {label} {ok ? 'OK' : warn ? 'stale' : 'DOWN'}
      {age && <span className="sb-chip-age">{age}</span>}
    </span>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  return (
    <div className="sb-stat-card">
      <div className="sb-stat-icon" style={{ background: `${color}20`, color }}>{icon}</div>
      <div>
        <div className="sb-stat-number">{typeof value === 'number' ? value.toLocaleString() : value}</div>
        <div className="sb-stat-label">{label}</div>
      </div>
    </div>
  );
}

const INGESTION_LABELS: Record<string, string> = {
  clawboard_connector: 'ClawBoard connector',
  content_engine: 'Content Engine',
  documents: 'Documents',
  rag_indexer: 'RAG indexer',
};

export const SecondBrainPage: React.FC = () => {
  const [stats, setStats] = useState<SbStats | null>(null);
  const [brokerOk, setBrokerOk] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, healthRes] = await Promise.all([
        authenticatedFetch(`${API_BASE_URL}/second-brain/status`),
        authenticatedFetch(`${API_BASE_URL}/second-brain/broker-health`),
      ]);
      if (!statusRes.ok) throw new Error(`status ${statusRes.status}`);
      setStats(await statusRes.json());
      setBrokerOk(healthRes.ok ? Boolean((await healthRes.json()).ok) : false);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch Second Brain stats:', err);
      setError('Failed to load Second Brain stats. The fabric broker may be unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Mint a short-lived subdomain session cookie, then open the read-only Qdrant UI
  const openQdrantUi = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/second-brain/qdrant-session`, { method: 'POST' });
      if (!res.ok) throw new Error(`session ${res.status}`);
      const { url } = await res.json();
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      console.error('Failed to open Qdrant UI:', err);
      alert('Could not start a Qdrant UI session — is the backend reachable?');
    }
  }, []);

  if (loading && !stats) {
    return <div className="sb-page"><div className="sb-loading">Loading Second Brain…</div></div>;
  }
  if (error && !stats) {
    return (
      <div className="sb-page">
        <div className="sb-error" role="alert">
          <p>⚠️ {error}</p>
          <button onClick={fetchAll} className="sb-btn">Retry</button>
        </div>
      </div>
    );
  }
  if (!stats) return null;

  const sourceData = Object.entries(stats.notes.by_source)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => ({ name, count }));
  sourceData.push({ name: 'shared', count: stats.notes.shared });
  sourceData.push({ name: 'projects', count: stats.notes.projects });
  sourceData.push({ name: 'personal (all users)', count: stats.notes.users_total });

  const vh = stats.vault_health;
  const issueData = [
    { name: 'broken links', count: vh.broken_links ?? 0 },
    { name: 'missing frontmatter', count: vh.missing_frontmatter ?? 0 },
    { name: 'stale notes', count: vh.stale_notes ?? 0 },
    { name: 'duplicates', count: vh.duplicates ?? 0 },
  ].filter(d => d.count > 0);

  const chunksTotal = Object.values(stats.vectors.ledger_chunks).reduce((a, b) => a + b, 0);
  const liveByName: Record<string, number> = {};
  (stats.vectors.live.collections || []).forEach(c => { liveByName[c.name] = c.points_count; });
  const collectionRows = Object.keys(stats.vectors.ledger_notes).map(name => ({
    name,
    notes: stats.vectors.ledger_notes[name],
    chunks: stats.vectors.ledger_chunks[name] ?? 0,
    live: name === 'users_total' ? liveByName['users_total'] : liveByName[name],
  }));

  const canaryOk = (stats.privacy_canary.shared_leaks ?? 1) === 0 && (stats.privacy_canary.rag_shared_leaks ?? 1) === 0;
  const syncOk = stats.sync.couchdb_up === 1 && stats.sync.daemon_up === 1;
  const usedPct = stats.storage.fs_total_bytes && stats.storage.fs_free_bytes !== null
    ? Math.round((1 - stats.storage.fs_free_bytes! / stats.storage.fs_total_bytes) * 100) : null;

  return (
    <div className="sb-page">
      <div className="sb-header">
        <h2><Brain size={24} /> Second Brain</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <SecondBrainSubnav />
          <button className="sb-btn" onClick={openQdrantUi} title="Open the vector DB dashboard (read-only) in a new tab">
            <ExternalLink size={14} /> Qdrant UI
          </button>
          <button className="sb-btn" onClick={fetchAll} title="Refresh"><RefreshCw size={16} /></button>
        </div>
      </div>

      <div className="sb-chips">
        <StatusChip ok={brokerOk === true} label="Broker" />
        <StatusChip ok={syncOk} label="LiveSync" />
        <StatusChip ok={stats.backup.success === 1} label="Backup" age={fmtAge(stats.backup.last_run_age_s)} />
        <StatusChip ok={stats.restore_test.success === 1} label="Restore test" age={fmtAge(stats.restore_test.last_run_age_s)} />
        <span className={`sb-chip ${canaryOk ? 'ok' : 'bad'}`}>
          {canaryOk ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
          Privacy canary {canaryOk ? 'clean' : 'LEAK DETECTED'}
          <span className="sb-chip-age">{fmtAge(stats.privacy_canary.last_run_age_s)}</span>
        </span>
        <StatusChip ok={stats.git_snapshot.gitea_ok === 1 && stats.git_snapshot.local_bare_ok === 1}
          label="Git snapshot" age={fmtAge(stats.git_snapshot.last_age_s)} />
      </div>

      <div className="sb-cards-grid">
        <StatCard icon={<FileText size={20} />} label="Notes in the vault" value={stats.notes.total} color="#6366f1" />
        <StatCard icon={<Boxes size={20} />} label="Vector chunks indexed" value={chunksTotal} color="#8b5cf6" />
        <StatCard icon={<Target size={20} />} label={`Hybrid MRR (eval ${stats.retrieval_eval.evaluated_at})`}
          value={stats.retrieval_eval.hybrid.mrr} color="#0d9668" />
        <StatCard icon={<Target size={20} />} label="Recall@5 (hybrid)" value={stats.retrieval_eval.hybrid.recall_at_5} color="#0d9668" />
        <StatCard icon={<Database size={20} />} label="CouchDB vault size" value={fmtBytes(stats.sync.couchdb_vault_size_bytes)} color="#a87407" />
        <StatCard icon={<HardDrive size={20} />} label={`Vault storage used${usedPct !== null ? ` (${usedPct}%)` : ''}`}
          value={`${fmtBytes((stats.storage.fs_total_bytes ?? 0) - (stats.storage.fs_free_bytes ?? 0))} / ${fmtBytes(stats.storage.fs_total_bytes)}`}
          color="#6366f1" />
      </div>

      <div className="sb-charts-grid">
        <div className="sb-card">
          <h3><FileText size={16} style={{ verticalAlign: '-2px' }} /> Notes by source</h3>
          <ResponsiveContainer width="100%" height={Math.max(200, sourceData.length * 42)}>
            <BarChart data={sourceData} layout="vertical" margin={{ left: 80, right: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a40" horizontal={false} />
              <XAxis type="number" stroke="#666" fontSize={12} />
              <YAxis type="category" dataKey="name" stroke="#666" fontSize={12} width={120} />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: '#ffffff08' }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} name="Notes" barSize={18}>
                {sourceData.map((d, i) => (
                  <Cell key={i} fill={d.name === 'personal (all users)' ? SB_SCOPE_COLORS.users
                    : d.name === 'shared' ? SB_SCOPE_COLORS.shared
                    : d.name === 'projects' ? SB_SCOPE_COLORS.projects : SB_SCOPE_COLORS.sources} />
                ))}
                <LabelList dataKey="count" position="right" fill="#ccc" fontSize={12} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="sb-card">
          <h3><Boxes size={16} style={{ verticalAlign: '-2px' }} /> Vector index (per collection)</h3>
          <table className="sb-table">
            <thead>
              <tr><th>Collection</th><th>Notes</th><th>Chunks (ledger)</th><th>Points (live qdrant)</th></tr>
            </thead>
            <tbody>
              {collectionRows.map(r => (
                <tr key={r.name}>
                  <td>{r.name === 'users_total' ? 'personal (all users)' : r.name}</td>
                  <td>{r.notes.toLocaleString()}</td>
                  <td>{r.chunks.toLocaleString()}</td>
                  <td>{r.live !== undefined ? r.live.toLocaleString() : <span className="sb-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.vectors.live.error && (
            <p className="sb-note">Live qdrant counts unavailable: {stats.vectors.live.error}</p>
          )}
          <p className="sb-note">Ledger counts are authoritative; live points can drift slightly above (superseded chunks).</p>
        </div>

        <div className="sb-card">
          <h3><Network size={16} style={{ verticalAlign: '-2px' }} /> Ingestion pipelines</h3>
          <table className="sb-table">
            <thead>
              <tr><th>Pipeline</th><th>Last run</th><th>Items</th><th>Status</th></tr>
            </thead>
            <tbody>
              {Object.entries(stats.ingestion).map(([key, v]) => (
                <tr key={key}>
                  <td>{INGESTION_LABELS[key] || key}</td>
                  <td>{fmtAge((v.last_poll_age_s ?? v.last_run_age_s) as number | null)}</td>
                  <td>{((v.reports_total ?? v.snapshots_total ?? v.notes_changed) ?? '—').toLocaleString?.() ?? '—'}</td>
                  <td>
                    {v.success === 1
                      ? <span className="sb-chip ok" style={{ padding: '2px 8px' }}><CheckCircle size={12} aria-hidden /> ok</span>
                      : <span className="sb-chip bad" style={{ padding: '2px 8px' }}><XCircle size={12} aria-hidden /> failing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sb-card">
          <h3><GitBranch size={16} style={{ verticalAlign: '-2px' }} /> Vault health issues</h3>
          {issueData.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(160, issueData.length * 44)}>
              <BarChart data={issueData} layout="vertical" margin={{ left: 80, right: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a40" horizontal={false} />
                <XAxis type="number" stroke="#666" fontSize={12} />
                <YAxis type="category" dataKey="name" stroke="#666" fontSize={12} width={140} />
                <Tooltip contentStyle={TooltipStyle} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="count" fill="#a87407" radius={[0, 4, 4, 0]} name="Count" barSize={18}>
                  <LabelList dataKey="count" position="right" fill="#ccc" fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="sb-loading" style={{ padding: 30 }}>No structural issues 🎉</div>
          )}
          <p className="sb-note">
            {vh.notes_total?.toLocaleString()} notes scanned · {vh.orphans?.toLocaleString()} orphans ·{' '}
            {vh.edges?.toLocaleString()} wikilink edges (import-heavy vault — links accrue as notes get curated).
            Full report: <Archive size={12} style={{ verticalAlign: '-2px' }} /> weekly suggestions digest.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SecondBrainPage;
