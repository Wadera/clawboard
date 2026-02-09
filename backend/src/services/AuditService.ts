import fs from 'fs';
import path from 'path';
import readline from 'readline';

export interface AuditEvent {
  sessionId: string;
  eventType: 'toolCall' | 'toolResult' | 'message' | 'session' | 'model_change';
  toolName?: string;
  command?: string;
  resultSummary?: string;
  success?: boolean;
  durationMs?: number;
  timestamp: string;
  metadata?: Record<string, any>;
}

interface ParsedLine {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      name?: string;
      arguments?: any;
      text?: string;
      toolCallId?: string;
    }>;
    timestamp?: number;
  };
  provider?: string;
  modelId?: string;
  [key: string]: any;
}

export interface AuditFilters {
  eventType?: string;
  toolName?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  hoursBack?: number;
}

export interface AuditStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByTool: Record<string, number>;
  successRate: number;
  totalSessions: number;
}

export interface TimelineBucket {
  timestamp: string;
  count: number;
  events: AuditEvent[];
}

export interface ModelUsageStats {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost?: number;
}

export interface ModelStatsResponse {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalEstimatedCost: number;
  byModel: ModelUsageStats[];
  timeline: Array<{
    timestamp: string;
    models: Record<string, { calls: number; tokens: number }>;
  }>;
}

const TRANSCRIPTS_DIR = process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/home/clawd/.clawdbot/agents/main/sessions';

function getRecentJsonlFiles(hoursBack: number = 48): string[] {
  try {
    const files = fs.readdirSync(TRANSCRIPTS_DIR)
      .filter(f => f.endsWith('.jsonl'));
    
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    
    return files
      .map(f => {
        const fullPath = path.join(TRANSCRIPTS_DIR, f);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, mtime: stat.mtimeMs };
      })
      .filter(f => f.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.path);
  } catch (err) {
    console.error('Error reading sessions dir:', err);
    return [];
  }
}

async function parseJsonlFile(filePath: string): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  const sessionId = path.basename(filePath, '.jsonl');
  
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  
  // Track tool calls to match with results
  const pendingToolCalls = new Map<string, { name: string; args: any; timestamp: string }>();
  
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed: ParsedLine = JSON.parse(line);
      
      if (parsed.type === 'session') {
        events.push({
          sessionId,
          eventType: 'session',
          timestamp: parsed.timestamp || new Date().toISOString(),
          metadata: { cwd: parsed.cwd, version: parsed.version },
        });
        continue;
      }
      
      if (parsed.type === 'model_change') {
        events.push({
          sessionId,
          eventType: 'model_change',
          timestamp: parsed.timestamp || new Date().toISOString(),
          metadata: { provider: parsed.provider, modelId: parsed.modelId },
        });
        continue;
      }
      
      if (parsed.type !== 'message' || !parsed.message) continue;
      
      const msg = parsed.message;
      const ts = parsed.timestamp || new Date(msg.timestamp || 0).toISOString();
      
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Extract model and usage from assistant message
        const model = (msg as any).model || (parsed as any).model || 'unknown';
        const usage = (msg as any).usage;
        
        for (const item of msg.content) {
          if (item.type === 'toolCall') {
            const toolId = (item as any).id;
            const args = typeof item.arguments === 'string'
              ? (() => { try { return JSON.parse(item.arguments); } catch { return item.arguments; } })()
              : item.arguments;
            
            pendingToolCalls.set(toolId, { name: item.name || 'unknown', args, timestamp: ts });
            
            // Extract command for exec-like tools
            let command: string | undefined;
            if (args && typeof args === 'object') {
              command = args.command || args.url || args.path || args.action;
            }
            
            events.push({
              sessionId,
              eventType: 'toolCall',
              toolName: item.name,
              command: command ? String(command).substring(0, 500) : undefined,
              timestamp: ts,
              metadata: { 
                toolCallId: toolId, 
                model,
                usage: usage ? {
                  input_tokens: usage.input,
                  output_tokens: usage.output,
                  prompt_tokens: usage.input,
                  completion_tokens: usage.output,
                  total_tokens: usage.totalTokens,
                } : undefined
              },
            });
          }
        }
      }
      
      if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
        const toolCallId = (msg as any).toolCallId;
        const toolName = (msg as any).toolName;
        const isError = (msg as any).isError === true;
        const pending = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
        
        let resultText = '';
        for (const item of msg.content) {
          if (item.type === 'text' && item.text) {
            resultText += item.text;
          }
        }
        
        let durationMs: number | undefined;
        if (pending) {
          durationMs = new Date(ts).getTime() - new Date(pending.timestamp).getTime();
          if (durationMs < 0) durationMs = undefined;
        }
        
        events.push({
          sessionId,
          eventType: 'toolResult',
          toolName: toolName || pending?.name,
          resultSummary: resultText.substring(0, 300),
          success: !isError,
          durationMs,
          timestamp: ts,
          metadata: { toolCallId },
        });
        
        if (toolCallId) pendingToolCalls.delete(toolCallId);
      }
    } catch {
      // Skip malformed lines
    }
  }
  
  return events;
}

export class AuditService {
  private cache: { events: AuditEvent[]; timestamp: number; hoursBack: number } | null = null;
  private readonly CACHE_TTL_MS = 30_000; // 30s cache

  async getScreenshots(sessionId: string, timestamp: string): Promise<string[]> {
    const jsonlFile = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    
    if (!fs.existsSync(jsonlFile)) {
      return [];
    }
    
    const screenshots: string[] = [];
    const stream = fs.createReadStream(jsonlFile);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    let foundToolCall = false;
    let toolCallId: string | undefined;
    
    for await (const line of rl) {
      if (!line.trim()) continue;
      
      try {
        const parsed: ParsedLine = JSON.parse(line);
        
        // Look for browser tool calls around the same timestamp
        if (parsed.type === 'message' && parsed.message?.role === 'assistant') {
          const msgTime = parsed.timestamp || new Date(parsed.message.timestamp || 0).toISOString();
          const timeDiff = Math.abs(new Date(msgTime).getTime() - new Date(timestamp).getTime());
          
          // Within 10 seconds of the event
          if (timeDiff < 10000) {
            const content = parsed.message.content || [];
            for (const item of content) {
              if (item.type === 'toolCall' && item.name === 'browser') {
                const args = typeof item.arguments === 'string' 
                  ? JSON.parse(item.arguments) 
                  : item.arguments;
                
                if (args && (args.action === 'screenshot' || args.action === 'snapshot')) {
                  foundToolCall = true;
                  toolCallId = (item as any).id;
                  break;
                }
              }
            }
          }
        }
        
        // Look for corresponding tool result with screenshot data
        if (foundToolCall && parsed.type === 'message' && parsed.message?.role === 'toolResult') {
          const resultToolCallId = (parsed.message as any).toolCallId;
          
          if (!toolCallId || resultToolCallId === toolCallId) {
            const content = parsed.message.content || [];
            
            for (const item of content) {
              // Screenshots can be in different formats
              if (item.type === 'image' && (item as any).source?.data) {
                screenshots.push((item as any).source.data);
              } else if (item.type === 'image' && (item as any).data) {
                screenshots.push((item as any).data);
              } else if ((item as any).mimeType?.startsWith('image/') && (item as any).data) {
                screenshots.push((item as any).data);
              }
              
              // Check for attachment format
              if ((item as any).path && (item as any).path.includes('screenshot')) {
                // If there's a file path, try to read it
                try {
                  const screenshotPath = (item as any).path;
                  if (fs.existsSync(screenshotPath)) {
                    const imageData = fs.readFileSync(screenshotPath, 'base64');
                    screenshots.push(imageData);
                  }
                } catch (err) {
                  console.error('Failed to read screenshot file:', err);
                }
              }
            }
            
            if (screenshots.length > 0) {
              break;
            }
          }
        }
      } catch (err) {
        // Skip malformed lines
      }
    }
    
    return screenshots;
  }

  async getEvents(filters: AuditFilters = {}): Promise<{ events: AuditEvent[]; total: number }> {
    const hoursBack = filters.hoursBack || 48;
    let allEvents = await this.getAllEvents(hoursBack);
    
    // Apply filters
    if (filters.eventType) {
      allEvents = allEvents.filter(e => e.eventType === filters.eventType);
    }
    if (filters.toolName) {
      allEvents = allEvents.filter(e => e.toolName === filters.toolName);
    }
    if (filters.startDate) {
      const start = new Date(filters.startDate).getTime();
      allEvents = allEvents.filter(e => new Date(e.timestamp).getTime() >= start);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate).getTime();
      allEvents = allEvents.filter(e => new Date(e.timestamp).getTime() <= end);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      allEvents = allEvents.filter(e =>
        (e.toolName && e.toolName.toLowerCase().includes(q)) ||
        (e.command && e.command.toLowerCase().includes(q)) ||
        (e.resultSummary && e.resultSummary.toLowerCase().includes(q)) ||
        e.sessionId.toLowerCase().includes(q)
      );
    }
    
    const total = allEvents.length;
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 200);
    const offset = (page - 1) * limit;
    
    return { events: allEvents.slice(offset, offset + limit), total };
  }

  async getStats(hoursBack: number = 48): Promise<AuditStats> {
    const allEvents = await this.getAllEvents(hoursBack);
    
    const eventsByType: Record<string, number> = {};
    const eventsByTool: Record<string, number> = {};
    let successCount = 0;
    let resultCount = 0;
    const sessions = new Set<string>();
    
    for (const e of allEvents) {
      eventsByType[e.eventType] = (eventsByType[e.eventType] || 0) + 1;
      if (e.toolName) {
        eventsByTool[e.toolName] = (eventsByTool[e.toolName] || 0) + 1;
      }
      if (e.eventType === 'toolResult') {
        resultCount++;
        if (e.success) successCount++;
      }
      sessions.add(e.sessionId);
    }
    
    return {
      totalEvents: allEvents.length,
      eventsByType,
      eventsByTool,
      successRate: resultCount > 0 ? Math.round((successCount / resultCount) * 100) : 100,
      totalSessions: sessions.size,
    };
  }

  async getTimeline(hoursBack: number = 48, bucketMinutes: number = 60): Promise<TimelineBucket[]> {
    const allEvents = await this.getAllEvents(hoursBack);
    const buckets = new Map<string, AuditEvent[]>();
    
    for (const e of allEvents) {
      const ts = new Date(e.timestamp);
      ts.setMinutes(Math.floor(ts.getMinutes() / bucketMinutes) * bucketMinutes, 0, 0);
      const key = ts.toISOString();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(e);
    }
    
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timestamp, events]) => ({ timestamp, count: events.length, events: events.slice(0, 20) }));
  }

  async getModelStats(hoursBack: number = 48, bucketMinutes: number = 60): Promise<ModelStatsResponse> {
    const allEvents = await this.getAllEvents(hoursBack);
    const modelMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
    const timeline = new Map<string, Map<string, { calls: number; tokens: number }>>();
    
    // Cost per 1M tokens (approximate, based on common pricing)
    const modelCosts: Record<string, { input: number; output: number }> = {
      'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
      'claude-opus-4-5': { input: 15.0, output: 75.0 },
      'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
      'claude-3-sonnet': { input: 3.0, output: 15.0 },
      'claude-3-opus': { input: 15.0, output: 75.0 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
      'gpt-4': { input: 30.0, output: 60.0 },
      'gpt-4-turbo': { input: 10.0, output: 30.0 },
      'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
    };
    
    for (const e of allEvents) {
      const model = e.metadata?.model || 'unknown';
      const inputTokens = e.metadata?.usage?.input_tokens || e.metadata?.usage?.prompt_tokens || 0;
      const outputTokens = e.metadata?.usage?.output_tokens || e.metadata?.usage?.completion_tokens || 0;
      
      // Aggregate by model
      if (!modelMap.has(model)) {
        modelMap.set(model, { calls: 0, inputTokens: 0, outputTokens: 0 });
      }
      const stats = modelMap.get(model)!;
      stats.calls++;
      stats.inputTokens += inputTokens;
      stats.outputTokens += outputTokens;
      
      // Timeline buckets
      const ts = new Date(e.timestamp);
      ts.setMinutes(Math.floor(ts.getMinutes() / bucketMinutes) * bucketMinutes, 0, 0);
      const key = ts.toISOString();
      if (!timeline.has(key)) timeline.set(key, new Map());
      const bucket = timeline.get(key)!;
      if (!bucket.has(model)) bucket.set(model, { calls: 0, tokens: 0 });
      const bucketStats = bucket.get(model)!;
      bucketStats.calls++;
      bucketStats.tokens += inputTokens + outputTokens;
    }
    
    // Build response
    const byModel: ModelUsageStats[] = [];
    let totalCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEstimatedCost = 0;
    
    for (const [model, stats] of modelMap.entries()) {
      const totalTokens = stats.inputTokens + stats.outputTokens;
      
      // Calculate cost
      let estimatedCost = 0;
      for (const [modelPrefix, pricing] of Object.entries(modelCosts)) {
        if (model.toLowerCase().includes(modelPrefix)) {
          estimatedCost = (stats.inputTokens / 1_000_000) * pricing.input + 
                         (stats.outputTokens / 1_000_000) * pricing.output;
          break;
        }
      }
      
      byModel.push({
        model,
        calls: stats.calls,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        totalTokens,
        estimatedCost: estimatedCost > 0 ? estimatedCost : undefined,
      });
      
      totalCalls += stats.calls;
      totalInputTokens += stats.inputTokens;
      totalOutputTokens += stats.outputTokens;
      totalEstimatedCost += estimatedCost;
    }
    
    // Sort by total tokens descending
    byModel.sort((a, b) => b.totalTokens - a.totalTokens);
    
    // Build timeline
    const timelineArray = Array.from(timeline.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timestamp, models]) => ({
        timestamp,
        models: Object.fromEntries(models.entries()),
      }));
    
    return {
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalEstimatedCost,
      byModel,
      timeline: timelineArray,
    };
  }

  private async getAllEvents(hoursBack: number): Promise<AuditEvent[]> {
    if (this.cache && Date.now() - this.cache.timestamp < this.CACHE_TTL_MS && this.cache.hoursBack === hoursBack) {
      return this.cache.events;
    }
    
    const files = getRecentJsonlFiles(hoursBack);
    const allEvents: AuditEvent[] = [];
    
    for (const file of files) {
      const events = await parseJsonlFile(file);
      allEvents.push(...events);
    }
    
    allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    this.cache = { events: allEvents, timestamp: Date.now(), hoursBack };
    return allEvents;
  }
}
