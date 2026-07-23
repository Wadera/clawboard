import { Response } from 'express';

/**
 * Standard API error envelope (task 3c7da35b).
 * Keeps the legacy top-level `error` + `code` fields for backward
 * compatibility and adds `message` + `suggestion` for humans and agents.
 */
export interface ApiErrorBody {
  success: false;
  error: string;      // legacy: short error string (same as message)
  code: string;       // machine-readable, SCREAMING_SNAKE
  message: string;    // human-readable description
  suggestion?: string; // what the caller should do about it
  details?: unknown;  // e.g. field-level validation errors
}

export function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  suggestion?: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = { success: false, error: message, code, message };
  if (suggestion) body.suggestion = suggestion;
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

/** Express error-handling middleware — normalizes uncaught route errors. */
export function apiErrorHandler(
  err: unknown,
  _req: import('express').Request,
  res: Response,
  next: import('express').NextFunction,
): void {
  if (res.headersSent) { next(err); return; }
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api] unhandled route error:', message);
  sendApiError(
    res, 500, 'INTERNAL_ERROR',
    'Unexpected server error',
    'Retry once; if it persists check backend logs (docker logs clawboard-backend).',
  );
}
