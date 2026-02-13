import { Router, Request, Response } from 'express';
import { readFile } from 'fs/promises';

const router = Router();
const SESSIONS_PATH = process.env.OPENCLAW_SESSIONS_PATH || '/clawdbot/sessions.json';
const ACTIVE_MINUTES = 5;

interface SessionData {
  id?: string;
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
    
    // Check main session activity
    const mainSession = Object.entries(allSessions).find(([id]) => 
      id.includes('main:main') && !id.includes('subagent')
    );
    
    const mainSessionActive = mainSession?.[1]?.updatedAt 
      ? mainSession[1].updatedAt > cutoffTime 
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
    
    const subAgentCount = activeSessions.length;
    
    // Determine status based on main session OR active sub-agents
    let status: 'idle' | 'thinking' | 'working' = 'idle';
    let details = 'No active tasks';

    if (mainSessionActive && subAgentCount === 0) {
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
