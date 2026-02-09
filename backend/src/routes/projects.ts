// projects.ts - API endpoints for project management
import { Router, Request, Response } from 'express';
import { projectService, ProjectResources, ToolInstructions } from '../services/ProjectService';
import { projectStatsService } from '../services/ProjectStatsService';
import { contextService } from '../services/ContextService';
import { toolManager } from '../services/ToolManager';

const router = Router();

/**
 * GET /api/projects
 * List all projects with optional status filter and stats
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.query.status as 'active' | 'paused' | 'archived' | 'completed' | undefined;
    const includeStats = req.query.includeStats === 'true';
    const includeHidden = req.query.includeHidden === 'true';
    
    const projects = await projectService.list(status, includeHidden);
    
    if (includeStats) {
      // Fetch stats for all projects
      const statsMap = await projectStatsService.getAllStats();
      const projectsWithStats = projects.map(project => ({
        ...project,
        stats: statsMap.get(project.id) || null
      }));
      
      res.json({ success: true, projects: projectsWithStats });
    } else {
      res.json({ success: true, projects });
    }
  } catch (err) {
    console.error('[Projects API] Error listing projects:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, status, is_hidden, links } = req.body;
    
    if (!name || typeof name !== 'string') {
      res.status(400).json({ 
        success: false, 
        error: 'Project name is required' 
      });
      return;
    }
    
    const project = await projectService.create({
      name,
      description,
      status,
      is_hidden,
      links
    });
    
    res.status(201).json({ success: true, project });
  } catch (err) {
    console.error('[Projects API] Error creating project:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /api/projects/:id/generate-brief
 * Generate a ready-to-use agent brief for a task
 */
router.post('/:id/generate-brief', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { taskId } = req.body;

    if (!taskId) {
      res.status(400).json({ success: false, error: 'taskId is required' });
      return;
    }

    const project = await projectService.getById(id);
    const context = await contextService.buildContext(id, { role: 'agent', taskId });

    // Fetch task details
    const { taskManager } = await import('../services/TaskManager');
    const task = taskManager.getTask(taskId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const apiBase = `http://localhost:8082/api`;
    const gitLink = project.links?.find((l: any) => l.type === 'git');

    // Build subtasks section
    const subtaskLines = (task.subtasks || []).map((s: any, i: number) =>
      `- [${s.completed ? 'x' : i}] ${s.text}`
    ).join('\n');

    const subtaskApiLines = `PUT ${apiBase}/tasks/${taskId}/subtasks/{index} with {"completed": true}`;

    // Build links section
    const linkLines = (project.links || [])
      .map((l: any) => `- **${l.title}** (${l.type}): ${l.url}`)
      .join('\n');

    const brief = `## ${task.title}

**Task ID:** ${taskId}
**API Base:** ${apiBase}
**Dev backend:** http://localhost:3001

### Setup
1. \`cd /path/to/your/project && git checkout dev && git merge main --no-edit\`

### Context
${task.description || 'No description provided.'}

### What to Build
${task.description || ''}

### Subtasks
${subtaskApiLines}

${subtaskLines}

### Project Resources
${linkLines || 'No links configured.'}
${gitLink ? `\n**Repository:** ${gitLink.url}` : ''}

### Source Tree
${(context.files?.sourceTree || []).map((f: string) => `- ${f}`).join('\n') || 'No source tree available.'}

### IMPORTANT RULES
1. Update EACH subtask as you complete it via the task API
2. When ALL subtasks are done, set status to "stuck" with notes "Ready for review"
3. Do NOT set status to "completed"
4. Commit to dev branch only
5. Use plain CSS, no Tailwind`;

    res.json({ success: true, brief, tokenEstimate: Math.ceil(brief.length / 4) });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error generating brief:', err);
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
});

/**
 * GET /api/projects/:id/context
 * Get structured project context for agent or orchestrator consumption
 */
router.get('/:id/context', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const role = (req.query.role as string) || 'agent';
    const taskId = req.query.taskId as string | undefined;
    const budget = req.query.budget ? parseInt(req.query.budget as string) : undefined;

    if (role !== 'agent' && role !== 'orchestrator') {
      res.status(400).json({ success: false, error: 'Role must be "agent" or "orchestrator"' });
      return;
    }

    const context = await contextService.buildContext(id, { role, taskId, budget });
    res.json({ success: true, context });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error building context:', err);
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
});

/**
 * POST /api/projects/:id/archive
 * Archive a project (soft delete)
 * NOTE: Specific routes must come BEFORE generic /:id routes in Express
 */
router.post('/:id/archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const project = await projectService.archive(id);
    
    res.json({ success: true, project, message: 'Project archived successfully' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error archiving project:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * POST /api/projects/:id/unarchive
 * Restore a project from archive
 */
router.post('/:id/unarchive', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const project = await projectService.unarchive(id);
    
    res.json({ success: true, project, message: 'Project restored from archive' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error unarchiving project:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * GET /api/projects/:id/delete-preview
 * Preview what will be deleted
 */
router.get('/:id/delete-preview', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const preview = await projectService.getDeletePreview(id);
    
    res.json({ success: true, preview });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error getting delete preview:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project (archive by default, hard delete with ?hard=true)
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const hardDelete = req.query.hard === 'true';
    
    if (hardDelete) {
      // Permanent deletion
      const result = await projectService.hardDelete(id);
      res.json({ 
        success: true, 
        message: 'Project permanently deleted',
        deletedTasks: result.deletedTasks,
        deletedLinks: result.deletedLinks,
      });
    } else {
      // Soft delete (archive)
      await projectService.delete(id);
      res.json({ success: true, message: 'Project archived successfully' });
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ 
        success: false, 
        error: err.message 
      });
    } else {
      console.error('[Projects API] Error deleting project:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * GET /api/projects/:id/stats
 * Get project statistics
 */
router.get('/:id/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const days = req.query.days ? parseInt(req.query.days as string) : 7;
    
    const project = await projectService.getById(id);
    const stats = projectStatsService.getStatsByName(project.name);
    const recentActivity = projectStatsService.getRecentActivity(project.name, days);
    
    res.json({ 
      success: true, 
      stats: {
        ...stats,
        recent_activity: recentActivity
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ 
        success: false, 
        error: err.message 
      });
    } else {
      console.error('[Projects API] Error getting project stats:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * POST /api/projects/:id/links
 * Add a link to a project
 */
router.post('/:id/links', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { type, title, url, category } = req.body;
    
    if (!type || !title || !url) {
      res.status(400).json({ 
        success: false, 
        error: 'Link type, title, and url are required' 
      });
      return;
    }
    
    const validTypes = ['git', 'doc', 'url', 'api', 'project', 'dashboard', 'notebooklm', 'file'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ 
        success: false, 
        error: `Invalid link type. Must be one of: ${validTypes.join(', ')}` 
      });
      return;
    }
    
    // Validate category if provided
    const validCategories = ['repository', 'environment', 'documentation', 'research', 'reference', 'tool'];
    if (category && !validCategories.includes(category)) {
      res.status(400).json({ 
        success: false, 
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}` 
      });
      return;
    }
    
    const link = await projectService.addLink(id, { type, title, url, category });
    
    res.status(201).json({ success: true, link });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ 
        success: false, 
        error: err.message 
      });
    } else {
      console.error('[Projects API] Error adding link:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * PUT /api/projects/:id/links/:linkId
 * Update a link
 */
router.put('/:id/links/:linkId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { linkId } = req.params;
    const { type, title, url, category } = req.body;
    
    if (!type || !title || !url) {
      res.status(400).json({ success: false, error: 'Link type, title, and url are required' });
      return;
    }
    
    await projectService.updateLink(linkId, { type, title, url, category });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error updating link:', err);
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
});

/**
 * DELETE /api/projects/:id/links/:linkId
 * Remove a link from a project
 */
router.delete('/:id/links/:linkId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { linkId } = req.params;
    await projectService.removeLink(linkId);
    
    res.json({ success: true, message: 'Link removed successfully' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ 
        success: false, 
        error: err.message 
      });
    } else {
      console.error('[Projects API] Error removing link:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * GET /api/projects/distribution
 * Get task distribution across projects
 */
router.get('/stats/distribution', async (_req: Request, res: Response): Promise<void> => {
  try {
    const distribution = await projectStatsService.getTaskDistribution();
    
    res.json({ success: true, distribution });
  } catch (err) {
    console.error('[Projects API] Error getting task distribution:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// ============================================================
// Phase 1 Hub Redesign: Project Resources Management APIs
// ============================================================

/**
 * GET /api/projects/:id/resources
 * Get project resources
 */
router.get('/:id/resources', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const project = await projectService.getById(id);
    
    res.json({ 
      success: true, 
      resources: project.resources || {},
      toolInstructions: project.toolInstructions || {}
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error getting project resources:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * PATCH /api/projects/:id/resources
 * Update project resources (merge with existing)
 */
router.patch('/:id/resources', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const resources: Partial<ProjectResources> = req.body;
    
    const project = await projectService.updateResources(id, resources);
    
    res.json({ success: true, project });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error updating project resources:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * PUT /api/projects/:id/resources
 * Replace all project resources
 */
router.put('/:id/resources', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const resources: ProjectResources = req.body;
    
    const project = await projectService.update(id, { resources });
    
    res.json({ success: true, project });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error replacing project resources:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * GET /api/projects/:id/tool-instructions
 * Get project tool instructions
 */
router.get('/:id/tool-instructions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const project = await projectService.getById(id);
    
    res.json({ 
      success: true, 
      toolInstructions: project.toolInstructions || {}
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error getting tool instructions:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * PATCH /api/projects/:id/tool-instructions
 * Update project tool instructions (merge with existing)
 */
router.patch('/:id/tool-instructions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const toolInstructions: Partial<ToolInstructions> = req.body;
    
    const project = await projectService.updateToolInstructions(id, toolInstructions);
    
    res.json({ success: true, project });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error updating tool instructions:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * PUT /api/projects/:id/tool-instructions
 * Replace all project tool instructions
 */
router.put('/:id/tool-instructions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const toolInstructions: ToolInstructions = req.body;
    
    const project = await projectService.update(id, { toolInstructions });
    
    res.json({ success: true, project });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error replacing tool instructions:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

// ============================================================
// Project-Tool Linking APIs
// ============================================================

/**
 * GET /api/projects/:id/tools
 * List all tools linked to a project (includes tool details)
 */
router.get('/:id/tools', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    // Verify project exists
    await projectService.getById(id);

    const projectTools = await toolManager.getProjectTools(id);
    res.json({ success: true, tools: projectTools });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error getting project tools:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
});

/**
 * PUT /api/projects/:id/tools
 * Replace all linked tools for a project
 * Body: { tools: [{ tool_id: string, override_instructions?: string }] }
 */
router.put('/:id/tools', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { tools } = req.body;

    // Verify project exists
    await projectService.getById(id);

    if (!Array.isArray(tools)) {
      res.status(400).json({ success: false, error: 'tools must be an array of { tool_id, override_instructions? }' });
      return;
    }

    const result = await toolManager.updateProjectTools(id, tools);
    res.json({ success: true, tools: result });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Projects API] Error updating project tools:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
});

/**
 * GET /api/projects/:id
 * Get project details by ID
 * NOTE: Generic /:id routes must come LAST in Express routing
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const project = await projectService.getById(id);
    
    res.json({ success: true, project });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ 
        success: false, 
        error: err.message 
      });
    } else {
      console.error('[Projects API] Error getting project:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * PATCH /api/projects/:id
 * Update project
 */
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description, status, is_hidden, sourceDir, nfsDir } = req.body;
    
    const project = await projectService.update(id, {
      name,
      description,
      status,
      is_hidden,
      sourceDir,
      nfsDir
    });
    
    res.json({ success: true, project });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ 
        success: false, 
        error: err.message 
      });
    } else {
      console.error('[Projects API] Error updating project:', err);
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

export default router;
