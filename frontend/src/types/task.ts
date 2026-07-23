// Phase 4: Enhanced Task System with Work Orchestration
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'review' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session' | 'report';

// Phase 4: 6-state subtask lifecycle
// empty       - Not started
// in_progress - Agent working on it
// review      - Awaiting orchestrator review
// blocked     - Cannot proceed, needs intervention
// skipped     - Intentionally skipped (counts as "done")
// completed   - Approved by orchestrator
export type SubtaskStatus = 'empty' | 'in_progress' | 'review' | 'blocked' | 'skipped' | 'completed';

export interface Subtask {
  id: string;
  text: string;
  // Phase 4: 6-state status
  status: SubtaskStatus;
  // Legacy support - will be migrated to status
  completed?: boolean;
  completedAt?: string;
  reviewNote?: string;  // Agent's note when marking for review
  blockedReason?: string;  // Why is this subtask blocked?
  sessionRef?: string;  // Which session completed it
}

// Task-specific resources (Phase 3)
export interface TaskResources {
  links?: Array<{
    type: 'git' | 'url' | 'file' | 'reference';
    title: string;
    url: string;
  }>;
  files?: string[];
  relatedTasks?: string[];
}

export type TaskCapability = 'browser' | 'host-browser' | 'elevated' | 'network' | 'discord-thread' | 'long-running';

export const TASK_CAPABILITY_TAGS: TaskCapability[] = ['browser', 'host-browser', 'elevated', 'network', 'discord-thread', 'long-running'];

export type TaskExecutionMode = 'main' | 'subagent' | 'interactive';
export type TaskExecutionHarness = 'openclaw' | 'hermes';
export type TaskAccessProfile = 'safe' | 'dev' | 'network' | 'homelab' | 'browser' | 'elevated';
export type TaskPlanningMode = 'fixed' | 'refine' | 'adaptive';

export interface TaskExecutionProfile {
  mode: TaskExecutionMode;
  harness?: TaskExecutionHarness;
  accessProfile: TaskAccessProfile;
  requiredCapabilities?: TaskCapability[];
  allowOverrideAtSpawn?: boolean;
  notes?: string;
  planningMode?: TaskPlanningMode;
}

export interface TaskLink {
  type: TaskLinkType;
  url: string;
  title: string;
  icon?: string;
}

export type ReviewDecision = 'running' | 'pass' | 'reject' | 'escalate';

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string[];
}

export interface ReviewWorkspaceEvidence {
  workingDirectory?: string;
  gitBranch?: string;
  changedFiles?: string[];
  diffStat?: string;
  commandEvidence?: string[];
}

export interface ReviewHistoryEntry {
  id: string;
  decision: ReviewDecision;
  summary: string;
  triggeredBy: 'user' | 'agent' | 'system';
  createdAt: string;
  completedAt?: string;
  statusBefore?: TaskStatus;
  statusAfter?: TaskStatus;
  findings: ReviewFinding[];
  evidence: {
    successCriteria: string[];
    reports: Array<{ id: string; title: string; summary?: string | null }>;
    sessionRefs: string[];
    completedBy?: { name?: string; sessionKey?: string; harness?: TaskExecutionHarness } | null;
    workspace?: ReviewWorkspaceEvidence;
    testSignals?: string[];
  };
}

export interface TaskTimelineEvent {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  description?: string | null;
  createdAt: string;
  sessionKey?: string | null;
  actor?: string | null;
  harness?: TaskExecutionHarness | string | null;
  source: 'timeline' | 'agent-history' | 'review-history' | 'legacy';
  metadata?: Record<string, any>;
}

export interface Task {
  // Core fields
  id: string;
  title: string;
  description: string;  // Rich text (Markdown)
  
  // Status
  status: TaskStatus;
  priority: TaskPriority;
  
  // Subtasks (checkboxes)
  subtasks: Subtask[];
  
  // Rich context
  links: TaskLink[];
  
  // Audit trail
  sessionRefs: string[];  // Session keys that touched this
  
  // Work tracking
  autoCreated: boolean;   // Was this auto-detected?
  autoStart: boolean;     // Can bot auto-pick this up?
  lastChecked?: string;   // When bot last reviewed it
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  
  // Blocking
  blockedBy: string[];    // Task IDs
  blockedReason?: string; // Why stuck?
  
  // Task Dependencies (for task chains / phases)
  dependsOn?: string[];   // Array of task IDs this task depends on
  
  // Computed dependency fields (from API)
  blocked?: boolean;      // True if task has unmet dependencies
  blockingTasks?: Array<{ id: string; title: string }>;  // Tasks blocking this one
  dependentTasks?: Array<{ id: string; title: string }>; // Tasks that depend on this
  
  // Metadata
  project?: string;
  tags: string[];
  created: string;
  updated: string;
  
  // Phase 3: Multi-phase tracking
  trackerUrl?: string;    // Path to shared tracker doc
  phaseTag?: string;      // Tag linking related tasks
  
  // Phase 3: Task-specific resources
  taskResources?: TaskResources;
  
  // Agent type association
  agentTypeId?: string;
  agentType?: string;
  
  // AI execution
  model?: string;
  executionMode?: TaskExecutionMode;
  executionProfile?: TaskExecutionProfile;
  successCriteria?: string | string[];
  reviewHistory?: ReviewHistoryEntry[];
  maxRetries?: number;
  definitionOfDone?: string | string[];
  constraints?: string | string[];
  acpSessionKey?: string | null;
  discordThreadId?: string | null;
  discordThreadUrl?: string | null;
  activeAgent?: string | { name: string; sessionKey: string; harness?: TaskExecutionHarness; pid?: number; sourceTag?: string; logPath?: string } | null;
  completedBy?: { name: string; sessionKey: string; harness?: TaskExecutionHarness; pid?: number; sourceTag?: string; logPath?: string } | null;
  needsReview?: boolean;  // Set when agent completes task
  
  // Thinking level (Phase 2)
  thinking?: 'low' | 'medium' | 'high';
  thinkingAutoEstimated?: boolean;
  attemptCount?: number;
  
  // Legacy fields (for migration)
  parentId?: string | null;
  notes?: string;
  completed?: string | null;
}
