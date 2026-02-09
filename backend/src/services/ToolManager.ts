// ToolManager.ts - CRUD operations for tools registry
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';

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

export interface ProjectToolLink {
  id: string;
  project_id: string;
  tool_id: string;
  override_instructions: string | null;
  created_at: string;
  // Joined fields from tools table
  tool?: Tool;
}

export interface ToolSearchOptions {
  category?: string;
  tag?: string;
  search?: string;
}

export class ToolManager {
  /**
   * Create a new tool
   */
  async create(input: CreateToolInput): Promise<Tool> {
    const id = uuidv4();
    const result = await pool.query(
      `INSERT INTO tools (id, name, category, description, usage_instructions, config, tags, is_global)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.name,
        input.category || null,
        input.description || null,
        input.usage_instructions || null,
        JSON.stringify(input.config || {}),
        input.tags || [],
        input.is_global ?? false,
      ]
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Get tool by ID
   */
  async getById(id: string): Promise<Tool> {
    const result = await pool.query('SELECT * FROM tools WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      throw new Error(`Tool not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  /**
   * Get tool by name
   */
  async getByName(name: string): Promise<Tool | null> {
    const result = await pool.query('SELECT * FROM tools WHERE name = $1', [name]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /**
   * List all tools with optional filters
   */
  async list(options: ToolSearchOptions = {}): Promise<Tool[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (options.category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(options.category);
    }

    if (options.tag) {
      conditions.push(`$${paramIdx++} = ANY(tags)`);
      params.push(options.tag);
    }

    if (options.search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      params.push(`%${options.search}%`);
      paramIdx++;
    }

    let query = 'SELECT * FROM tools';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY name ASC';

    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Update a tool (auto-bumps version)
   */
  async update(id: string, input: UpdateToolInput): Promise<Tool> {
    // Verify exists
    await this.getById(id);

    const updates: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${paramIdx++}`);
      params.push(input.name);
    }
    if (input.category !== undefined) {
      updates.push(`category = $${paramIdx++}`);
      params.push(input.category);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramIdx++}`);
      params.push(input.description);
    }
    if (input.usage_instructions !== undefined) {
      updates.push(`usage_instructions = $${paramIdx++}`);
      params.push(input.usage_instructions);
    }
    if (input.config !== undefined) {
      updates.push(`config = $${paramIdx++}`);
      params.push(JSON.stringify(input.config));
    }
    if (input.tags !== undefined) {
      updates.push(`tags = $${paramIdx++}`);
      params.push(input.tags);
    }
    if (input.is_global !== undefined) {
      updates.push(`is_global = $${paramIdx++}`);
      params.push(input.is_global);
    }

    if (updates.length === 0) {
      return await this.getById(id);
    }

    // Auto-bump version
    updates.push('version = version + 1');
    updates.push('updated_at = CURRENT_TIMESTAMP');

    params.push(id);
    const result = await pool.query(
      `UPDATE tools SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    return this.mapRow(result.rows[0]);
  }

  /**
   * Delete a tool
   */
  async delete(id: string): Promise<void> {
    const result = await pool.query('DELETE FROM tools WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      throw new Error(`Tool not found: ${id}`);
    }
  }

  // ============================================================
  // Project-Tool Linking
  // ============================================================

  /**
   * Link a tool to a project with optional override instructions
   */
  async linkToProject(projectId: string, toolId: string, overrideInstructions?: string): Promise<ProjectToolLink> {
    const linkId = uuidv4();
    const result = await pool.query(
      `INSERT INTO project_tools (id, project_id, tool_id, override_instructions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, tool_id) DO UPDATE SET override_instructions = $4
       RETURNING *`,
      [linkId, projectId, toolId, overrideInstructions || null]
    );
    return result.rows[0];
  }

  /**
   * Unlink a tool from a project
   */
  async unlinkFromProject(projectId: string, toolId: string): Promise<void> {
    const result = await pool.query(
      'DELETE FROM project_tools WHERE project_id = $1 AND tool_id = $2 RETURNING id',
      [projectId, toolId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Tool ${toolId} is not linked to project ${projectId}`);
    }
  }

  /**
   * Get all tools linked to a project (includes tool details)
   */
  async getProjectTools(projectId: string): Promise<(ProjectToolLink & { tool: Tool })[]> {
    const result = await pool.query(
      `SELECT pt.*, 
              t.name, t.category, t.description, t.usage_instructions, 
              t.config, t.tags, t.is_global, t.version,
              t.created_at AS tool_created_at, t.updated_at AS tool_updated_at
       FROM project_tools pt
       JOIN tools t ON pt.tool_id = t.id
       WHERE pt.project_id = $1
       ORDER BY t.name ASC`,
      [projectId]
    );

    return result.rows.map(row => ({
      id: row.id,
      project_id: row.project_id,
      tool_id: row.tool_id,
      override_instructions: row.override_instructions,
      created_at: row.created_at,
      tool: {
        id: row.tool_id,
        name: row.name,
        category: row.category,
        description: row.description,
        usage_instructions: row.usage_instructions,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {},
        tags: row.tags || [],
        is_global: row.is_global,
        version: row.version,
        created_at: row.tool_created_at,
        updated_at: row.tool_updated_at,
      },
    }));
  }

  /**
   * Bulk update project tools (link/unlink with overrides)
   * Replaces all tool links for a project
   */
  async updateProjectTools(
    projectId: string,
    tools: Array<{ tool_id: string; override_instructions?: string }>
  ): Promise<(ProjectToolLink & { tool: Tool })[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove all existing links
      await client.query('DELETE FROM project_tools WHERE project_id = $1', [projectId]);

      // Insert new links
      for (const t of tools) {
        const linkId = uuidv4();
        await client.query(
          `INSERT INTO project_tools (id, project_id, tool_id, override_instructions)
           VALUES ($1, $2, $3, $4)`,
          [linkId, projectId, t.tool_id, t.override_instructions || null]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return this.getProjectTools(projectId);
  }

  /**
   * Get effective tool instructions for a project
   * Returns global tools + project-linked tools with overrides applied
   */
  async getEffectiveToolsForProject(projectId: string): Promise<Array<{
    name: string;
    category: string | null;
    description: string | null;
    instructions: string | null;
    is_global: boolean;
    has_override: boolean;
  }>> {
    // Get global tools
    const globalResult = await pool.query(
      'SELECT * FROM tools WHERE is_global = TRUE ORDER BY name ASC'
    );

    // Get project-linked tools with overrides
    const linkedResult = await pool.query(
      `SELECT t.*, pt.override_instructions
       FROM project_tools pt
       JOIN tools t ON pt.tool_id = t.id
       WHERE pt.project_id = $1
       ORDER BY t.name ASC`,
      [projectId]
    );

    const effectiveTools: Map<string, {
      name: string;
      category: string | null;
      description: string | null;
      instructions: string | null;
      is_global: boolean;
      has_override: boolean;
    }> = new Map();

    // Add global tools first
    for (const row of globalResult.rows) {
      effectiveTools.set(row.id, {
        name: row.name,
        category: row.category,
        description: row.description,
        instructions: row.usage_instructions,
        is_global: true,
        has_override: false,
      });
    }

    // Add/override with project-linked tools
    for (const row of linkedResult.rows) {
      const hasOverride = row.override_instructions !== null;
      effectiveTools.set(row.id, {
        name: row.name,
        category: row.category,
        description: row.description,
        instructions: hasOverride ? row.override_instructions : row.usage_instructions,
        is_global: row.is_global,
        has_override: hasOverride,
      });
    }

    return Array.from(effectiveTools.values());
  }

  /**
   * Map a DB row to a Tool interface
   */
  private mapRow(row: any): Tool {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      usage_instructions: row.usage_instructions,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {},
      tags: row.tags || [],
      is_global: row.is_global,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export const toolManager = new ToolManager();
