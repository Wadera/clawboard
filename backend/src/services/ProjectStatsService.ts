// ProjectStatsService.ts - Calculate project statistics from JSON task files
import { taskManager } from './TaskManager';
import { projectService } from './ProjectService';

export interface ProjectStats {
  total_tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  active_agents: number;
  last_activity: string | null;
}

export class ProjectStatsService {
  getStatsByName(projectName: string): ProjectStats {
    const tasks = taskManager.queryTasks({ project: projectName });
    
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const inProgress = tasks.filter(t => t.status === 'in-progress').length;
    const activeAgents = new Set(
      tasks.filter(t => t.activeAgent).map(t => t.activeAgent!.name)
    ).size;
    
    let lastActivity: string | null = null;
    for (const t of tasks) {
      const ts = t.completedAt || t.startedAt || t.lastChecked || t.created;
      if (ts && (!lastActivity || ts > lastActivity)) {
        lastActivity = ts;
      }
    }
    
    return {
      total_tasks: total,
      completed_tasks: completed,
      in_progress_tasks: inProgress,
      active_agents: activeAgents,
      last_activity: lastActivity,
    };
  }

  async getAllStats(): Promise<Map<string, ProjectStats>> {
    const projects = await projectService.list();
    const statsMap = new Map<string, ProjectStats>();
    
    for (const project of projects) {
      statsMap.set(project.id, this.getStatsByName(project.name));
    }
    
    return statsMap;
  }

  getRecentActivity(projectName: string, days: number = 7): {
    tasks_created: number;
    tasks_updated: number;
    tasks_completed: number;
  } {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    
    const tasks = taskManager.queryTasks({ project: projectName });
    
    return {
      tasks_created: tasks.filter(t => t.created && t.created >= cutoffStr).length,
      tasks_updated: tasks.filter(t => t.lastChecked && t.lastChecked >= cutoffStr).length,
      tasks_completed: tasks.filter(t => t.status === 'completed' && t.completedAt && t.completedAt >= cutoffStr).length,
    };
  }

  getTaskDistribution(): Array<{ project_name: string; task_count: number }> {
    const allTasks = taskManager.getAllTasks();
    const dist: Record<string, number> = {};
    for (const t of allTasks) {
      const name = t.project || '(unassigned)';
      dist[name] = (dist[name] || 0) + 1;
    }
    return Object.entries(dist)
      .map(([project_name, task_count]) => ({ project_name, task_count }))
      .sort((a, b) => b.task_count - a.task_count);
  }
}

export const projectStatsService = new ProjectStatsService();
