// Project types for frontend
export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

// Phase 3: Link categories
export type LinkCategory = 'repository' | 'environment' | 'documentation' | 'research' | 'reference' | 'tool';

export interface ProjectLink {
  id: string;
  project_id: string;
  type: 'git' | 'doc' | 'url' | 'api' | 'project' | 'dashboard' | 'notebooklm' | 'file';
  category?: LinkCategory;
  title: string;
  url: string;
  description?: string;
  queryInstructions?: string;  // For NotebookLM links
  created_at: string;
}

export interface ProjectStats {
  total_tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  active_agents: number;
  last_activity: string | null;
}

// Phase 3: Structured project resources
export interface NotebookConfig {
  id: string;
  url: string;
  description: string;
  queryTips: string[];
}

export interface ProjectResources {
  repositories?: {
    main?: string;
    additional?: string[];
  };
  environments?: {
    production?: string;
    development?: string;
    staging?: string;
  };
  localPaths?: {
    nfsRoot?: string;
    ssdBuild?: string;
    dockerCompose?: string;
  };
  notebooks?: {
    documentation?: NotebookConfig;
    research?: NotebookConfig;
    additional?: Array<NotebookConfig & { name: string; type: 'documentation' | 'research' | 'reference' }>;
  };
}

// Phase 3: Tool instructions for agents
export interface ToolInstructions {
  notebookLM?: string;
  filesBrowsing?: string;
  gitWorkflow?: string;
  testing?: string;
  deployment?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  is_hidden?: boolean;
  created_at: string;
  updated_at: string;
  source_dir?: string;
  links?: ProjectLink[];
  stats?: ProjectStats;
  // Phase 3: New structured fields
  resources?: ProjectResources;
  toolInstructions?: ToolInstructions;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  status?: ProjectStatus;
  is_hidden?: boolean;
  links?: Omit<ProjectLink, 'id' | 'project_id' | 'created_at'>[];
  resources?: ProjectResources;
  toolInstructions?: ToolInstructions;
}
