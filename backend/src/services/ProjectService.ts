// ProjectService.ts - CRUD operations for projects
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';

export type LinkCategory = 'repository' | 'environment' | 'documentation' | 'research' | 'reference' | 'tool';

export interface ProjectLink {
  id?: string;
  project_id?: string;
  type: 'git' | 'doc' | 'url' | 'api' | 'project' | 'dashboard' | 'notebooklm' | 'file';
  title: string;
  url: string;
  category?: LinkCategory;
  created_at?: string;
}

// Notebook configuration with query tips
export interface NotebookConfig {
  id: string;
  url: string;
  description: string;
  queryTips: string[];
}

// Structured project resources
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

// Tool instructions for agents
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
  status: 'active' | 'paused' | 'archived' | 'completed';
  is_hidden?: boolean;
  source_dir?: string;
  nfs_dir?: string;
  created_at: string;
  updated_at: string;
  links?: ProjectLink[];
  // Phase 1: New structured fields
  resources?: ProjectResources;
  /**
   * @deprecated Use the tools management system (tools table + project_tools junction) instead.
   * This field is kept for backward compatibility but will be removed in a future version.
   * ContextService prefers DB-backed tools over this legacy field.
   * Manage tools via: task management CLI tools add/link/unlink, or the dashboard Tools page.
   */
  toolInstructions?: ToolInstructions;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  status?: 'active' | 'paused' | 'archived' | 'completed';
  is_hidden?: boolean;
  links?: Omit<ProjectLink, 'id' | 'project_id' | 'created_at'>[];
  resources?: ProjectResources;
  /** @deprecated Use tools management system instead. See Project.toolInstructions. */
  toolInstructions?: ToolInstructions;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: 'active' | 'paused' | 'archived' | 'completed';
  is_hidden?: boolean;
  sourceDir?: string;
  nfsDir?: string;
  resources?: ProjectResources;
  /** @deprecated Use tools management system instead. See Project.toolInstructions. */
  toolInstructions?: ToolInstructions;
}

export class ProjectService {
  /**
   * Create a new project
   */
  async create(input: CreateProjectInput): Promise<Project> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const id = uuidv4();
      const status = input.status || 'active';
      const isHidden = input.is_hidden || false;
      
      // Insert project with new JSONB columns and is_hidden flag
      await client.query(
        `INSERT INTO projects (id, name, description, status, is_hidden, resources, tool_instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id, 
          input.name, 
          input.description || null, 
          status,
          isHidden,
          input.resources ? JSON.stringify(input.resources) : null,
          input.toolInstructions ? JSON.stringify(input.toolInstructions) : null
        ]
      );
      
      // Insert links if provided
      if (input.links && input.links.length > 0) {
        for (const link of input.links) {
          const linkId = uuidv4();
          await client.query(
            `INSERT INTO project_links (id, project_id, type, title, url)
             VALUES ($1, $2, $3, $4, $5)`,
            [linkId, id, link.type, link.title, link.url]
          );
        }
      }
      
      await client.query('COMMIT');
      
      // Fetch and return complete project with links
      return await this.getById(id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get project by ID
   */
  async getById(id: string): Promise<Project> {
    const projectResult = await pool.query(
      'SELECT * FROM projects WHERE id = $1',
      [id]
    );
    
    if (projectResult.rows.length === 0) {
      throw new Error(`Project not found: ${id}`);
    }
    
    const row = projectResult.rows[0];
    
    // Fetch links
    const linksResult = await pool.query(
      'SELECT * FROM project_links WHERE project_id = $1 ORDER BY created_at ASC',
      [id]
    );
    
    return this.mapRowToProject(row, linksResult.rows);
  }

  /**
   * Map database row to Project interface
   */
  private mapRowToProject(row: any, links: ProjectLink[] = []): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      is_hidden: row.is_hidden || false,
      source_dir: row.source_dir,
      nfs_dir: row.nfs_dir,
      created_at: row.created_at,
      updated_at: row.updated_at,
      links,
      // Parse JSONB columns (PostgreSQL returns them as objects already, but handle strings too)
      resources: typeof row.resources === 'string' 
        ? JSON.parse(row.resources) 
        : row.resources || undefined,
      toolInstructions: typeof row.tool_instructions === 'string' 
        ? JSON.parse(row.tool_instructions) 
        : row.tool_instructions || undefined,
    };
  }

  /**
   * List all projects (optionally filter by status, include/exclude hidden)
   */
  async list(status?: 'active' | 'paused' | 'archived' | 'completed', includeHidden: boolean = true): Promise<Project[]> {
    let query = 'SELECT * FROM projects';
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    
    if (!includeHidden) {
      conditions.push(`is_hidden = FALSE`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    
    // Fetch links for all projects
    const projects = await Promise.all(
      result.rows.map(async (row) => {
        const linksResult = await pool.query(
          'SELECT * FROM project_links WHERE project_id = $1 ORDER BY created_at ASC',
          [row.id]
        );
        return this.mapRowToProject(row, linksResult.rows);
      })
    );
    
    return projects;
  }

  /**
   * Update project
   */
  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    
    if (input.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(input.name);
    }
    
    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(input.description);
    }
    
    if (input.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      params.push(input.status);
    }
    
    if (input.is_hidden !== undefined) {
      updates.push(`is_hidden = $${paramIndex++}`);
      params.push(input.is_hidden);
    }
    
    if (input.sourceDir !== undefined) {
      updates.push(`source_dir = $${paramIndex++}`);
      params.push(input.sourceDir);
    }
    
    if (input.nfsDir !== undefined) {
      updates.push(`nfs_dir = $${paramIndex++}`);
      params.push(input.nfsDir);
    }
    
    // Handle JSONB columns
    if (input.resources !== undefined) {
      updates.push(`resources = $${paramIndex++}`);
      params.push(JSON.stringify(input.resources));
    }
    
    if (input.toolInstructions !== undefined) {
      updates.push(`tool_instructions = $${paramIndex++}`);
      params.push(JSON.stringify(input.toolInstructions));
    }
    
    if (updates.length === 0) {
      return await this.getById(id);
    }
    
    params.push(id);
    
    const result = await pool.query(
      `UPDATE projects SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );
    
    if (result.rows.length === 0) {
      throw new Error(`Project not found: ${id}`);
    }
    
    return await this.getById(id);
  }

  /**
   * Update project resources (merge with existing)
   */
  async updateResources(id: string, resources: Partial<ProjectResources>): Promise<Project> {
    const project = await this.getById(id);
    const mergedResources = {
      ...project.resources,
      ...resources,
    };
    return this.update(id, { resources: mergedResources });
  }

  /**
   * Update tool instructions (merge with existing)
   * @deprecated Use the tools management system (ToolManager.linkToProject) instead.
   * This method is kept for backward compatibility only.
   */
  async updateToolInstructions(id: string, toolInstructions: Partial<ToolInstructions>): Promise<Project> {
    const project = await this.getById(id);
    const mergedInstructions = {
      ...project.toolInstructions,
      ...toolInstructions,
    };
    return this.update(id, { toolInstructions: mergedInstructions });
  }

  /**
   * Delete (archive) project - soft delete by setting status to 'archived'
   */
  async delete(id: string): Promise<void> {
    await this.archive(id);
  }

  /**
   * Archive a project (soft delete - sets status to 'archived')
   */
  async archive(id: string): Promise<Project> {
    return await this.update(id, { status: 'archived' });
  }

  /**
   * Unarchive a project (restore from archive - sets status to 'active')
   */
  async unarchive(id: string): Promise<Project> {
    return await this.update(id, { status: 'active' });
  }

  /**
   * Preview what will be affected by deleting a project
   */
  async getDeletePreview(id: string): Promise<{
    project: Project;
    tasks: { id: string; title: string; status: string }[];
    links: ProjectLink[];
    totalTasks: number;
    totalLinks: number;
  }> {
    const project = await this.getById(id);
    
    // Get all tasks for this project
    const tasksResult = await pool.query(
      'SELECT id, title, status FROM tasks WHERE project_id = $1',
      [id]
    );
    
    // Get all links (already fetched in project)
    const links = project.links || [];
    
    return {
      project,
      tasks: tasksResult.rows,
      links,
      totalTasks: tasksResult.rows.length,
      totalLinks: links.length,
    };
  }

  /**
   * Permanently delete a project and all related data (hard delete)
   * WARNING: This cannot be undone!
   */
  async hardDelete(id: string): Promise<{
    success: boolean;
    deletedTasks: number;
    deletedLinks: number;
  }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get counts before deletion
      const tasksResult = await client.query(
        'SELECT COUNT(*) as count FROM tasks WHERE project_id = $1',
        [id]
      );
      const linksResult = await client.query(
        'SELECT COUNT(*) as count FROM project_links WHERE project_id = $1',
        [id]
      );
      
      const deletedTasks = parseInt(tasksResult.rows[0].count);
      const deletedLinks = parseInt(linksResult.rows[0].count);
      
      // Delete tasks associated with this project
      await client.query('DELETE FROM tasks WHERE project_id = $1', [id]);
      
      // Delete links (CASCADE will handle this, but being explicit)
      await client.query('DELETE FROM project_links WHERE project_id = $1', [id]);
      
      // Delete project
      const result = await client.query('DELETE FROM projects WHERE id = $1 RETURNING *', [id]);
      
      if (result.rows.length === 0) {
        throw new Error(`Project not found: ${id}`);
      }
      
      await client.query('COMMIT');
      
      return {
        success: true,
        deletedTasks,
        deletedLinks,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Add a link to a project
   */
  async addLink(projectId: string, link: Omit<ProjectLink, 'id' | 'project_id' | 'created_at'>): Promise<ProjectLink> {
    // Verify project exists
    await this.getById(projectId);
    
    const id = uuidv4();
    const result = await pool.query(
      `INSERT INTO project_links (id, project_id, type, title, url, category)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, projectId, link.type, link.title, link.url, link.category || null]
    );
    
    return result.rows[0];
  }

  /**
   * Update a link
   */
  async updateLink(linkId: string, data: { type: string; title: string; url: string; category?: string }): Promise<void> {
    const result = await pool.query(
      'UPDATE project_links SET type = $1, title = $2, url = $3, category = $4 WHERE id = $5 RETURNING *',
      [data.type, data.title, data.url, data.category || null, linkId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Link not found: ${linkId}`);
    }
  }

  async removeLink(linkId: string): Promise<void> {
    const result = await pool.query(
      'DELETE FROM project_links WHERE id = $1 RETURNING *',
      [linkId]
    );
    
    if (result.rows.length === 0) {
      throw new Error(`Link not found: ${linkId}`);
    }
  }
}

export const projectService = new ProjectService();
