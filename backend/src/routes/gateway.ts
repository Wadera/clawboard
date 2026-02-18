import { Router, Request, Response } from 'express';
import { GatewayConnector } from '../services/GatewayConnector';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/connection';

const router = Router();
const TRANSCRIPTS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
const MEDIA_BASE_DIR = '/clawdbot/media';

let gatewayConnector: GatewayConnector | null = null;

export function setGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

// GET /gateway/queue — returns current queue state
router.get('/queue', (_req: Request, res: Response) => {
  if (!gatewayConnector) {
    res.status(503).json({
      success: false,
      error: 'Gateway connector not initialized',
    });
    return;
  }

  const snapshot = gatewayConnector.getQueueSnapshot();
  res.json({
    success: true,
    ...snapshot,
  });
});

// GET /gateway/session/:sessionId/tools — returns recent tool calls from transcript
router.get('/session/:sessionId/tools', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const all = req.query.all === 'true';
    
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session ID' });
      return;
    }

    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    
    let rawLines: string;
    try {
      if (all) {
        // Read full transcript for "show all" — use cat with timeout
        rawLines = execSync(`cat "${transcriptPath}"`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
      } else {
        // Read last N lines for compact view
        rawLines = execSync(`tail -200 "${transcriptPath}"`, { encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 });
      }
    } catch {
      res.json({ success: true, tools: [], total: 0 });
      return;
    }

    const lines = rawLines.trim().split('\n').filter(l => l.trim());
    
    interface ToolCallInfo {
      id: string;
      name: string;
      input: string;
      inputData: Record<string, any>;
      output?: string;
      timestamp: string;
      completedTimestamp?: string;
      status: 'running' | 'done' | 'error';
      durationMs?: number;
      hasImage?: boolean;
    }

    const toolCalls: Map<string, ToolCallInfo> = new Map();
    const toolResults: Map<string, { text: string; timestamp: string; hasImage: boolean }> = new Map();
    
    // First pass: collect tool results
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const role = msg.message?.role;
        const content = msg.message?.content;
        const timestamp = msg.timestamp || '';
        
        if (role === 'toolResult' && Array.isArray(content)) {
          const toolCallId = msg.message?.toolCallId || '';
          let text = '';
          let hasImage = false;
          for (const c of content) {
            if (c.type === 'text') text += c.text || '';
            if (c.type === 'image') hasImage = true;
          }
          if (toolCallId) {
            toolResults.set(toolCallId, { text: text.substring(0, 2000), timestamp, hasImage });
          }
        }
      } catch { /* skip */ }
    }
    
    // Second pass: collect tool calls and match with results
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const role = msg.message?.role;
        const content = msg.message?.content;
        const timestamp = msg.timestamp || '';
        
        if (role === 'assistant' && Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'toolCall' && c.id) {
              const result = toolResults.get(c.id);
              const args = c.arguments || {};
              
              let inputPreview = '';
              if (args.command) inputPreview = `$ ${args.command}`;
              else if (args.url || args.targetUrl) inputPreview = args.url || args.targetUrl;
              else if (args.file_path || args.path) inputPreview = args.file_path || args.path;
              else if (args.query) inputPreview = args.query;
              else if (args.action) inputPreview = `${args.action}${args.target ? ` → ${args.target}` : ''}`;
              else inputPreview = JSON.stringify(args).substring(0, 300);

              toolCalls.set(c.id, {
                id: c.id,
                name: c.name || 'unknown',
                input: inputPreview.substring(0, 500),
                inputData: args,
                output: result?.text,
                timestamp,
                completedTimestamp: result?.timestamp,
                status: result ? 'done' : 'running',
                durationMs: result?.timestamp && timestamp 
                  ? new Date(result.timestamp).getTime() - new Date(timestamp).getTime()
                  : undefined,
                hasImage: result?.hasImage,
              });
            }
          }
        }
      } catch { /* skip */ }
    }

    const allTools = Array.from(toolCalls.values())
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    const total = allTools.length;
    // Use slice(-limit) to get the NEWEST N tools, still in oldest-first order
    const tools = all ? allTools : allTools.slice(-limit);

    res.json({ success: true, tools, total });
  } catch (err: any) {
    console.error('Failed to get session tools:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /gateway/session/:sessionId/messages — returns recent user/assistant messages from transcript
router.get('/session/:sessionId/messages', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const all = req.query.all === 'true';
    const limit = all ? 9999 : Math.min(parseInt(req.query.limit as string) || 5, 200);
    
    // Allow UUIDs (36 chars with dashes) and also runIds or other hex identifiers
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
      console.log(`[messages] Rejected sessionId: "${sessionId}" (length=${sessionId.length})`);
      res.status(400).json({ success: false, error: 'Invalid session ID' });
      return;
    }

    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    console.log(`[messages] Looking for transcript: ${transcriptPath} (exists: ${require('fs').existsSync(transcriptPath)})`);
    
    let rawLines: string;
    try {
      const tailLines = all ? 5000 : 500;
      rawLines = execSync(all ? `cat "${transcriptPath}"` : `tail -${tailLines} "${transcriptPath}"`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
    } catch {
      console.log(`[messages] No transcript file found for sessionId: ${sessionId}`);
      res.json({ success: true, messages: [] });
      return;
    }

    const lines = rawLines.trim().split('\n').filter(l => l.trim());
    
    interface MessageInfo {
      role: string;
      text: string;
      fullText?: string;
      truncated: boolean;
      timestamp: string;
    }

    const messages: MessageInfo[] = [];
    
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'message') continue;
        const role = msg.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        
        const content = msg.message?.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text') {
              text += c.text || '';
            }
          }
        }
        
        if (!text.trim()) continue;
        
        const truncated = text.length > 500;
        messages.push({
          role,
          text: truncated ? text.substring(0, 500) : text,
          ...(truncated ? { fullText: text } : {}),
          truncated,
          timestamp: msg.timestamp || '',
        });
      } catch { /* skip */ }
    }

    // Return last N messages (most recent last)
    const result = messages.slice(-limit);

    res.json({ success: true, messages: result });
  } catch (err: any) {
    console.error('Failed to get session messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /gateway/sessions/archive — returns past sessions from PostgreSQL (indexed)
router.get('/sessions/archive', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string | undefined;

    // Build query
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(session_key ILIKE $${paramIndex} OR label ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM sessions ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Fetch page
    const result = await pool.query(
      `SELECT 
        session_key, label, model, kind, status,
        message_count, input_tokens, output_tokens, total_cost_usd,
        transcript_path,
        started_at, ended_at, last_activity_at
       FROM sessions
       ${whereClause}
       ORDER BY last_activity_at DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    // Map to frontend's expected shape
    const sessions = result.rows.map((row: any) => ({
      sessionId: row.session_key,
      fileName: row.transcript_path || `${row.session_key}.jsonl`,
      lastModified: (row.last_activity_at || row.ended_at || row.started_at || new Date()).toISOString ? 
        row.last_activity_at?.toISOString?.() || row.last_activity_at || '' : '',
      fileSize: 0,
      firstActivity: row.started_at?.toISOString?.() || row.started_at || null,
      lastActivity: row.last_activity_at?.toISOString?.() || row.last_activity_at || null,
      label: row.label || undefined,
      // Extra DB fields for richer UI
      model: row.model,
      kind: row.kind,
      status: row.status,
      messageCount: row.message_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalCost: row.total_cost_usd ? parseFloat(row.total_cost_usd) : null,
    }));

    res.json({ success: true, sessions, total });
  } catch (err: any) {
    console.error('Failed to get session archive:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /gateway/session/:sessionId/abort — abort a running session
router.post('/session/:sessionId/abort', async (req: Request, res: Response) => {
  try {
    if (!gatewayConnector) {
      res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
      return;
    }

    const { sessionId } = req.params;
    
    // Find session by sessionId to get the sessionKey
    const snapshot = gatewayConnector.getQueueSnapshot();
    const session = snapshot.sessions.find(s => s.sessionId === sessionId);
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    // Call abort on the gateway
    await gatewayConnector.abortSession(session.sessionKey);
    
    res.json({ success: true });
  } catch (err: any) {
    console.error('Failed to abort session:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to abort session' });
  }
});

// GET /gateway/history — returns recently completed sessions
router.get('/history', (_req: Request, res: Response) => {
  if (!gatewayConnector) {
    res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
    return;
  }

  const sessions = (gatewayConnector as any).getHistoricalSessions?.() || [];
  res.json({ success: true, sessions });
});

// Serve media files (screenshots, etc.)
router.get('/media/*', (req: Request, res: Response) => {
  const mediaPath = req.params[0];
  if (!mediaPath) {
    res.status(400).json({ error: 'No path specified' });
    return;
  }
  const fullPath = path.join(MEDIA_BASE_DIR, mediaPath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(MEDIA_BASE_DIR))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(resolved);
});

export default router;
