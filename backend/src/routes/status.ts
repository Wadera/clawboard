import { Router, Request, Response } from 'express';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findMainSessionEntry } from '../services/openclawState';

const router = Router();
const SESSIONS_PATH = process.env.OPENCLAW_SESSIONS_PATH || process.env.CLAWDBOT_SESSIONS_PATH || '/clawdbot/sessions.json';
const TRANSCRIPTS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
const ACTIVE_MINUTES = 15;
const HERMES_STATE_DB_PATH = process.env.HERMES_READ_STATE_DB_PATH || process.env.HERMES_STATE_DB_PATH || '/home/hermes/.hermes/state.db';
const execFileAsync = promisify(execFile);

interface SessionData {
  id?: string;
  sessionId?: string;
  label?: string;
  updatedAt?: number;
  lastMessage?: {
    timestamp: string;
  };
}

interface StatusResponse {
  status: 'idle' | 'thinking' | 'working';
  subAgents: number;
  details: string;
  timestamp: string;
  activeSessions?: SessionData[];
}

interface HermesActiveRow {
  id: string;
  source: string | null;
  title?: string | null;
  last_message_at?: number | null;
  started_at?: number | null;
}

async function getActiveHermesSessions(): Promise<HermesActiveRow[]> {
  if (!existsSync(HERMES_STATE_DB_PATH)) return [];
  const script = `
import json, sqlite3, sys
from pathlib import Path

db_path = Path(sys.argv[1])
if not db_path.exists():
    print('[]')
    raise SystemExit(0)
conn = sqlite3.connect(f'file:{db_path}?mode=ro&immutable=1', uri=True)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
rows = cur.execute("""
    SELECT s.id, s.source, s.title, s.started_at,
           (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
    FROM sessions s
    WHERE s.ended_at IS NULL
    ORDER BY CASE
      WHEN LOWER(COALESCE(s.source, '')) = 'discord' THEN 0
      WHEN LOWER(COALESCE(s.source, '')) = 'cli' THEN 1
      ELSE 2
    END,
    COALESCE(last_message_at, s.started_at) DESC
    LIMIT 20
""").fetchall()
print(json.dumps([dict(r) for r in rows]))
`;
  const { stdout } = await execFileAsync('python3', ['-c', script, HERMES_STATE_DB_PATH], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const rows = JSON.parse(stdout || '[]') as HermesActiveRow[];
  const cutoffSeconds = Math.floor((Date.now() - ACTIVE_MINUTES * 60 * 1000) / 1000);
  return rows.filter((row) => Math.max(row.last_message_at || 0, row.started_at || 0) >= cutoffSeconds);
}

/**
 * GET /api/status
 * Returns the current bot work state based on active sub-agents and recent activity
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    // Read the sessions file directly
    const sessionsData = await readFile(SESSIONS_PATH, 'utf-8');
    const allSessions: Record<string, SessionData> = JSON.parse(sessionsData);
    
    // Calculate cutoff time for active sessions
    const cutoffTime = Date.now() - (ACTIVE_MINUTES * 60 * 1000);
    
    // Check main session activity. OpenClaw 2026.6.11 renamed the live main
    // session key to agent:<id>:explicit:main (legacy agent:main:main is
    // frozen with a stale sessionId, whose lock file can never appear again).
    const mainEntry = findMainSessionEntry(allSessions as Record<string, any>);

    // Check if main session is actively processing by looking for its lock file
    // (updatedAt in sessions.json bumps too frequently — heartbeats, system events, etc.)
    const mainSessionId = mainEntry?.session?.sessionId as string | undefined;
    const mainSessionActive = mainSessionId
      ? existsSync(path.join(TRANSCRIPTS_DIR, `${mainSessionId}.jsonl.lock`))
      : false;
    
    // Filter for active sub-agent sessions
    const activeSessions: SessionData[] = Object.entries(allSessions)
      .filter(([id, session]) => {
        // Only include subagents
        if (!id.includes('subagent')) return false;
        
        // Check if session has recent activity using updatedAt timestamp
        if (session.updatedAt) {
          return session.updatedAt > cutoffTime;
        }
        
        // Fallback to lastMessage timestamp if available
        if (session.lastMessage?.timestamp) {
          const lastActivity = new Date(session.lastMessage.timestamp).getTime();
          return lastActivity > cutoffTime;
        }
        
        return false;
      })
      .map(([id, session]) => ({ ...session, id }));
    
    const hermesActiveSessions = await getActiveHermesSessions();
    const subAgentCount = activeSessions.length;
    
    // Determine status based on Hermes activity, OpenClaw main, or active sub-agents
    let status: 'idle' | 'thinking' | 'working' = 'idle';
    let details = 'No active tasks';

    if (hermesActiveSessions.length > 0) {
      status = 'working';
      const primary = hermesActiveSessions[0];
      const hermesLabel = primary.title?.trim() || (String(primary.source || '').toLowerCase() === 'cli' ? 'Main Hermes' : 'Hermes active');
      details = hermesActiveSessions.length > 1
        ? `${hermesLabel} +${hermesActiveSessions.length - 1} more`
        : hermesLabel;
    } else if (mainSessionActive && subAgentCount === 0) {
      status = 'working';
      details = 'Active conversation';
    } else if (subAgentCount > 0) {
      status = 'working';
      
      // Build details from session labels
      const labels = activeSessions
        .map(s => s.label || s.id?.split(':').pop() || 'unknown')
        .filter(label => label !== 'unknown')
        .slice(0, 3); // Show max 3 agent labels
      
      if (labels.length > 0) {
        details = labels.join(', ');
        if (subAgentCount > labels.length) {
          details += ` +${subAgentCount - labels.length} more`;
        }
      } else {
        details = `${subAgentCount} agent${subAgentCount > 1 ? 's' : ''} running`;
      }
    }

    const response: StatusResponse = {
      status,
      subAgents: subAgentCount,
      details,
      timestamp: new Date().toISOString(),
      activeSessions: activeSessions.map(s => ({
        id: s.id,
        label: s.label,
        lastMessage: s.lastMessage
      }))
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching status:', error);
    
    // Return a fallback status on error
    res.json({
      status: 'idle',
      subAgents: 0,
      details: 'Status check failed',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
