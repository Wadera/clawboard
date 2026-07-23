// promptTemplate.ts - Generate agent prompts from task data
import { Task } from '../services/TaskManager';
import { toolManager } from '../services/ToolManager';
import { projectService } from '../services/ProjectService';
import { taskManagerDB } from '../services/TaskManagerDB';
import { agentTypeService } from '../services/AgentTypeService';

export interface PromptOptions {
  /** If true, prepend interactive-mode preamble to the prompt */
  interactive?: boolean;
}

/**
 * Generate agent prompt with optional DB-backed tool context.
 * Async version that fetches effective tools for the task's project.
 */
export async function generateTaskPromptWithTools(task: Task, opts: PromptOptions = {}): Promise<string> {
  let basePrompt = generateTaskPrompt(task, opts);

  // Inject agent persona if set — prepend at the very top
  const agentTypeId = (task as any).agentTypeId;
  if (agentTypeId) {
    try {
      const agentType = await agentTypeService.getById(agentTypeId);
      if (agentType && agentType.content) {
        const personaSection = [
          '## Agent Persona',
          '',
          `You are operating as **${agentType.name}** (${agentType.category || 'specialized'} agent).`,
          '',
          agentType.content,
          '',
          '---',
          '',
        ].join('\n');
        basePrompt = personaSection + basePrompt;
      }
    } catch (err) {
      console.warn('[promptTemplate] Could not inject agent persona:', err instanceof Error ? err.message : err);
    }
  }

  if (!task.project) return basePrompt;
  
  try {
    // Resolve project ID from name
    const projects = await projectService.list();
    const project = projects.find(
      (p: any) => p.name === task.project || p.id === task.project
    );
    if (!project) return basePrompt;

    // Fetch project context
    const projectContext: string[] = [];
    projectContext.push('## Project Context');
    projectContext.push('');
    
    if (project.description) {
      projectContext.push(project.description);
      projectContext.push('');
    }
    
    if (project.source_dir) {
      projectContext.push(`**Source Directory:** ${project.source_dir}`);
    }
    
    if (project.nfs_dir) {
      projectContext.push(`**NFS Directory:** ${project.nfs_dir}`);
    }
    
    // Add structured resources (repositories, environments, local paths)
    const resources = project.resources as any;
    if (resources) {
      // Repositories
      if (resources.repositories?.main) {
        projectContext.push(`**Repository:** ${resources.repositories.main}`);
      }
      if (resources.repositories?.additional?.length) {
        for (const repo of resources.repositories.additional) {
          projectContext.push(`**Additional Repo:** ${repo}`);
        }
      }
      
      // Environments
      if (resources.environments) {
        const envEntries = Object.entries(resources.environments).filter(([_, v]) => v);
        if (envEntries.length > 0) {
          projectContext.push('');
          projectContext.push('### Environments');
          projectContext.push('');
          for (const [envName, envUrl] of envEntries) {
            const label = envName.charAt(0).toUpperCase() + envName.slice(1);
            projectContext.push(`- **${label}:** ${envUrl}`);
          }
        }
      }
      
      // Local paths
      if (resources.localPaths) {
        const pathEntries = Object.entries(resources.localPaths).filter(([_, v]) => v);
        if (pathEntries.length > 0) {
          projectContext.push('');
          projectContext.push('### Local Paths');
          projectContext.push('');
          for (const [pathKey, pathVal] of pathEntries) {
            // Convert camelCase to readable: "nfsRoot" → "NFS Root"
            const label = pathKey.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
            projectContext.push(`- **${label}:** \`${pathVal}\``);
          }
        }
      }
    }
    
    // Add project links (docs, git repos, etc.)
    if (project.links && project.links.length > 0) {
      projectContext.push('');
      projectContext.push('### Project Resources');
      projectContext.push('');
      const linksByType: Record<string, typeof project.links> = {};
      project.links.forEach(link => {
        if (!linksByType[link.type]) linksByType[link.type] = [];
        linksByType[link.type].push(link);
      });
      
      const typeLabels: Record<string, string> = {
        git: 'Git Repositories',
        doc: 'Documentation',
        url: 'URLs',
        api: 'APIs',
        file: 'Files',
        dashboard: 'Dashboards',
        notebooklm: 'NotebookLM'
      };
      
      Object.keys(linksByType).sort().forEach(type => {
        const label = typeLabels[type] || type.toUpperCase();
        projectContext.push(`**${label}:**`);
        linksByType[type].forEach(link => {
          projectContext.push(`- [${link.title}](${link.url})`);
        });
        projectContext.push('');
      });
    }
    
    // Fetch task dependencies
    const blockingTasks = await taskManagerDB.getBlockingTasks(task.id);
    if (blockingTasks.length > 0) {
      projectContext.push('### Dependencies');
      projectContext.push('');
      projectContext.push('This task depends on the following tasks being completed:');
      projectContext.push('');
      blockingTasks.forEach((dep: Task) => {
        const statusIcon = dep.status === 'completed' ? '✅' : dep.status === 'in-progress' ? '🔄' : '⏳';
        projectContext.push(`- ${statusIcon} **${dep.title}** (${dep.status})`);
      });
      projectContext.push('');
      projectContext.push('Do not begin blocked work speculatively. If dependency context is missing or unresolved, stop and report that the task is dependency-blocked.');
      projectContext.push('');
    }

    const effectiveTools = await toolManager.getEffectiveToolsForProject(project.id);
    if (!effectiveTools || effectiveTools.length === 0) {
      // Insert project context even if no tools
      const footerMarker = '---\n## Standard Instructions (auto-generated)';
      const idx = basePrompt.indexOf(footerMarker);
      if (idx >= 0) {
        return basePrompt.slice(0, idx) + projectContext.join('\n') + '\n\n' + basePrompt.slice(idx);
      }
      return basePrompt + '\n\n' + projectContext.join('\n');
    }

    // Build tool context section
    const toolSections: string[] = [];
    toolSections.push('## Tool Instructions (from DB)');
    toolSections.push('');

    // Group by category
    const byCategory: Record<string, typeof effectiveTools> = {};
    for (const tool of effectiveTools) {
      const cat = tool.category || 'uncategorized';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(tool);
    }

    for (const cat of Object.keys(byCategory).sort()) {
      const catDisplay = cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      toolSections.push(`### ${catDisplay}`);
      toolSections.push('');
      
      for (const tool of byCategory[cat].sort((a, b) => a.name.localeCompare(b.name))) {
        const badges = tool.is_global ? ' 🌐' : '';
        const override = tool.has_override ? ' ⚡override' : '';
        toolSections.push(`#### ${tool.name}${badges}${override}`);
        if (tool.description) {
          toolSections.push(`*${tool.description}*`);
        }
        if (tool.instructions) {
          toolSections.push('');
          toolSections.push(tool.instructions);
        }
        toolSections.push('');
      }
    }

    // Combine project context and tool context
    const enrichedContext = projectContext.join('\n') + '\n\n' + toolSections.join('\n');

    // Insert before the standard footer
    const footerMarker = '---\n## Standard Instructions (auto-generated)';
    const idx = basePrompt.indexOf(footerMarker);
    if (idx >= 0) {
      return basePrompt.slice(0, idx) + enrichedContext + '\n\n' + basePrompt.slice(idx);
    }
    
    // If no footer found, append at end
    return basePrompt + '\n\n' + enrichedContext;
  } catch (err) {
    // If tools DB isn't available yet, gracefully fall back
    console.warn('[promptTemplate] Could not fetch tools from DB:', err instanceof Error ? err.message : err);
    return basePrompt;
  }
}

export function generateTaskPrompt(task: Task, opts: PromptOptions = {}): string {
  const sections: string[] = [];

  // Interactive mode preamble — placed before everything else
  if (opts.interactive) {
    sections.push(`> **[INTERACTIVE MODE]** You are running in an interactive session. The orchestrator may send steering messages to you mid-task via \`clawboard steer\`. When you receive a steering message, acknowledge it and update your plan accordingly. Do not restart your work unless explicitly asked — continue from where you are.`);
    sections.push('');
  }

  // Title
  sections.push(`# ${task.title}`);

  // Description
  if (task.description) {
    sections.push(task.description);
  }

  // Operational Notes
  if (task.notes) {
    sections.push('## Operational Notes');
    sections.push(task.notes);
  }

  // Project
  if (task.project) {
    sections.push(`**Project:** ${task.project}`);
  }

  const executionHarness = (task as any).executionProfile?.harness;
  if (executionHarness) {
    sections.push(`**Harness:** ${executionHarness}`);
  }

  // Capability hints
  const capabilityHints = (task.tags || []).filter(tag =>
    ['browser', 'host-browser', 'elevated', 'network', 'discord-thread', 'long-running'].includes(tag)
  );
  if (capabilityHints.length > 0) {
    sections.push(`**Capability Hints:** ${capabilityHints.join(', ')}`);
    sections.push('If any required capability is unavailable in your runtime, stop and leave a clear review/blocking note instead of pretending to continue.');
  }

  // Model (default: sonnet for sub-agents)
  sections.push(`**Model:** ${task.model || 'sonnet'}`);


  // Tags
  if (task.tags && task.tags.length > 0) {
    sections.push(`**Tags:** ${task.tags.join(', ')}`);
  }

  // Subtasks
  if (task.subtasks && task.subtasks.length > 0) {
    sections.push('## Subtasks');
    for (const st of task.subtasks) {
      const check = st.completed ? 'x' : ' ';
      sections.push(`- [${check}] ${st.text}`);
    }
  }

  // Definition of Done / Constraints — the completion bar the agent must meet before review
  const renderCriteria = (v: any): string[] => {
    if (v === undefined || v === null || v === '') return [];
    let val: any = v;
    if (typeof v === 'string') {
      try { val = JSON.parse(v); } catch { /* plain string */ }
    }
    if (Array.isArray(val)) return val.filter(Boolean).map((x: any) => `- ${x}`);
    return [String(val)];
  };
  const dodLines = renderCriteria((task as any).definitionOfDone);
  if (dodLines.length > 0) {
    sections.push('## Definition of Done');
    sections.push('You MUST satisfy every item below before calling `review`. If you cannot, leave a blocking/review note explaining which items are unmet — do not fake completion.');
    sections.push(...dodLines);
    sections.push('');
  }
  const conLines = renderCriteria((task as any).constraints);
  if (conLines.length > 0) {
    sections.push('## Constraints (hard limits — do not violate)');
    sections.push(...conLines);
    sections.push('');
  }

  // Links
  if (task.links && task.links.length > 0) {
    sections.push('## Links');
    for (const link of task.links) {
      sections.push(`- [${link.title}](${link.url}) (${link.type})`);
    }
  }

  // Thinking level
  if (task.thinking) {
    const source = task.thinkingAutoEstimated
      ? '(auto-estimated based on task complexity)'
      : '(manually set)';
    sections.push(`**Thinking Level:** ${task.thinking} ${source}`);
  }

  // Attempt count
  if (task.attemptCount && task.attemptCount > 0) {
    const note = task.attemptCount > 1
      ? ' (previous attempt was rejected — pay extra attention to quality)'
      : '';
    sections.push(`**Attempt:** #${task.attemptCount}${note}`);
  }

  // Standard footer — Agent workflow instructions
  const shortId = task.id.substring(0, 8);
  sections.push(`
---
## Agent Workflow Instructions (auto-generated)

**Task ID:** ${shortId} (${task.id})
**CLI:** Prefer \`clawboard\` on \`$PATH\`. If it is not installed globally, fall back to the repo-local entrypoint.

### ⚠️ CRITICAL: Use the CLI, never raw API calls!

**Run these FIRST, before any other commands:**
\`\`\`bash
export CLAWBOARD_AGENT=1
if [ -n "$CLAWBOARD_CLI" ] && [ -f "$CLAWBOARD_CLI" ]; then
  CB="python3 $CLAWBOARD_CLI"
elif [ -f ./cli/clawboard ]; then
  CB="python3 ./cli/clawboard"
elif command -v clawboard >/dev/null 2>&1; then
  CB="clawboard"
elif [ -f /deployed-repo/cli/clawboard ]; then
  CB="python3 /deployed-repo/cli/clawboard"
elif [ -f /workspace/projects/clawboard-nim/repo/cli/clawboard ]; then
  CB="python3 /workspace/projects/clawboard-nim/repo/cli/clawboard"
elif [ -f /workspace/cli/clawboard ]; then
  CB="python3 /workspace/cli/clawboard"
else
  CB="python3 /home/clawd/clawd/projects/clawboard-nim/repo/cli/clawboard"
fi
\`\`\`
The CLAWBOARD_AGENT=1 flag enforces ClawBoard agent restrictions (prevents you from marking tasks completed).

### Mandatory Completion Sequence

Work through subtasks in order. For EACH subtask:

**Step 1 — Before starting a subtask:**
\`\`\`bash
$CB start-subtask ${shortId} <INDEX>
\`\`\`

**Step 2 — After finishing a subtask (marks it in-review 🟡, NOT completed):**
\`\`\`bash
$CB complete-subtask ${shortId} <INDEX>
\`\`\`

Repeat Steps 1–2 for every subtask, in order.

**Step 3 — When ALL subtasks are in-review, run exactly this:**
\`\`\`bash
$CB review ${shortId}
\`\`\`

**Step 4 — STOP. Do not continue working after calling review.**

Your session completion will automatically notify the orchestrator for review.

### ⛔ PROHIBITED ACTIONS

- **NEVER** mark subtasks as completed, skipped, or blocked — only the orchestrator can do that
- **NEVER** move the task to completed — only the orchestrator can do that
- **NEVER** skip the \`$CB review\` command when all subtasks are done
- **NEVER** continue working or making changes after calling \`$CB review\`
- **NEVER** call the API directly with curl — always use the CLI

### Escape Hatch (genuine blockers only)

If you are truly blocked and cannot proceed (missing credentials, unresolvable dependency, etc.):
\`\`\`bash
$CB move ${shortId} stuck
\`\`\`
Only use this if you cannot complete the task. For normal completion, always use \`$CB review\`.`);

  return sections.join('\n\n');
}
