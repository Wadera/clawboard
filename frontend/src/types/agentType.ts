export interface AgentType {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  content: string | null;
  source_file: string | null;
  is_custom: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentTypeSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  is_custom: boolean;
}

export interface AgentTypeDetail extends AgentType {
  linkedSessions: LinkedSession[];
  linkedTasks: LinkedTask[];
}

export interface LinkedSession {
  session_key: string;
  kind: string;
  label: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_cost_usd: number | null;
  message_count: number | null;
}

export interface LinkedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  project: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Map color names to Tailwind/CSS color values */
export const AGENT_TYPE_COLORS: Record<string, string> = {
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7',
  orange: '#f97316',
  red: '#ef4444',
  yellow: '#eab308',
  pink: '#ec4899',
  cyan: '#06b6d4',
  gray: '#6b7280',
  indigo: '#6366f1',
};

export function getAgentTypeColor(color: string | null): string {
  if (!color) return AGENT_TYPE_COLORS.gray;
  return AGENT_TYPE_COLORS[color] || color;
}
