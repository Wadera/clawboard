import { Router, Request, Response } from 'express';
import { taskManagerDB as taskManager } from '../services/TaskManagerDB';
import { sendApiError } from '../utils/apiErrors';
import { validateBody, UUID_RE } from '../middleware/validate';

/**
 * Batch task updates: PATCH /tasks/batch (task 3c7da35b).
 * Mounted BEFORE the main tasks router so /batch wins over /:id.
 * Applies the same per-task update path (lifecycle gates included);
 * returns per-id results — partial success is expected behavior.
 */

const router = Router();

const ALLOWED_FIELDS = ['status', 'priority', 'project', 'autoStart', 'tags', 'notes', 'blockedReason'] as const;

const batchSchema = {
  ids: { type: 'array' as const, required: true, itemsType: 'string' as const },
  updates: { type: 'object' as const, required: true },
};

router.patch('/batch', validateBody(batchSchema), async (req: Request, res: Response) => {
  const { ids, updates } = req.body as { ids: string[]; updates: Record<string, unknown> };

  if (ids.length === 0 || ids.length > 100) {
    sendApiError(res, 400, 'BATCH_SIZE', 'ids must contain between 1 and 100 task ids'); return;
  }
  const badIds = ids.filter(id => !UUID_RE.test(id));
  if (badIds.length) {
    sendApiError(res, 400, 'INVALID_TASK_ID', `Not UUIDs: ${badIds.slice(0, 5).join(', ')}${badIds.length > 5 ? '…' : ''}`,
      'Batch requires full task UUIDs (the CLI resolves short prefixes client-side).');
    return;
  }
  const unknownFields = Object.keys(updates).filter(k => !(ALLOWED_FIELDS as readonly string[]).includes(k));
  if (unknownFields.length) {
    sendApiError(res, 400, 'UNSUPPORTED_BATCH_FIELD', `Not batch-updatable: ${unknownFields.join(', ')}`,
      `Batch supports: ${ALLOWED_FIELDS.join(', ')}. Use PATCH /tasks/:id for anything else.`);
    return;
  }
  if (Object.keys(updates).length === 0) {
    sendApiError(res, 400, 'EMPTY_UPDATES', 'updates must set at least one field'); return;
  }

  const results: Array<{ id: string; success: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      const updated = await taskManager.updateTask(id, updates as never);
      results.push(updated ? { id, success: true } : { id, success: false, error: 'TASK_NOT_FOUND' });
    } catch (err) {
      results.push({ id, success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const succeeded = results.filter(r => r.success).length;
  res.status(succeeded ? 200 : 422).json({ success: succeeded > 0, total: ids.length, succeeded, results });
});

export default router;
