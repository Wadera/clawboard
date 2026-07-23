import { checkBody } from '../middleware/validate';
import { WebhookService } from '../services/WebhookService';
import { buildOpenApiSpec } from '../openapi/spec';

describe('validate middleware — checkBody', () => {
  const schema = {
    title: { type: 'string' as const, required: true, maxLen: 10 },
    priority: { type: 'string' as const, enum: ['low', 'normal', 'high'] as const },
    tags: { type: 'array' as const, itemsType: 'string' as const },
    active: { type: 'boolean' as const },
  };

  it('accepts a valid body', () => {
    expect(checkBody({ title: 'ok', priority: 'low', tags: ['a'], active: true }, schema)).toEqual([]);
  });

  it('reports missing required, wrong types, enum and length violations', () => {
    const errors = checkBody({ priority: 'urgent', tags: ['a', 7], active: 'yes', title: 'way too long title' }, schema);
    const fields = errors.map(e => e.field).sort();
    expect(fields).toEqual(['active', 'priority', 'tags', 'title']);
  });

  it('rejects non-object bodies and unknown fields', () => {
    expect(checkBody('nope', schema)[0].field).toBe('(body)');
    expect(checkBody({ title: 'x', bogus: 1 }, schema).some(e => e.field === 'bogus')).toBe(true);
    expect(checkBody({ title: 'x', bogus: 1 }, schema, { allowUnknown: true }).length).toBe(0);
  });
});

describe('WebhookService signatures and payloads', () => {
  const svc = new WebhookService({ query: jest.fn() } as never);

  it('builds a stable HMAC-SHA256 signature', () => {
    const body = svc.buildPayload('task.updated', { id: 'x' });
    const sig = svc.buildSignature('topsecret', body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(svc.buildSignature('topsecret', body)).toBe(sig);
    expect(svc.buildSignature('other', body)).not.toBe(sig);
  });

  it('payload carries event, data and timestamp', () => {
    const parsed = JSON.parse(svc.buildPayload('task.created', { id: 'abc' }));
    expect(parsed.event).toBe('task.created');
    expect(parsed.data.id).toBe('abc');
    expect(typeof parsed.timestamp).toBe('string');
  });
});

describe('openapi spec', () => {
  it('is valid JSON with the core paths', () => {
    const spec = buildOpenApiSpec() as { paths: Record<string, unknown>; openapi: string };
    expect(spec.openapi).toBe('3.0.3');
    for (const p of ['/tasks', '/tasks/{id}', '/tasks/batch', '/sessions', '/webhooks', '/openapi.json']) {
      expect(spec.paths[p]).toBeDefined();
    }
    expect(() => JSON.stringify(spec)).not.toThrow();
  });
});
