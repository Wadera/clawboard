import React, { useState } from 'react';
import { Plug, Copy, Check, Smartphone, KeyRound, Bot, ShieldCheck } from 'lucide-react';
import { SecondBrainSubnav } from './SecondBrainPage';
import './SecondBrain.css';

// Static, non-secret configuration facts about the fabric. Secrets are NEVER
// rendered here — every credential points at its Vaultwarden item instead.
const LIVESYNC_URI = 'https://nimspace.skyday.eu/livesync';
const LIVESYNC_DB = 'kf_vault';
const DEVICE_USERS = ['kf-wadera-pc', 'kf-wadera-phone', 'kf-walter-pc', 'kf-walter-phone'];
const MCP_URL_PUBLIC = 'https://litellm.skyday.eu/second_brain/mcp';
const MCP_URL_LAN = 'http://192.168.40.150:4000/second_brain/mcp';
const MCP_URL_DIRECT = 'http://192.168.40.150:8940/mcp';
const MCP_TOOLS = ['kf_search', 'kf_read_note', 'kf_backlinks', 'kf_vault_health'];

const CLAUDE_SNIPPET = `claude mcp add --transport http second-brain \\
  ${MCP_URL_PUBLIC} \\
  --header "Authorization: Bearer <litellm-virtual-key>"`;

const JSON_SNIPPET = `{
  "mcpServers": {
    "second-brain": {
      "type": "http",
      "url": "${MCP_URL_PUBLIC}",
      "headers": { "Authorization": "Bearer <litellm-virtual-key>" }
    }
  }
}`;

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable (http) — value is selectable text anyway */ }
  };
  return (
    <div className="sb-field">
      <span className="sb-field-label">{label}</span>
      {mono ? <code>{value}</code> : <span>{value}</span>}
      <button className="sb-copy-btn" onClick={copy} title={`Copy ${label}`} aria-label={`Copy ${label}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export const SecondBrainSyncPage: React.FC = () => (
  <div className="sb-page">
    <div className="sb-header">
      <h2><Plug size={24} /> Sync &amp; Integration</h2>
      <SecondBrainSubnav />
    </div>

    <div className="sb-charts-grid">
      <div className="sb-card sb-section">
        <h3><Smartphone size={16} style={{ verticalAlign: '-2px' }} /> Obsidian LiveSync — device setup</h3>
        <p className="sb-note" style={{ marginTop: 0 }}>
          Install <strong>Obsidian</strong> + the <strong>Self-hosted LiveSync</strong> community plugin,
          then point it at the fabric&apos;s CouchDB. One CouchDB user per device (never share them):
        </p>
        <CopyField label="Server URI" value={LIVESYNC_URI} />
        <CopyField label="Database" value={LIVESYNC_DB} />
        <div className="sb-field">
          <span className="sb-field-label">Device users</span>
          <span>{DEVICE_USERS.map(u => <code key={u} style={{ marginRight: 6 }}>{u}</code>)}</span>
        </div>
        <div className="sb-field">
          <span className="sb-field-label">Passwords</span>
          <span><KeyRound size={13} style={{ verticalAlign: '-2px' }} /> Vaultwarden → collection <strong>Knowledge Fabric</strong> (entries “KF CouchDB &lt;device user&gt;”)</span>
        </div>
        <p className="sb-note">
          <strong>Reachability:</strong> the nimspace host is shielded by the NPM edge to homelab/VPN
          clients — sync works at home or over the VPN (WireGuard/Tailscale task pending), not from the
          open internet.<br />
          <strong>End-to-end encryption is currently OFF</strong> — we flip it on together right before
          the Standard Notes import (turnkey runbook: <code>docs/onboarding-wadera.md</code>).
          Keep Obsidian&apos;s Restricted Mode ON except for the LiveSync plugin.<br />
          A one-tap Setup-URI/QR helper is a follow-up — the plugin generates setup URIs client-side,
          so the first device is configured manually with the fields above.
        </p>
      </div>

      <div className="sb-card sb-section">
        <h3><Bot size={16} style={{ verticalAlign: '-2px' }} /> MCP — point any tool at the Second Brain</h3>
        <p className="sb-note" style={{ marginTop: 0 }}>
          The fabric is a first-class <strong>MCP server</strong> routed through LiteLLM. Any
          MCP-capable tool, harness, or product needs just the URL and a LiteLLM virtual key —
          the broker credential stays server-side, and the gateway path can never touch personal
          note scopes (read-only: {MCP_TOOLS.map(t => <code key={t} style={{ marginRight: 4 }}>{t}</code>)}).
        </p>
        <CopyField label="MCP endpoint" value={MCP_URL_PUBLIC} />
        <CopyField label="LAN endpoint" value={MCP_URL_LAN} />
        <div className="sb-field">
          <span className="sb-field-label">Virtual key</span>
          <span><KeyRound size={13} style={{ verticalAlign: '-2px' }} /> Vaultwarden → Sfora / AI → <strong>“LiteLLM virtual key - Second Brain MCP”</strong> (or mint a new key with MCP access group <code>knowledge-fabric</code> in the LiteLLM admin UI)</span>
        </div>
        <p className="sb-note"><strong>Claude Code</strong></p>
        <pre className="sb-code">{CLAUDE_SNIPPET}</pre>
        <p className="sb-note"><strong>Generic MCP config (Codex, OpenClaw, any MCP client)</strong></p>
        <pre className="sb-code">{JSON_SNIPPET}</pre>
        <p className="sb-note">
          <ShieldCheck size={13} style={{ verticalAlign: '-2px' }} /> Access is key-gated in LiteLLM
          (server <code>second_brain</code>, <code>allow_all_keys=false</code>) — keys without the
          <code>knowledge-fabric</code> group don&apos;t even see these tools. Harnesses that should keep
          their own fabric identity (per-actor audit) instead register the direct LAN endpoint{' '}
          <code>{MCP_URL_DIRECT}</code> with their personal <code>X-KF-Credential</code> header.
        </p>
      </div>
    </div>
  </div>
);

export default SecondBrainSyncPage;
