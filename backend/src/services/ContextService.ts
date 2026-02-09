// ContextService.ts - Build role-based context payloads for projects
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { projectService } from './ProjectService';
import { taskManager } from './TaskManager';
import { agentHistoryService } from './AgentHistoryService';
import { toolManager } from './ToolManager';

const PROJECT_SOURCES_DIR = existsSync('/project-sources') ? '/project-sources' : '/clawd-media/project-sources';
const PROJECT_FILES_DIR = '/clawd-media/projects';

// Directories/files to exclude from recursive file listings
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.tsbuildinfo',
  '.DS_Store',
];

function shouldExclude(name: string): boolean {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.startsWith('*')) {
      return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
  });
}

type Role = 'agent' | 'orchestrator';

interface ContextOptions {
  role: Role;
  budget?: number;
  taskId?: string;
}

function estimateTokens(obj: any): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

function getSourceTree(sourceDir: string): string[] {
  const fullPath = path.join(PROJECT_SOURCES_DIR, sourceDir);
  if (!existsSync(fullPath)) return [];
  try {
    const entries = readdirSync(fullPath);
    return entries
      .filter(e => !e.startsWith('.') && e !== 'node_modules')
      .map(e => {
        try {
          const stat = statSync(path.join(fullPath, e));
          return stat.isDirectory() ? `${e}/` : e;
        } catch {
          return e;
        }
      })
      .sort((a, b) => {
        const aDir = a.endsWith('/');
        const bDir = b.endsWith('/');
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

const NFS_PROJECTS_DIR = existsSync('/nfs-projects') ? '/nfs-projects' : '/clawd-media/nfs-projects';

function getProjectFiles(projectId: string, nfsDir?: string): string[] {
  // Try NFS path first (if project has nfsDir set)
  if (nfsDir) {
    const nfsPath = path.join(NFS_PROJECTS_DIR, nfsDir);
    if (existsSync(nfsPath)) {
      try {
        return listFilesRecursive(nfsPath, '');
      } catch {
        // fall through to legacy
      }
    }
  }
  // Fallback to legacy path
  const dir = path.join(PROJECT_FILES_DIR, projectId, 'files');
  if (!existsSync(dir)) return [];
  try {
    return listFilesRecursive(dir, '');
  } catch {
    return [];
  }
}

function listFilesRecursive(basePath: string, prefix: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(basePath);
  for (const e of entries) {
    if (shouldExclude(e)) continue;
    const full = path.join(basePath, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    try {
      if (statSync(full).isDirectory()) {
        results.push(`${rel}/`);
        results.push(...listFilesRecursive(full, rel));
      } else {
        results.push(rel);
      }
    } catch { /* skip */ }
  }
  return results;
}

function readFileContent(sourceDir: string, filename: string, maxLines?: number): string | null {
  const fullPath = path.join(PROJECT_SOURCES_DIR, sourceDir, filename);
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, 'utf-8');
    if (maxLines) {
      return content.split('\n').slice(0, maxLines).join('\n');
    }
    return content;
  } catch {
    return null;
  }
}

export class ContextService {
  async buildContext(projectId: string, options: ContextOptions): Promise<any> {
    const { role, taskId } = options;
    const defaultBudget = role === 'agent' ? 2000 : 5000;
    const budget = options.budget || defaultBudget;

    const project = await projectService.getById(projectId);
    const gitLink = project.links?.find(l => l.type === 'git');
    const otherLinks = project.links?.filter(l => l.type !== 'git') || [];

    // Extract structured resources if available
    const structuredResources = project.resources || {};
    const toolInstructions = project.toolInstructions || {};

    // Priority 1-3: Always included (project info, repo, links)
    const payload: any = {
      project: {
        name: project.name,
        description: project.description || '',
        status: project.status,
      },
      resources: {
        // Use structured resources if available, fallback to legacy
        repository: structuredResources.repositories?.main || gitLink?.url || null,
        additionalRepos: structuredResources.repositories?.additional || [],
        environments: structuredResources.environments || {},
        localPaths: structuredResources.localPaths || {
          nfsRoot: project.nfs_dir ? `/mnt/nfs/NimsProjects/${project.nfs_dir}` : null,
        },
        links: otherLinks.map(l => ({ type: l.type, title: l.title, url: l.url })),
      },
      files: {
        sourceTree: [] as string[],
        projectFiles: [] as string[],
      },
    };

    // Add NotebookLM info if configured
    if (structuredResources.notebooks) {
      payload.notebooks = {};
      
      if (structuredResources.notebooks.documentation) {
        payload.notebooks.documentation = {
          id: structuredResources.notebooks.documentation.id,
          url: structuredResources.notebooks.documentation.url,
          description: structuredResources.notebooks.documentation.description,
          queryTips: structuredResources.notebooks.documentation.queryTips || [],
        };
      }
      
      if (structuredResources.notebooks.research) {
        payload.notebooks.research = {
          id: structuredResources.notebooks.research.id,
          url: structuredResources.notebooks.research.url,
          description: structuredResources.notebooks.research.description,
          queryTips: structuredResources.notebooks.research.queryTips || [],
        };
      }

      if (structuredResources.notebooks.additional?.length) {
        payload.notebooks.additional = structuredResources.notebooks.additional;
      }
    }

    // Priority 4: Source file tree
    if (project.source_dir) {
      payload.files.sourceTree = getSourceTree(project.source_dir);
    }

    // Priority 5: Project uploaded files (NFS or legacy)
    payload.files.projectFiles = getProjectFiles(projectId, project.nfs_dir);

    // Check budget so far
    let currentTokens = estimateTokens(payload);

    // Priority 6: README.md content (from source dir or NFS project files)
    let readme: string | null = null;
    if (project.source_dir) {
      readme = readFileContent(project.source_dir, 'README.md');
    }
    if (!readme && project.nfs_dir) {
      const nfsReadme = path.join(NFS_PROJECTS_DIR, project.nfs_dir, 'README.md');
      if (existsSync(nfsReadme)) {
        try { readme = readFileSync(nfsReadme, 'utf-8'); } catch {}
      }
    }
    if (readme && currentTokens < budget) {
      if (readme) {
        const withReadme = { ...payload, files: { ...payload.files, readmeContent: readme } };
        const readmeTokens = estimateTokens(withReadme);
        if (readmeTokens <= budget) {
          payload.files.readmeContent = readme;
          currentTokens = readmeTokens;
        } else {
          // Truncate README to fit (reserve 200 chars for tokenEstimate field and later items)
          const availableChars = (budget - currentTokens) * 4 - 400;
          if (availableChars > 200) {
            payload.files.readmeContent = readme.substring(0, availableChars) + '\n...(truncated)';
            currentTokens = estimateTokens(payload);
          }
        }
      }
    }

    // Priority 7: CHANGELOG.md first 50 lines
    if (project.source_dir && currentTokens < budget) {
      const changelog = readFileContent(project.source_dir, 'CHANGELOG.md', 50);
      if (changelog) {
        const test = { ...payload, files: { ...payload.files, changelogPreview: changelog } };
        if (estimateTokens(test) <= budget) {
          payload.files.changelogPreview = changelog;
          currentTokens = estimateTokens(payload);
        }
      }
    }

    // Priority 8: Current task context (if taskId provided)
    if (taskId && currentTokens < budget) {
      const task = taskManager.getTask(taskId);
      if (task) {
        const taskContext: any = {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          // Use tri-state status, with legacy completed fallback
          subtasks: task.subtasks.map(s => ({ 
            text: s.text, 
            status: s.status || (s.completed ? 'completed' : 'new'),
            reviewNote: s.reviewNote,
          })),
          // Include task-specific resources if available
          trackerUrl: task.trackerUrl,
          phaseTag: task.phaseTag,
          taskResources: task.taskResources,
        };
        const test = { ...payload, currentTask: taskContext };
        if (estimateTokens(test) <= budget) {
          payload.currentTask = taskContext;
          currentTokens = estimateTokens(payload);
        }
      }
    }

    // Priority 9: Tool instructions (DB tools + legacy fallback)
    if (currentTokens < budget) {
      const instructions: any = {};
      
      // Fetch effective tools from DB (global + project-linked with overrides)
      try {
        const effectiveTools = await toolManager.getEffectiveToolsForProject(projectId);
        if (effectiveTools.length > 0) {
          instructions.tools = effectiveTools.map(t => ({
            name: t.name,
            category: t.category,
            description: t.description,
            instructions: t.instructions,
            is_global: t.is_global,
            has_override: t.has_override,
          }));
        }
      } catch {
        // DB tools not available yet (migration not run) — fall through to legacy
      }

      // DEPRECATED: Legacy fallback — include project.toolInstructions only if no DB tools found.
      // Once all projects have migrated to the tools management system, this block can be removed.
      if (!instructions.tools || instructions.tools.length === 0) {
        if (toolInstructions.notebookLM) {
          instructions.notebookLM = toolInstructions.notebookLM;
        }
        if (toolInstructions.filesBrowsing) {
          instructions.filesBrowsing = toolInstructions.filesBrowsing;
        }
        if (toolInstructions.gitWorkflow) {
          instructions.gitWorkflow = toolInstructions.gitWorkflow;
        }
      } else {
        // DEPRECATED: Even with DB tools, include legacy fields that aren't tool-specific.
        // TODO: Migrate gitWorkflow to a DB tool entry, then remove this fallback.
        if (toolInstructions.gitWorkflow) {
          instructions.gitWorkflow = toolInstructions.gitWorkflow;
        }
      }
      
      // Role-specific instructions
      if (role === 'agent') {
        instructions.taskManagement = `
Update subtasks as you complete them:
- Use PATCH /tasks/{taskId}/subtasks/{index}/status with {"status": "in_review", "role": "agent"}
- Or use task management CLI: task management CLI complete-subtask TASK_ID INDEX

When finished or stuck:
- Set task to 'stuck' with notes: task management CLI move TASK_ID stuck --note "Ready for review"

⚠️ You CANNOT mark subtasks as 'completed' - only the orchestrator can do that.
⚠️ You CANNOT mark tasks as 'completed' - orchestrator reviews first.
        `.trim();
        
        if (toolInstructions.testing) {
          instructions.testing = toolInstructions.testing;
        }
      } else {
        // Orchestrator instructions
        instructions.orchestratorRules = `
- Review 'in_review' subtasks and approve or reject them
- Use POST /tasks/{taskId}/subtasks/{index}/approve to mark completed
- Use POST /tasks/{taskId}/subtasks/{index}/reject with {"note": "reason"} to send back
- Task can only be 'completed' when ALL subtasks are 'completed'
        `.trim();
        
        if (toolInstructions.deployment) {
          instructions.deployment = toolInstructions.deployment;
        }
      }
      
      if (Object.keys(instructions).length > 0) {
        const test = { ...payload, toolInstructions: instructions };
        if (estimateTokens(test) <= budget) {
          payload.toolInstructions = instructions;
          currentTokens = estimateTokens(payload);
        }
      }
    }

    // Orchestrator: additional fields
    if (role === 'orchestrator') {
      const tasks = taskManager.queryTasks({ project: project.name });
      const byStatus: Record<string, number> = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      }

      const recentlyCompleted = tasks
        .filter(t => t.status === 'completed' && t.completedAt)
        .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
        .slice(0, 5)
        .map(t => ({
          title: t.title,
          completedAt: t.completedAt,
          agent: t.completedBy?.name || t.activeAgent?.name || null,
        }));

      const currentlyActive = tasks
        .filter(t => t.status === 'in-progress')
        .map(t => ({
          title: t.title,
          agent: t.activeAgent?.name || null,
        }));

      const blocked = tasks
        .filter(t => t.status === 'stuck')
        .map(t => ({
          title: t.title,
          blockedBy: t.blockedBy || [],
          blockedReason: t.blockedReason || null,
        }));

      const tasksSummary = {
        total: tasks.length,
        byStatus,
        recentlyCompleted,
        currentlyActive,
        blocked,
      };

      // Sessions from agent history
      const allHistory = await agentHistoryService.getAll();
      const projectSessions = allHistory.filter(r => {
        const task = taskManager.getTask(r.taskId);
        return task?.project === project.name;
      });

      const sessionsSummary = {
        total: projectSessions.length,
        recent: projectSessions
          .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
          .slice(0, 5)
          .map(s => ({
            label: s.label,
            model: s.model || null,
            duration: s.durationMs ? `${Math.round(s.durationMs / 60000)}m` : null,
            tokens: s.tokenUsage?.total || null,
          })),
      };

      // Add if fits in budget
      const test = { ...payload, tasks: tasksSummary, sessions: sessionsSummary };
      if (estimateTokens(test) <= budget) {
        payload.tasks = tasksSummary;
        payload.sessions = sessionsSummary;
        currentTokens = estimateTokens(payload);
      } else {
        // Try just tasks without sessions
        const testTasks = { ...payload, tasks: tasksSummary };
        if (estimateTokens(testTasks) <= budget) {
          payload.tasks = tasksSummary;
          currentTokens = estimateTokens(payload);
        }
      }
    }

    payload.tokenEstimate = estimateTokens(payload);
    return payload;
  }
}

export const contextService = new ContextService();
