import { Router, Request, Response } from 'express';
import { readFile, access, stat } from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { agentHistoryService } from '../services/AgentHistoryService';

const router = Router();
const SESSIONS_PATH = process.env.OPENCLAW_SESSIONS_PATH || '/clawdbot/sessions.json';
const TRANSCRIPTS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || '/clawdbot/sessions';

interface AgentDetail {
  key: string;
  label: string;
  model: string;
  modelAlias: string;
  status: 'running' | 'idle' | 'completed';
  contextUsage: {
    used: number;
    max: number;
    percent: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  currentTask: string;
  updatedAt: number;
  ageFormatted: string;
}

// Model alias mapping (same as ModelStatusService)
const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-5': 'opus',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-3-5': 'haiku',
  'claude-3-opus': 'opus-3',
  'claude-3-sonnet': 'sonnet-3',
  'claude-3-haiku': 'haiku-3',
  'gpt-4o': 'gpt-4o',
  'gpt-4-turbo': 'gpt-4t',
  'gemini-2.0-flash': 'gemini-flash',
  'gemini-2.5-pro': 'gemini-pro',
};

function getAlias(model: string): string {
  // Handle null/undefined/empty
  if (!model || model === 'unknown') return 'unknown';
  
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  for (const [key, alias] of Object.entries(MODEL_ALIASES)) {
    if (model.includes(key)) return alias;
  }
  return model.replace('anthropic/', '').replace('openai/', '').replace('google/', '');
}

function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Check if a lock file exists for a session (indicates actively running inference)
 */
async function hasLockFile(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const lockPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl.lock`);
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if transcript was recently modified (within last N ms)
 */
async function transcriptRecentlyModified(sessionId: string, withinMs: number): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    const stats = await stat(transcriptPath);
    return (Date.now() - stats.mtimeMs) < withinMs;
  } catch {
    return false;
  }
}

/**
 * Parse the last usage entry and model from a transcript file
 */
async function parseTranscriptMetadata(sessionId: string): Promise<{
  model?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}> {
  if (!sessionId) return {};
  try {
    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    let lastLines: string;
    try {
      lastLines = execSync(`tail -20 "${transcriptPath}"`, { encoding: 'utf-8', timeout: 3000 });
    } catch {
      const content = await readFile(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');
      lastLines = lines.slice(-20).join('\n');
    }

    const lines = lastLines.trim().split('\n').filter(l => l.trim());
    let model: string | undefined;
    let totalTokens: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.usage?.totalTokens && totalTokens === undefined) {
          totalTokens = msg.usage.totalTokens;
          inputTokens = msg.usage.input || 0;
          outputTokens = msg.usage.output || 0;
        }
        if (msg.model && model === undefined) {
          model = msg.model;
        }
        if (model !== undefined && totalTokens !== undefined) break;
      } catch {
        continue;
      }
    }

    // If model not found in tail, check head for model_change entries (always near top of transcript)
    if (!model) {
      try {
        let headLines: string;
        try {
          headLines = execSync(`head -10 "${transcriptPath}"`, { encoding: 'utf-8', timeout: 3000 });
        } catch {
          const content = await readFile(transcriptPath, 'utf-8');
          headLines = content.trim().split('\n').slice(0, 10).join('\n');
        }
        for (const line of headLines.trim().split('\n')) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'model_change' && msg.modelId) {
              model = msg.modelId;
              break;
            }
            if (msg.customType === 'model-snapshot' && msg.data?.modelId) {
              model = msg.data.modelId;
              break;
            }
          } catch { continue; }
        }
      } catch { /* ignore */ }
    }

    return { model, totalTokens, inputTokens, outputTokens };
  } catch {
    return {};
  }
}

/**
 * Detect agent state using lock file, transcript activity, and updatedAt
 */
async function detectAgentState(updatedAt: number, sessionData?: any): Promise<'running' | 'idle' | 'completed'> {
  const sessionId = sessionData?.sessionId;

  // Check if session was aborted/errored
  if (sessionData?.abortedLastRun === true) {
    return 'completed';
  }

  // Primary: lock file exists = actively running inference
  if (await hasLockFile(sessionId)) {
    return 'running';
  }

  // Secondary: transcript recently modified (within 60s)
  if (await transcriptRecentlyModified(sessionId, 60000)) {
    const timeSinceUpdate = Date.now() - updatedAt;
    return timeSinceUpdate < 30000 ? 'running' : 'idle';
  }

  const timeSinceUpdate = Date.now() - updatedAt;
  if (timeSinceUpdate < 30000) return 'running';
  if (timeSinceUpdate < 300000) return 'idle';
  return 'completed';
}

/**
 * Extract current task from agent transcript
 */
async function extractCurrentTask(sessionId: string): Promise<string> {
  try {
    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    const content = await readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) return 'No activity';

    // Parse last few messages to find task description
    const recentLines = lines.slice(-10); // Last 10 messages

    for (let i = recentLines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(recentLines[i]);
        
        // Look for user messages or assistant tool use
        if (msg.message?.role === 'user' && msg.message.content) {
          const textContent = msg.message.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join(' ');
          
          if (textContent && textContent.length > 0) {
            // Return first 100 chars of the request
            return textContent.slice(0, 100) + (textContent.length > 100 ? '...' : '');
          }
        }

        // Look for tool use as a fallback
        if (msg.message?.role === 'assistant' && msg.message.content) {
          const toolCalls = msg.message.content.filter((c: any) => c.type === 'toolCall');
          if (toolCalls.length > 0) {
            const tools = toolCalls.map((t: any) => t.name || 'unknown');
            return `Using: ${tools.slice(0, 2).join(', ')}${tools.length > 2 ? '...' : ''}`;
          }
        }
      } catch {
        continue;
      }
    }

    return 'Processing...';
  } catch (error) {
    return 'Unknown task';
  }
}

/**
 * GET /api/agents/history - Get past agent run history
 */
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const records = await agentHistoryService.getAll();
    res.json(records);
  } catch (error) {
    console.error('Error fetching agent history:', error);
    res.status(500).json({ error: 'Failed to fetch agent history' });
  }
});

/**
 * GET /api/agents/:agentKey - Get detailed info for a specific agent
 */
router.get('/:agentKey', async (req: Request, res: Response) => {
  try {
    const { agentKey } = req.params;

    // Read sessions.json
    const sessionsData = await readFile(SESSIONS_PATH, 'utf-8');
    const sessions: Record<string, any> = JSON.parse(sessionsData);

    // Find the agent session
    const agentSession = sessions[agentKey];
    if (!agentSession) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const sessionId = agentSession.sessionId;
    
    // Get model and tokens, falling back to transcript parsing
    let model = agentSession.model || agentSession.modelOverride || '';
    let totalTokens = agentSession.totalTokens || 0;
    let inputTokens = agentSession.inputTokens || 0;
    let outputTokens = agentSession.outputTokens || 0;
    const contextTokens = agentSession.contextTokens || 200000;
    
    if (!model || totalTokens === 0) {
      const meta = await parseTranscriptMetadata(sessionId);
      if (!model && meta.model) model = meta.model;
      if (totalTokens === 0 && meta.totalTokens) totalTokens = meta.totalTokens;
      if (inputTokens === 0 && meta.inputTokens) inputTokens = meta.inputTokens;
      if (outputTokens === 0 && meta.outputTokens) outputTokens = meta.outputTokens;
    }
    if (!model) model = 'unknown';
    
    const updatedAt = agentSession.updatedAt || Date.now();
    const ageMs = Date.now() - updatedAt;
    const label = agentSession.label || agentKey.split(':').pop() || 'unknown';

    // Extract current task from transcript
    const currentTask = sessionId ? await extractCurrentTask(sessionId) : 'No active task';

    // Calculate context usage percentage
    const contextPercent = contextTokens > 0
      ? Math.min(Math.round((totalTokens / contextTokens) * 100), 100)
      : 0;

    const agentDetail: AgentDetail = {
      key: agentKey,
      label,
      model,
      modelAlias: getAlias(model),
      status: await detectAgentState(updatedAt, agentSession),
      contextUsage: {
        used: totalTokens,
        max: contextTokens,
        percent: contextPercent,
      },
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: totalTokens,
      },
      currentTask,
      updatedAt,
      ageFormatted: formatAge(ageMs),
    };

    res.json(agentDetail);
  } catch (error) {
    console.error('Error fetching agent details:', error);
    res.status(500).json({
      error: 'Failed to fetch agent details',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/agents - Get detailed info for all active agents
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const sessionsData = await readFile(SESSIONS_PATH, 'utf-8');
    const sessions: Record<string, any> = JSON.parse(sessionsData);

    // Filter for active sub-agents
    const fiveMinAgo = Date.now() - (5 * 60 * 1000);
    const agentKeys = Object.keys(sessions)
      .filter(key => key.includes('subagent'))
      .filter(key => {
        const session = sessions[key];
        return session.updatedAt && session.updatedAt > fiveMinAgo;
      });

    const agentDetails: AgentDetail[] = [];

    for (const agentKey of agentKeys) {
      const agentSession = sessions[agentKey];
      const sessionId = agentSession.sessionId;
      
      // Get model and tokens, falling back to transcript parsing
      let model = agentSession.model || agentSession.modelOverride || '';
      let totalTokens = agentSession.totalTokens || 0;
      let inputTokens = agentSession.inputTokens || 0;
      let outputTokens = agentSession.outputTokens || 0;
      const contextTokens = agentSession.contextTokens || 200000;
      
      if (!model || totalTokens === 0) {
        const meta = await parseTranscriptMetadata(sessionId);
        if (!model && meta.model) model = meta.model;
        if (totalTokens === 0 && meta.totalTokens) totalTokens = meta.totalTokens;
        if (inputTokens === 0 && meta.inputTokens) inputTokens = meta.inputTokens;
        if (outputTokens === 0 && meta.outputTokens) outputTokens = meta.outputTokens;
      }
      if (!model) model = 'unknown';
      
      const updatedAt = agentSession.updatedAt || Date.now();
      const ageMs = Date.now() - updatedAt;
      const label = agentSession.label || agentKey.split(':').pop() || 'unknown';

      const currentTask = sessionId ? await extractCurrentTask(sessionId) : 'No active task';

      const contextPercent = contextTokens > 0
        ? Math.min(Math.round((totalTokens / contextTokens) * 100), 100)
        : 0;

      agentDetails.push({
        key: agentKey,
        label,
        model,
        modelAlias: getAlias(model),
        status: await detectAgentState(updatedAt, agentSession),
        contextUsage: {
          used: totalTokens,
          max: contextTokens,
          percent: contextPercent,
        },
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: totalTokens,
        },
        currentTask,
        updatedAt,
        ageFormatted: formatAge(ageMs),
      });
    }

    res.json(agentDetails);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({
      error: 'Failed to fetch agents',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
