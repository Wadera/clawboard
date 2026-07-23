// dashboard.ts - API endpoints for the redesigned dashboard
import { Router, Request, Response } from 'express';
import { taskManager } from '../services/TaskManager';
import { taskManagerDB } from '../services/TaskManagerDB';
import { taskHistoryService } from '../services/TaskHistoryService';
import { reportManager } from '../services/ReportManager';

const router = Router();

/**
 * GET /dashboard/summary
 * Returns aggregated stats for dashboard cards
 */
router.get('/summary', async (_req: Request, res: Response): Promise<void> => {
  try {
    const summary = await taskManagerDB.getDashboardSummary();

    // Get report count (gracefully handle if table doesn't exist yet)
    let reportCount = 0;
    try {
      reportCount = await reportManager.getCount();
    } catch {
      // Table may not exist yet — that's fine
    }

    res.json({ success: true, summary: { ...summary, reportCount } });
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
          skipped: summary.skipped,
          review: summary.review,
          inProgress: summary.in_progress,
          blocked: summary.blocked,
          empty: summary.empty,
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
