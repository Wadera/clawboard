// Phase 4: Enhanced Task System with Work Orchestration
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session';

// Phase 3: Tri-state subtask status
export type SubtaskStatus = 'new' | 'in_review' | 'completed';

export interface Subtask {
  id: string;
  text: string;
  // Phase 3: Now using tri-state status instead of boolean
  status: SubtaskStatus;
  // Legacy support - will be migrated to status
  completed?: boolean;
  completedAt?: string;
  reviewNote?: string;  // Agent's note when marking for review
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

export interface TaskLink {
  type: TaskLinkType;
  url: string;
  title: string;
  icon?: string;
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
  
  // AI execution
  model?: string;
  executionMode?: 'main' | 'subagent';
  activeAgent?: string | { name: string; sessionKey: string } | null;
  completedBy?: { name: string; sessionKey: string } | null;
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
