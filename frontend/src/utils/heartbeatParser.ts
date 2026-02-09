import { authenticatedFetch } from './auth';
/**
 * Smart HEARTBEAT.md Parser
 * Now fetches structured data from Tasks API instead of parsing markdown
 */

export interface Project {
  name: string;
  status: string;
  phase: string;
  started?: string;
  completed?: string;
  deployed?: string;
  version?: string;
  gitBranch?: string;
  commitsAhead?: number;
  description?: string;
  progress: {
    current: number;
    total: number;
    percentage: number;
  };
  milestones: string[];
  nextSteps: string[];
  activeTasks: number;
  totalTasks: number;
}

export interface HeartbeatData {
  projects: Project[];
  quotaMonitoring?: {
    lastCheck?: string;
    providers: {
      name: string;
      usage: number;
      status: 'healthy' | 'warning' | 'critical';
    }[];
  };
  rawContent: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  project: string;
  tags: string[];
  created: string;
  updated: string;
  completed: string | null;
  startedAt?: string;
  subtasks?: Array<{ id: string; text: string; completed: boolean }>;
  blockedBy?: string[];
  notes?: string;
}

interface TasksResponse {
  success: boolean;
  tasks: Task[];
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Fetch tasks from API and group by project
 */
export async function fetchProjectsFromAPI(): Promise<Project[]> {
  try {
    const response = await authenticatedFetch(`${API_BASE_URL}/tasks`);
    const data: TasksResponse = await response.json();
    
    if (!data.success || !data.tasks) {
      console.error('Failed to fetch tasks:', data);
      return [];
    }
    
    // Group tasks by project
    const projectMap = new Map<string, Task[]>();
    
    for (const task of data.tasks) {
      const projectName = task.project || 'uncategorized';
      if (!projectMap.has(projectName)) {
        projectMap.set(projectName, []);
      }
      projectMap.get(projectName)!.push(task);
    }
    
    // Transform into Project objects
    const projects: Project[] = [];
    
    for (const [projectName, tasks] of projectMap.entries()) {
      // Skip projects with no active work (exclude only completed/archived)
      const activeTasks = tasks.filter(t => 
        t.status === 'in-progress' || t.status === 'todo' || t.status === 'ideas' || t.status === 'stuck'
      );
      
      if (activeTasks.length === 0) continue;
      
      // Calculate progress from subtasks
      let totalSubtasks = 0;
      let completedSubtasks = 0;
      
      for (const task of tasks) {
        if (task.subtasks && task.subtasks.length > 0) {
          totalSubtasks += task.subtasks.length;
          completedSubtasks += task.subtasks.filter(st => st.completed).length;
        }
      }
      
      // Determine overall status and phase
      const inProgressTasks = tasks.filter(t => t.status === 'in-progress');
      const todoTasks = tasks.filter(t => t.status === 'todo');
      const ideaTasks = tasks.filter(t => t.status === 'ideas');
      const stuckTasks = tasks.filter(t => t.status === 'stuck');
      const completedTasks = tasks.filter(t => t.status === 'completed');
      const totalTasks = tasks.length;
      
      let status = '🚧 In Progress';
      let phase = 'Active Development';
      
      if (inProgressTasks.length > 0) {
        status = '🚧 In Progress';
        phase = 'Active Development';
      } else if (stuckTasks.length > 0) {
        status = '⏸️ Blocked';
        phase = 'Waiting';
      } else if (todoTasks.length > 0) {
        status = '📋 Todo';
        phase = 'Ready to Start';
      } else if (ideaTasks.length > 0) {
        status = '💡 Planning';
        phase = 'Ideation';
      } else if (completedTasks.length === totalTasks) {
        status = '✅ Complete';
        phase = 'Completed';
      }
      
      // Get next steps from active tasks (prioritize in-progress, then todo, then ideas)
      const nextSteps = [
        ...inProgressTasks.slice(0, 3),
        ...todoTasks.slice(0, 3 - inProgressTasks.length),
        ...ideaTasks.slice(0, 3 - inProgressTasks.length - todoTasks.length)
      ].slice(0, 3).map(t => t.title);
      
      // Get milestones from completed tasks
      const milestones = completedTasks
        .slice(0, 5)
        .map(t => t.title);
      
      // Find earliest started date
      const startedDates = tasks
        .map(t => t.startedAt)
        .filter(d => d)
        .sort();
      const started = startedDates.length > 0 ? startedDates[0] : undefined;
      
      // Description from the first in-progress task
      const description = inProgressTasks.length > 0 
        ? inProgressTasks[0].description.substring(0, 200)
        : activeTasks[0]?.description.substring(0, 200) || '';
      
      projects.push({
        name: projectName,
        status,
        phase,
        started,
        description,
        progress: {
          current: completedSubtasks,
          total: totalSubtasks,
          percentage: totalSubtasks > 0 
            ? Math.round((completedSubtasks / totalSubtasks) * 100)
            : 0
        },
        milestones,
        nextSteps,
        activeTasks: activeTasks.length,
        totalTasks: tasks.length
      });
    }
    
    // Sort by number of in-progress tasks (most active first)
    projects.sort((a, b) => b.activeTasks - a.activeTasks);
    
    return projects;
  } catch (error) {
    console.error('Error fetching projects from API:', error);
    return [];
  }
}

/**
 * Parse HEARTBEAT.md content into structured data
 * Now falls back to API data if markdown parsing fails
 */
export function parseHeartbeat(content: string): HeartbeatData {
  const projects: Project[] = [];
  
  // Try parsing markdown first (legacy support)
  const projectsMatch = content.match(/## Active Projects\n\n([\s\S]*?)(?=\n##|$)/);
  
  if (projectsMatch) {
    const projectsSection = projectsMatch[1];
    const projectBlocks = projectsSection.split(/(?=^###\s)/m);
    
    for (const block of projectBlocks) {
      if (!block.trim() || !block.startsWith('###')) continue;
      
      const project = parseProject(block);
      if (project) {
        projects.push(project);
      }
    }
  }
  
  // Note: Widget should call fetchProjectsFromAPI() directly for live data
  // This is just for backward compatibility
  
  return {
    projects,
    rawContent: content
  };
}

/**
 * Parse a single project block (legacy markdown parser)
 */
function parseProject(block: string): Project | null {
  const lines = block.split('\n');
  
  // Extract project name from header
  const nameMatch = lines[0].match(/###\s+(.+?)(?:\s+\(Started:|$)/);
  if (!nameMatch) return null;
  
  const name = nameMatch[1].trim();
  
  // Initialize project data
  const project: Project = {
    name,
    status: 'unknown',
    phase: 'unknown',
    progress: {
      current: 0,
      total: 0,
      percentage: 0
    },
    milestones: [],
    nextSteps: [],
    activeTasks: 0,
    totalTasks: 0
  };
  
  // Extract key information
  for (const line of lines) {
    // Status
    if (line.includes('**Status:**')) {
      const statusMatch = line.match(/\*\*Status:\*\*\s+(.+)/);
      if (statusMatch) {
        project.status = statusMatch[1].trim();
      }
    }
    
    // Current Phase
    if (line.includes('**Current Phase:**')) {
      const phaseMatch = line.match(/\*\*Current Phase:\*\*\s+(.+)/);
      if (phaseMatch) {
        project.phase = phaseMatch[1].trim();
      }
    }
    
    // Started date
    if (line.includes('**Started:**')) {
      const startMatch = line.match(/\*\*Started:\*\*\s+(.+)/);
      if (startMatch) {
        project.started = startMatch[1].trim();
      }
    }
    
    // Completed date
    if (line.includes('**Completed:**')) {
      const completeMatch = line.match(/\*\*Completed:\*\*\s+(.+)/);
      if (completeMatch) {
        project.completed = completeMatch[1].trim();
      }
    }
    
    // Deployed date
    if (line.includes('**Deployed:**')) {
      const deployMatch = line.match(/\*\*Deployed:\*\*\s+(.+)/);
      if (deployMatch) {
        project.deployed = deployMatch[1].trim();
      }
    }
    
    // Version
    if (line.includes('**Version:**')) {
      const versionMatch = line.match(/\*\*Version:\*\*\s+(.+)/);
      if (versionMatch) {
        project.version = versionMatch[1].trim();
      }
    }
    
    // Git branch and commits
    if (line.includes('**Git:**')) {
      const gitMatch = line.match(/`(\w+)` branch.*\(([a-f0-9]+)\).*?(\d+) commits? ahead/);
      if (gitMatch) {
        project.gitBranch = gitMatch[1];
        project.commitsAhead = parseInt(gitMatch[3], 10);
      }
    }
    
    // Milestones (checkboxes)
    if (line.match(/^-\s+[✅✓]/)) {
      const milestone = line.replace(/^-\s+[✅✓]\s+/, '').trim();
      if (milestone && !milestone.startsWith('**')) {
        project.milestones.push(milestone);
      }
    }
    
    // Next Steps
    if (line.match(/^\d+\.\s+/)) {
      const step = line.replace(/^\d+\.\s+/, '').trim();
      if (step) {
        project.nextSteps.push(step);
      }
    }
  }
  
  // Calculate progress from milestones
  const totalMilestones = (block.match(/^-\s+/gm) || []).length;
  const completedMilestones = (block.match(/^-\s+[✅✓]/gm) || []).length;
  
  if (totalMilestones > 0) {
    project.progress = {
      current: completedMilestones,
      total: totalMilestones,
      percentage: Math.round((completedMilestones / totalMilestones) * 100)
    };
  }
  
  // Extract description from the block
  const descMatch = block.match(/\*\*Status:\*\*[^\n]*\n([^*]+)/);
  if (descMatch) {
    project.description = descMatch[1].trim().substring(0, 200);
  }
  
  return project;
}

/**
 * Get a human-friendly status emoji
 */
export function getStatusEmoji(status: string): string {
  const lower = status.toLowerCase();
  
  if (lower.includes('complete') || lower.includes('deployed') || lower.includes('✅')) {
    return '✅';
  }
  if (lower.includes('in progress') || lower.includes('working') || lower.includes('🚧')) {
    return '🚧';
  }
  if (lower.includes('planning') || lower.includes('design')) {
    return '📋';
  }
  if (lower.includes('testing') || lower.includes('review')) {
    return '🧪';
  }
  if (lower.includes('blocked') || lower.includes('paused')) {
    return '⏸️';
  }
  
  return '📊';
}

/**
 * Get relative time string (e.g., "2 hours ago")
 */
export function getRelativeTime(dateString: string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  } catch {
    return dateString;
  }
}
