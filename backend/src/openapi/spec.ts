/**
 * OpenAPI 3.0 spec for ClawBoard's core API surface (task 3c7da35b).
 * Hand-maintained next to the code it describes; served at GET /openapi.json.
 * Coverage: the endpoints agents and integrations actually use. Anything not
 * listed here is internal/unstable — check the route source before relying on it.
 */

const errorEnvelope = {
  type: 'object',
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    suggestion: { type: 'string' },
    details: {},
  },
  required: ['success', 'code', 'message'],
};

const taskSummary = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['ideas', 'todo', 'in-progress', 'stuck', 'review', 'completed', 'archived'] },
    priority: { type: 'string' },
    project: { type: 'string', nullable: true },
    autoStart: { type: 'boolean' },
    discordThreadId: { type: 'string', nullable: true },
    discordThreadUrl: { type: 'string', nullable: true },
  },
};

function crudPath(summaryGet: string, summaryMutate?: string) {
  const p: Record<string, unknown> = {
    get: { summary: summaryGet, responses: { '200': { description: 'OK' } } },
  };
  if (summaryMutate) {
    p.post = { summary: summaryMutate, responses: { '201': { description: 'Created' }, '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } } } };
  }
  return p;
}

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'ClawBoard API',
      version: '2.0.0',
      description: 'Core ClawBoard surface. Auth: Bearer JWT on every route. '
        + 'Nginx strips the public /api prefix (public https://nimspace.skyday.eu/api/tasks → backend /tasks). '
        + 'Error envelope: {success:false, code, message, suggestion?, details?}.',
    },
    servers: [{ url: 'https://nimspace.skyday.eu/api' }, { url: 'https://nimspace.skyday.eu/api/dev', description: 'dev stack' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { ApiError: errorEnvelope, TaskSummary: taskSummary },
    },
    security: [{ bearer: [] }],
    paths: {
      '/health': { get: { summary: 'Liveness (no auth)', security: [], responses: { '200': { description: 'OK' } } } },
      '/tasks': {
        get: { summary: 'List tasks (filters: status, project, limit)', parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create task (requires agent-type; autoStart defaults false)', responses: { '201': { description: 'Created' }, '400': { description: 'Validation failed' } } },
      },
      '/tasks/{id}': {
        get: { summary: 'Get task (full UUID; includes discordThreadUrl)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_TASK_ID (8-char prefixes are CLI-only)' }, '404': { description: 'Not found' } } },
        patch: { summary: 'Update task (lifecycle gates apply: status transitions, autoStart preserved)', responses: { '200': { description: 'OK' } } },
        delete: { summary: 'Delete task', responses: { '200': { description: 'OK' } } },
      },
      '/tasks/batch': {
        patch: { summary: 'Batch update up to 100 tasks (fields: status, priority, project, autoStart, tags, notes, blockedReason); per-id results, partial success = 200', responses: { '200': { description: 'At least one succeeded' }, '422': { description: 'All failed' } } },
      },
      '/tasks/next': { get: { summary: 'Next auto-start todo task', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/spawn-agent': { post: { summary: 'Spawn harness agent for task (default harness/model from user_preferences)', responses: { '200': { description: 'Spawned (provisional session possible)' } } } },
      '/tasks/{id}/steer': { post: { summary: 'Steer the linked live session', responses: { '200': { description: 'OK' }, '409': { description: 'Session starting up' } } } },
      '/tasks/{id}/subtasks/{index}/status': { patch: { summary: 'Set subtask status (index-addressed; 0-based; statuses: empty|in_progress|review|completed|blocked|skipped)', parameters: [{ name: 'index', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}/approve': { post: { summary: 'Approve subtask -> completed (orchestrator step of the 6-state lifecycle)', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}/reject': { post: { summary: 'Reject subtask -> empty with note', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}/skip': { post: { summary: 'Skip subtask (counts as done)', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}/block': { post: { summary: 'Block subtask with reason', responses: { '200': { description: 'OK' } } } },
      '/tasks/{id}/subtasks/{index}': { put: { summary: 'Replace subtask text/status (legacy)', responses: { '200': { description: 'OK' } } } },
      '/projects': crudPath('List projects', 'Create project'),
      '/agent-types': crudPath('List agent personas'),
      '/sessions': { get: { summary: 'List sessions (hermes rows readonly-live; 15-min staleness window)', responses: { '200': { description: 'OK' } } } },
      '/sessions/{key}': { get: { summary: 'Session detail + linked task (incl. discordThreadUrl)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/reports': {
        get: { summary: 'List reports (q= full-text search; NOTE list items include full content — filter client-side or prefer limit)', parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search (the parameter is q — search= is ignored)' },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create report (pinning is human/on-demand only)', responses: { '201': { description: 'Created' } } },
      },
      '/reports/{id}': {
        get: { summary: 'Get report (full UUID; 8-char prefixes are CLI-only)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_REPORT_ID' }, '404': { description: 'Not found' } } },
        patch: { summary: 'Update report', responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_REPORT_ID' } } },
        delete: { summary: 'Delete report', responses: { '200': { description: 'OK' }, '400': { description: 'INVALID_REPORT_ID' } } },
      },
      '/models/status': { get: { summary: 'Model availability (LiteLLM + config + floor)', responses: { '200': { description: 'OK' } } } },
      '/models/available': { get: { summary: 'Resolved model catalog', responses: { '200': { description: 'OK' } } } },
      '/litellm/models': {
        get: { summary: 'List LiteLLM DB-backed model deployments (secrets stripped)', responses: { '200': { description: 'OK' }, '502': { description: 'LiteLLM unavailable or inconsistent' }, '503': { description: 'Admin adapter not configured' } } },
        post: { summary: 'Create a LiteLLM model deployment using an environment credential reference (operator mutation gate required)', responses: { '201': { description: 'Created' }, '400': { description: 'Invalid or raw-secret input rejected' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/models/{id}': {
        delete: { summary: 'Delete a LiteLLM model deployment (operator mutation gate required)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/keys': {
        get: { summary: 'List LiteLLM virtual keys with credential fields stripped', responses: { '200': { description: 'OK' } } },
        post: { summary: 'Generate an agent/project-scoped virtual key with model and spend limits (operator mutation gate required)', responses: { '201': { description: 'Generated; key material is returned once' }, '400': { description: 'Invalid scope, budget, duration, or caller-supplied secret' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/keys/{id}': {
        delete: { summary: 'Delete a LiteLLM virtual key by token id/hash (operator mutation gate required)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '409': { description: 'Mutations disabled' } } },
      },
      '/litellm/spend': {
        get: { summary: 'Aggregated LiteLLM spend by safe key identifier, user, and model (defaults to the last 30 UTC days)', parameters: [
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
        ], responses: { '200': { description: 'Aggregated spend summary' }, '400': { description: 'Invalid date range' } } },
      },
      '/litellm/health': {
        get: { summary: 'Check configured LiteLLM model deployments and return credential-safe endpoint health', responses: { '200': { description: 'Model health summary' }, '502': { description: 'LiteLLM unavailable or returned an invalid response' } } },
      },
      '/webhooks': {
        get: { summary: 'List webhooks (secrets masked)', responses: { '200': { description: 'OK' } } },
        post: { summary: 'Register webhook (events: task.created|task.updated|task.deleted|task.archived; HMAC-SHA256 X-ClawBoard-Signature when secret set)', responses: { '201': { description: 'Created' } } },
      },
      '/webhooks/{id}': {
        patch: { summary: 'Update webhook', responses: { '200': { description: 'OK' } } },
        delete: { summary: 'Remove webhook', responses: { '200': { description: 'OK' } } },
      },
      '/openapi.json': { get: { summary: 'This document', responses: { '200': { description: 'OK' } } } },
    },
  };
}
