// dashboard.ts - API endpoints for the redesigned dashboard
import { Router, Request, Response } from 'express';
import { taskManager } from '../services/TaskManager';
import { taskHistoryService } from '../services/TaskHistoryService';

const router = Router();

/**
 * GET /dashboard/summary
 * Returns aggregated stats for dashboard cards
 */
router.get('/summary', (_req: Request, res: Response): void => {
  try {
    const allTasks = taskManager.getAllTasks();

    let ideas = 0;
    let todo = 0;
    let inProgress = 0;
    let stuck = 0;
    let recentCompleted = 0;
    let archived = 0;

    for (const task of allTasks) {
      switch (task.status) {
        case 'ideas':
          ideas++;
          break;
        case 'todo':
          todo++;
          break;
        case 'in-progress':
          inProgress++;
          break;
        case 'stuck':
          stuck++;
          break;
        case 'completed':
          recentCompleted++;
          break;
        case 'archived':
          archived++;
          break;
      }
    }

    // completed = completed + archived combined (real total of done work)
    const completed = recentCompleted + archived;

    res.json({
      ideas,
      todo,
      inProgress,
      stuck,
      completed,
      recentCompleted,
      total: allTasks.length,
    });
  } catch (err) {
    console.error('[Dashboard API] Error getting summary:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /dashboard/active
 * Returns all in-progress tasks with subtask breakdown
 */
router.get('/active', (_req: Request, res: Response): void => {
  try {
    const inProgressTasks = taskManager.queryTasks({ status: 'in-progress' });

    // Sort by updatedAt desc
    inProgressTasks.sort((a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime()
    );

    const tasks = inProgressTasks.map(task => {
      const summary = taskManager.getSubtaskSummary(task.id);
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        project: task.project || null,
        subtasks: task.subtasks || [],
        subtaskProgress: {
          total: summary.total,
          completed: summary.completed,
          inReview: summary.in_review,
          new: summary.new,
        },
        updatedAt: task.updated,
      };
    });

    res.json({ tasks });
  } catch (err) {
    console.error('[Dashboard API] Error getting active tasks:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /dashboard/activity?limit=10
 * Returns recent task changes from task_history table
 */
router.get('/activity', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 100);
    const events = await taskHistoryService.getRecentActivity(limit);
    res.json({ events });
  } catch (err) {
    console.error('[Dashboard API] Error getting activity:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
