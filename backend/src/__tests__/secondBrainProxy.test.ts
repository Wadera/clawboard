import {
  sanitizeSecondBrainJson,
  secondBrainBrokerHealthHandler,
  secondBrainLinkgraphHandler,
  secondBrainStatusHandler,
} from '../routes/secondBrain';

function responseMock() {
  const response: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    send(body: unknown) { this.body = body; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return response;
}

const request = () => ({ method: 'GET' } as any);

describe('Second Brain stats proxy', () => {
  const previousUrl = process.env.KF_BROKER_URL;
  const previousCred = process.env.KF_DASHBOARD_CREDENTIAL;

  beforeEach(() => {
    process.env.KF_BROKER_URL = 'http://kf-broker.test:8940';
    process.env.KF_DASHBOARD_CREDENTIAL = 'test-dashboard-credential';
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (previousUrl === undefined) delete process.env.KF_BROKER_URL;
    else process.env.KF_BROKER_URL = previousUrl;
    if (previousCred === undefined) delete process.env.KF_DASHBOARD_CREDENTIAL;
    else process.env.KF_DASHBOARD_CREDENTIAL = previousCred;
  });

  test('injects the broker credential server-side for /status', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      '{"notes":{"total":966},"provenance":"kf-broker v0.5"}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = responseMock();

    await secondBrainStatusHandler(request(), res);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://kf-broker.test:8940/v0/stats',
      expect.objectContaining({ headers: { 'X-KF-Credential': 'test-dashboard-credential' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ notes: { total: 966 }, provenance: 'kf-broker v0.5' });
  });

  test('linkgraph handler targets the linkgraph endpoint', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      '{"nodes":[],"edges":[],"stats":{"node_count":0}}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = responseMock();

    await secondBrainLinkgraphHandler(request(), res);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://kf-broker.test:8940/v0/stats/linkgraph',
      expect.anything(),
    );
    expect(res.statusCode).toBe(200);
  });

  test('broker-health needs no credential and works without one configured', async () => {
    delete process.env.KF_DASHBOARD_CREDENTIAL;
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      '{"ok":true,"vault":true,"credentials":10}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = responseMock();

    await secondBrainBrokerHealthHandler(request(), res);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://kf-broker.test:8940/health',
      expect.objectContaining({ headers: {} }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, vault: true, credentials: 10 });
  });

  test('returns 503 when the credential is missing for credentialed paths', async () => {
    delete process.env.KF_DASHBOARD_CREDENTIAL;
    const res = responseMock();

    await secondBrainStatusHandler(request(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Second Brain stats are not configured' });
  });

  test('returns 503 when the broker is down', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = responseMock();

    await secondBrainStatusHandler(request(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Second Brain broker unavailable' });
  });

  test('returns 502 on non-JSON upstream body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    const res = responseMock();

    await secondBrainStatusHandler(request(), res);

    expect(res.statusCode).toBe(502);
  });

  test('sanitizer strips credential-shaped fields recursively', () => {
    expect(sanitizeSecondBrainJson({
      ok: true,
      credential: 'leak',
      nested: [{ token: 'leak', keep: 'knowledge/shared/note.md' }],
    })).toEqual({ ok: true, nested: [{ keep: 'knowledge/shared/note.md' }] });
  });
});
