import express from 'express';

jest.mock('../services/TaskManager', () => ({ taskManager: {} }));

import dashboardRoutes from '../routes/dashboard';
import { TaskManagerDB, taskManagerDB } from '../services/TaskManagerDB';
import { reportManager } from '../services/ReportManager';

describe('dashboard task summary', () => {
  test('uses lifecycle status for archived membership and maps database counts', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{
        ideas: 1,
        todo: 2,
        in_progress: 3,
        stuck: 4,
        completed: 5,
        archived: 860,
        recent_completed: 6,
        total: 875,
      }],
    });
    const manager = new TaskManagerDB({ query } as any);

    await expect(manager.getDashboardSummary()).resolves.toEqual({
      ideas: 1,
      todo: 2,
      inProgress: 3,
      stuck: 4,
      completed: 5,
      archived: 860,
      recentCompleted: 6,
      total: 875,
    });

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("COUNT(*) FILTER (WHERE status = 'archived')");
    expect(sql).not.toMatch(/archived_at\s+IS\s+NOT\s+NULL/i);
  });

  test('serves the response contract consumed by DashboardPage', async () => {
    const summary = {
      ideas: 1,
      todo: 2,
      inProgress: 3,
      stuck: 4,
      completed: 5,
      archived: 860,
      recentCompleted: 6,
      total: 875,
    };
    jest.spyOn(taskManagerDB, 'getDashboardSummary').mockResolvedValue(summary);
    jest.spyOn(reportManager, 'getCount').mockResolvedValue(7);

    const app = express();
    app.use('/dashboard', dashboardRoutes);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const response = await fetch(`http://127.0.0.1:${address.port}/dashboard/summary`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        success: true,
        summary: { ...summary, reportCount: 7 },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      jest.restoreAllMocks();
    }
  });
});
