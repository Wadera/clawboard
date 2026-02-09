// Tool types for frontend

export interface Tool {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  usage_instructions: string | null;
  config: Record<string, any>;
  tags: string[];
  is_global: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectToolLink {
  id: string;
  project_id: string;
  tool_id: string;
  override_instructions: string | null;
  created_at: string;
  tool: Tool;
}

export interface CreateToolInput {
  name: string;
  category?: string;
  description?: string;
  usage_instructions?: string;
  config?: Record<string, any>;
  tags?: string[];
  is_global?: boolean;
}

export interface UpdateToolInput {
  name?: string;
  category?: string;
  description?: string;
  usage_instructions?: string;
  config?: Record<string, any>;
  tags?: string[];
  is_global?: boolean;
}
