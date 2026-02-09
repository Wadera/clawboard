// promptTemplate.ts - Generate agent prompts from task data
import { Task } from '../services/TaskManager';
import { toolManager } from '../services/ToolManager';
import { projectService } from '../services/ProjectService';

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

    const effectiveTools = await toolManager.getEffectiveToolsForProject(project.id);
    if (!effectiveTools || effectiveTools.length === 0) return basePrompt;

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

    // Insert tool context before the standard footer
    const footerMarker = '---\n## Standard Instructions (auto-generated)';
    const idx = basePrompt.indexOf(footerMarker);
    if (idx >= 0) {
      return basePrompt.slice(0, idx) + toolSections.join('\n') + '\n\n' + basePrompt.slice(idx);
    }
    
    // If no footer found, append at end
    return basePrompt + '\n\n' + toolSections.join('\n');
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

  // Standard footer
  sections.push(`
---
## Standard Instructions (auto-generated)

**Task ID:** ${task.id}
**API:** http://localhost:8082/api
**Project:** /workspace/projects/clawboard/
**Branch:** dev

**As you complete each subtask**, update via API:
\`\`\`bash
curl -s -X PATCH http://localhost:8082/api/tasks/${task.id} \\
  -H 'Content-Type: application/json' \\
  -d '{updated subtasks array with completed: true}'
\`\`\`

**When ALL subtasks are done**, mark task completed:
\`\`\`bash
curl -s -X PATCH http://localhost:8082/api/tasks/${task.id} \\
  -H 'Content-Type: application/json' \\
  -d '{"status": "completed", "completedAt": "..."}'
\`\`\`

**Rules:**
- NO Tailwind — plain CSS with variables from frontend/src/styles/variables.css
- TypeScript strict mode — no unused variables
- Git commit changes to dev branch and push to origin/dev
- Use React Portal for any modals
- Test by rebuilding: sudo docker compose -f docker-compose.dev.yml -p clawboard-dev up -d --build`);

  return sections.join('\n\n');
}
