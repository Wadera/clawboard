import { readFile, access } from 'fs/promises';
import { watch } from 'fs';
import { WebSocketService } from './websocket';
import { taskAutoUpdater } from './TaskAutoUpdater';
import path from 'path';

interface SessionData {
  updatedAt: number;
  label?: string;
  sessionId?: string;
  [key: string]: any;
}

interface StatusUpdate {
  main: {
    state: 'idle' | 'thinking' | 'typing' | 'tool-use' | 'waiting' | 'error';
    detail: string;
    tools: string[];
  };
  agents: Array<{
    key: string;
    label: string;
    state: 'running' | 'idle' | 'completed';
    updatedAt: number;
  }>;
  agentCount: number;
  stats: {
    messageCount: number;
    toolsUsed: number;
  };
  timestamp: number;
}

interface TranscriptMessage {
  type: string;
  message: {
    role: string;
    content?: Array<{
      type: string;
      thinking?: string;
      name?: string;
      id?: string;
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  timestamp: string;
}

export class SessionMonitor {
  private sessionsPath: string;
  private transcriptsDir: string;
  private wsService: WebSocketService;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastUpdate: StatusUpdate | null = null;
  private sessionWatcher: any | null = null;
  private transcriptWatcher: any | null = null;

  constructor(
    sessionsPath: string,
    transcriptsDir: string,
    wsService: WebSocketService
  ) {
    this.sessionsPath = sessionsPath;
    this.transcriptsDir = transcriptsDir;
    this.wsService = wsService;
  }

  /**
   * Start monitoring sessions and transcripts
   */
  public start() {
    console.log('👁️  Starting session monitor...');
    console.log(`   Sessions file: ${this.sessionsPath}`);
    console.log(`   Transcripts dir: ${this.transcriptsDir}`);

    // Watch sessions.json
    this.sessionWatcher = watch(this.sessionsPath, { persistent: true }, () => {
      console.log('📝 Sessions file changed');
      this.updateAndBroadcast();
    });

    // Watch transcripts directory (for lock files and .jsonl changes)
    this.transcriptWatcher = watch(
      this.transcriptsDir,
      { persistent: true, recursive: false },
      (_eventType, filename) => {
        if (filename && (filename.endsWith('.lock') || filename.endsWith('.jsonl'))) {
          console.log(`📄 Transcript activity: ${filename}`);
          this.updateAndBroadcast();
        }
      }
    );

    // Poll every 1000ms for status updates
    this.pollInterval = setInterval(() => {
      this.updateAndBroadcast();
    }, 1000);

    // Initial update
    this.updateAndBroadcast();
  }

  /**
   * Stop monitoring
   */
  public stop() {
    console.log('👁️  Stopping session monitor...');
    
    if (this.sessionWatcher) {
      this.sessionWatcher.close();
      this.sessionWatcher = null;
    }

    if (this.transcriptWatcher) {
      this.transcriptWatcher.close();
      this.transcriptWatcher = null;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Update status and broadcast to all clients
   */
  private async updateAndBroadcast() {
    try {
      const status = await this.detectStatus();
      
      // Only broadcast if status actually changed
      const statusChanged = JSON.stringify(status) !== JSON.stringify(this.lastUpdate);
      
      if (statusChanged) {
        console.log(`🔄 Status changed: ${status.main.state} - ${status.main.detail}`);
        this.lastUpdate = status;
        
        // Update task auto-updater with current activity
        taskAutoUpdater.updateContext(status.main.detail || status.main.state);
        
        this.wsService.broadcast({
          type: 'status-update',
          data: status,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ Status detection failed:', error);
      
      this.wsService.broadcast({
        type: 'error',
        error: error instanceof Error ? error.message : 'Status detection failed',
        timestamp: Date.now()
      });
    }
  }

  /**
   * Detect current status from sessions + transcripts
   */
  private async detectStatus(): Promise<StatusUpdate> {
    try {
      // Read sessions.json
      const sessionsData = await readFile(this.sessionsPath, 'utf-8');
      const sessions: Record<string, SessionData> = JSON.parse(sessionsData);

      // Find main session
      const mainSessionEntry = Object.entries(sessions).find(([key]) =>
        key.includes('main:main') && !key.includes('subagent')
      );

      if (!mainSessionEntry) {
        return this.errorStatus('Main session not found');
      }

      const [, mainSession] = mainSessionEntry;
      const sessionId = mainSession.sessionId;

      if (!sessionId) {
        return this.errorStatus('Session ID not found');
      }

      // Detect main session state
      const mainState = await this.detectMainState(sessionId);

      // Calculate session stats
      const stats = await this.calculateSessionStats(sessionId);

      // Find active sub-agents
      const fiveMinAgo = Date.now() - (5 * 60 * 1000);
      const subAgentEntries = Object.entries(sessions)
        .filter(([key]) => key.includes('subagent'))
        .filter(([, data]) => data.updatedAt > fiveMinAgo);
      
      const subAgents: Array<{
        key: string;
        label: string;
        state: 'running' | 'idle' | 'completed';
        updatedAt: number;
      }> = [];
      
      for (const [key, data] of subAgentEntries) {
        subAgents.push({
          key,
          label: data.label || key.split(':').pop() || 'unknown',
          updatedAt: data.updatedAt,
          state: await this.detectAgentState(data),
        });
      }

      return {
        main: mainState,
        agents: subAgents,
        agentCount: subAgents.length,
        stats,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ detectStatus error:', error);
      return this.errorStatus(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Detect main session state by checking lock file + transcript
   */
  private async detectMainState(sessionId: string): Promise<{
    state: 'idle' | 'thinking' | 'typing' | 'tool-use' | 'waiting' | 'error';
    detail: string;
    tools: string[];
  }> {
    const transcriptPath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    const lockPath = `${transcriptPath}.lock`;

    try {
      // Check if lock file exists (active inference!)
      const hasLock = await this.fileExists(lockPath);

      if (hasLock) {
        // Lock exists = currently processing!
        console.log('🔒 Lock file detected - AI is actively working!');
        
        // Parse transcript to determine WHAT we're doing
        const state = await this.parseTranscript(transcriptPath);
        return state || {
          state: 'typing',
          detail: 'Processing...',
          tools: []
        };
      }

      // No lock = idle
      return {
        state: 'idle',
        detail: 'Idle',
        tools: []
      };
    } catch (error) {
      console.error('❌ detectMainState error:', error);
      return {
        state: 'error',
        detail: error instanceof Error ? error.message : 'Error',
        tools: []
      };
    }
  }

  /**
   * Parse transcript to detect current activity
   */
  private async parseTranscript(transcriptPath: string): Promise<{
    state: 'idle' | 'thinking' | 'typing' | 'tool-use' | 'waiting' | 'error';
    detail: string;
    tools: string[];
  } | null> {
    try {
      const content = await readFile(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      if (lines.length === 0) return null;

      // Parse last message
      const lastLine = lines[lines.length - 1];
      const lastMsg: TranscriptMessage = JSON.parse(lastLine);

      if (!lastMsg.message) return null;

      const role = lastMsg.message.role;
      const msgContent = lastMsg.message.content || [];

      // User just sent a message → we're thinking about it
      if (role === 'user') {
        return {
          state: 'thinking',
          detail: 'Thinking about request...',
          tools: []
        };
      }

      // Assistant message - check what we're doing
      if (role === 'assistant') {
        // Check for tool calls
        const toolCalls = msgContent.filter((c: any) => c.type === 'toolCall');
        if (toolCalls.length > 0) {
          const tools = toolCalls.map((t: any) => t.name || 'unknown');
          return {
            state: 'tool-use',
            detail: `Running: ${tools.slice(0, 2).join(', ')}${tools.length > 2 ? '...' : ''}`,
            tools
          };
        }

        // Check for thinking
        const thinking = msgContent.find((c: any) => c.type === 'thinking');
        if (thinking) {
          return {
            state: 'thinking',
            detail: 'Thinking...',
            tools: []
          };
        }

        // Has text content = typing response
        const hasText = msgContent.some((c: any) => c.type === 'text');
        if (hasText) {
          return {
            state: 'typing',
            detail: 'Composing response...',
            tools: []
          };
        }
      }

      // Tool result = waiting for next turn
      if (role === 'toolResult') {
        return {
          state: 'waiting',
          detail: 'Processing tool results...',
          tools: []
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to parse transcript:', error);
      return null;
    }
  }

  /**
   * Calculate session statistics from transcript
   */
  private async calculateSessionStats(sessionId: string): Promise<{
    messageCount: number;
    toolsUsed: number;
  }> {
    try {
      const transcriptPath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
      const content = await readFile(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      const uniqueTools = new Set<string>();
      let messageCount = 0;

      for (const line of lines) {
        try {
          const msg: TranscriptMessage = JSON.parse(line);
          
          // Count user and assistant messages
          if (msg.message?.role === 'user' || msg.message?.role === 'assistant') {
            messageCount++;
          }

          // Track unique tools
          if (msg.message?.role === 'assistant' && msg.message.content) {
            const toolCalls = msg.message.content.filter((c: any) => c.type === 'toolCall');
            toolCalls.forEach((t: any) => {
              if (t.name) uniqueTools.add(t.name);
            });
          }
        } catch (err) {
          // Skip malformed lines
          continue;
        }
      }

      return {
        messageCount,
        toolsUsed: uniqueTools.size
      };
    } catch (error) {
      // Return zeros if transcript doesn't exist or can't be read
      return {
        messageCount: 0,
        toolsUsed: 0
      };
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect sub-agent state using lock file + timestamp
   */
  private async detectAgentState(sessionData: SessionData): Promise<'running' | 'idle' | 'completed'> {
    const timeSinceUpdate = Date.now() - sessionData.updatedAt;
    
    // Primary: check lock file
    const sessionId = sessionData.sessionId;
    if (sessionId) {
      const lockPath = path.join(this.transcriptsDir, `${sessionId}.jsonl.lock`);
      if (await this.fileExists(lockPath)) {
        return 'running';
      }
    }

    if (timeSinceUpdate < 30000) {
      return 'running';
    } else if (timeSinceUpdate < 300000) {
      return 'idle';
    } else {
      return 'completed';
    }
  }

  /**
   * Helper to create error status
   */
  private errorStatus(message: string): StatusUpdate {
    return {
      main: {
        state: 'error',
        detail: message,
        tools: []
      },
      agents: [],
      agentCount: 0,
      stats: {
        messageCount: 0,
        toolsUsed: 0
      },
      timestamp: Date.now()
    };
  }
}
