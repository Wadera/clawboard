// promptTemplate.ts - Generate agent prompts from task data
import { Task } from '../services/TaskManager';
import { toolManager } from '../services/ToolManager';
import { projectService } from '../services/ProjectService';
import { taskManagerDB } from '../services/TaskManagerDB';

/**
 * Generate agent prompt with optional DB-backed tool context.
 * Async version that fetches effective tools for the task's project.
 */
export async function generateTaskPromptWithTools(task: Task): Promise<string> {
  const basePrompt = generateTaskPrompt(task);
  
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

export function generateTaskPrompt(task: Task): string {
  const sections: string[] = [];

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

  // Model
  if (task.model) {
    sections.push(`**Model:** ${task.model}`);
  }

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
**CLI:** \`python3 /home/clawd/clawd/projects/clawboard-nim/repo/cli/clawboard\`

### ⚠️ CRITICAL: Use the CLI, never raw API calls!

**Before starting each subtask:**
\`\`\`bash
export CLAWBOARD_AGENT=1
CB="python3 /home/clawd/clawd/projects/clawboard-nim/repo/cli/clawboard"
$CB start-subtask ${shortId} <INDEX>
\`\`\`

**When you finish working on a subtask (ready for review):**
\`\`\`bash
$CB complete-subtask ${shortId} <INDEX>
\`\`\`
This marks the subtask as **in-review** (🟡), NOT completed.

**When ALL subtasks are in-review, move the task to review:**
\`\`\`bash
$CB review ${shortId}
\`\`\`

### Rules for Agents
- You can ONLY set subtasks to: **in-progress** or **in-review**
- You can ONLY move the task to: **review** or **stuck**
- You CANNOT mark subtasks as completed, skipped, or blocked
- You CANNOT move the task to completed — only the orchestrator can
- The orchestrator will review your work, approve or reject each subtask
- If you get stuck, move the task to stuck: \`$CB move ${shortId} stuck\`
- Always use the CLI — never call the API directly with curl`);

  return sections.join('\n\n');
}
