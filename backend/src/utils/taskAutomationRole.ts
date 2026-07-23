export type TaskAutomationRole = 'agent' | 'qa' | 'reviewer' | 'orchestrator';

/**
 * Resolve privileged task lifecycle authority from the authenticated identity.
 * Client-controlled role headers are deliberately not an authority source.
 */
export function resolveTaskAutomationRole(authenticatedUserId: unknown): TaskAutomationRole {
  const userId = String(authenticatedUserId || '').trim().toLowerCase();
  if (userId === 'dashboard_user') return 'orchestrator';
  if (userId === 'clawbeat_reviewer' || userId === 'hermes_qa_reviewer') return 'reviewer';
  if (userId === 'clawbeat_qa' || userId === 'hermes_qa') return 'qa';
  return 'agent';
}