import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { RefreshCw, Info, Share2 } from 'lucide-react';
import { SecondBrainSubnav, SB_SCOPE_COLORS } from './SecondBrainPage';
import './SecondBrain.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface GraphNode {
  id: string; path: string; title?: string; in?: number; out?: number; degree?: number;
  summary?: string; members?: number;
}

// tooltip content is note/hub data from the vault — always escape before HTML render
const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function nodeTooltip(n: any): string {
  const title = esc(n.title || n.id);
  if (n.path?.startsWith('knowledge/shared/hubs/')) {
    return `<div style="max-width:340px;line-height:1.45">`
      + `<div style="font-weight:600">🧠 ${title}</div>`
      + (n.summary ? `<div style="margin-top:4px">${esc(n.summary)}</div>` : '')
      + `<div style="margin-top:4px;opacity:.65;font-size:11px">`
      + `${n.members ?? n.degree ?? '?'} notes · machine-derived hub</div></div>`;
  }
  return `<div style="max-width:320px"><b>${title}</b>`
    + `<div style="opacity:.65;font-size:11px">${esc(n.path)}</div></div>`;
}
interface GraphEdge { from: string; to: string }
interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { node_count: number; edge_count: number; orphan_count: number; scopes?: string[] };
}
interface SemanticEdge { from: string; to: string; score: number; collection: string }

function scopeOf(path: string): keyof typeof SB_SCOPE_COLORS {
  if (path.startsWith('knowledge/shared')) return 'shared';
  if (path.startsWith('knowledge/projects')) return 'projects';
  if (path.startsWith('knowledge/users')) return 'users';
  return 'sources';
}

const SCOPE_LABELS: Record<string, string> = {
  sources: 'sources (imported)',
  shared: 'shared',
  projects: 'projects',
  users: 'personal',
};

export const SecondBrainMapPage: React.FC = () => {
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [semEdges, setSemEdges] = useState<SemanticEdge[]>([]);
  const [showSem, setShowSem] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const [graphRes, semRes] = await Promise.all([
        authenticatedFetch(`${API_BASE_URL}/second-brain/linkgraph`),
        authenticatedFetch(`${API_BASE_URL}/second-brain/semantic-edges`),
      ]);
      if (!graphRes.ok) throw new Error(`linkgraph ${graphRes.status}`);
      setGraph(await graphRes.json());
      // similarity overlay is best-effort — the map must work without it
      setSemEdges(semRes.ok ? (await semRes.json()).edges || [] : []);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch link graph:', err);
      setError('Failed to load the notes map. The fabric broker may be unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGraph(); }, [fetchGraph]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, [graph]);

  const data = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    const nodes = graph.nodes
      .filter(n => scopeFilter === 'all' || scopeOf(n.path) === scopeFilter)
      .map(n => ({ ...n, scope: scopeOf(n.path) }));
    const ids = new Set(nodes.map(n => n.id));
    // node ids are note paths in the broker graph — semantic edges join on path
    const links: { source: string; target: string; kind: 'wiki' | 'semantic'; score?: number }[] =
      graph.edges
        .filter(e => ids.has(e.from) && ids.has(e.to))
        .map(e => ({ source: e.from, target: e.to, kind: 'wiki' as const }));
    if (showSem) {
      const seen = new Set(links.map(l => [l.source, l.target].sort().join('|')));
      for (const e of semEdges) {
        if (!ids.has(e.from) || !ids.has(e.to)) continue;
        const key = [e.from, e.to].sort().join('|');
        if (seen.has(key)) continue; // a real wikilink outranks its similarity twin
        seen.add(key);
        links.push({ source: e.from, target: e.to, kind: 'semantic', score: e.score });
      }
    }
    return { nodes, links };
  }, [graph, semEdges, showSem, scopeFilter]);

  if (loading && !graph) {
    return <div className="sb-page"><div className="sb-loading">Loading notes map…</div></div>;
  }
  if (error && !graph) {
    return (
      <div className="sb-page">
        <div className="sb-error" role="alert">
          <p>⚠️ {error}</p>
          <button onClick={fetchGraph} className="sb-btn">Retry</button>
        </div>
      </div>
    );
  }
  if (!graph) return null;

  const sparse = graph.stats.edge_count === 0;
  const semShown = data.links.filter(l => l.kind === 'semantic').length;
  const wikiShown = data.links.length - semShown;

  return (
    <div className="sb-page">
      <div className="sb-header">
        <h2><Share2 size={24} /> Notes Map</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <SecondBrainSubnav />
          <button className="sb-btn" onClick={fetchGraph} title="Refresh"><RefreshCw size={16} /></button>
        </div>
      </div>

      {sparse && (
        <div className="sb-map-banner">
          <Info size={18} aria-hidden />
          <span>
            No curated wikilinks yet (import-heavy vault) — the dashed edges are{' '}
            <strong>computed similarity</strong> from the vector index, showing how the AI models
            see the notes relate. Solid edges appear as curated, cross-linked notes accrue.
          </span>
        </div>
      )}

      <div className="sb-map-toolbar">
        <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)} aria-label="Filter by scope">
          <option value="all">All scopes</option>
          {Object.keys(SB_SCOPE_COLORS)
            .filter(s => s !== 'users' || graph.nodes.some(n => scopeOf(n.path) === 'users'))
            .map(s => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
        </select>
        <span className="sb-legend" role="list" aria-label="Scope colors">
          {Object.entries(SB_SCOPE_COLORS).map(([scope, color]) => (
            <span key={scope} role="listitem">
              <span className="sb-legend-swatch" style={{ background: color }} aria-hidden />
              {SCOPE_LABELS[scope]}
            </span>
          ))}
        </span>
        <label className="sb-muted" style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={showSem} onChange={e => setShowSem(e.target.checked)} />
          similarity edges <span style={{ letterSpacing: 2 }} aria-hidden>┄┄</span>
        </label>
        <span className="sb-muted" style={{ fontSize: 12.5 }}>
          {data.nodes.length.toLocaleString()} notes · {wikiShown.toLocaleString()} links
          {showSem && <> · {semShown.toLocaleString()} similar</>}
        </span>
      </div>

      <div className="sb-map-canvas" ref={containerRef}>
        <ForceGraph2D
          graphData={data}
          width={width}
          height={640}
          backgroundColor="#14142a"
          nodeId="id"
          nodeLabel={nodeTooltip}
          nodeVal={(n: any) => 2 + (n.degree || 0)}
          nodeColor={(n: any) => SB_SCOPE_COLORS[n.scope] || SB_SCOPE_COLORS.sources}
          linkColor={(l: any) => (l.kind === 'semantic' ? '#8b5cf680' : '#4a4a6a')}
          linkWidth={(l: any) => (l.kind === 'semantic' ? 1 : 1.6)}
          linkLineDash={(l: any) => (l.kind === 'semantic' ? [3, 3] : null)}
          linkLabel={(l: any) => (l.kind === 'semantic' ? `similarity ${l.score}` : 'wikilink')}
          cooldownTicks={120}
          enableNodeDrag={false}
        />
      </div>
      <p className="sb-note">
        Hover a node for the note title and vault path. Personal notes appear only for household
        viewers — the dashboard&apos;s fabric credential can never see them.
      </p>
    </div>
  );
};

export default SecondBrainMapPage;
