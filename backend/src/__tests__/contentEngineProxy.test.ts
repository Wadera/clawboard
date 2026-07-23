import { proxyContentEngineRequest } from '../routes/contentEngine';

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

const request = (url: string, method = 'GET', headers: Record<string, string> = {}) => ({ url, method, headers } as any);

describe('Content Engine authenticated report proxy', () => {
  const previousToken = process.env.CONTENT_ENGINE_REPORT_API_TOKEN;
  const previousUrl = process.env.CONTENT_ENGINE_REPORT_API_URL;

  beforeEach(() => {
    process.env.CONTENT_ENGINE_REPORT_API_TOKEN = 'private-upstream-token';
    process.env.CONTENT_ENGINE_REPORT_API_URL = 'http://content-engine-report-api:8765';
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.CONTENT_ENGINE_REPORT_API_TOKEN;
    else process.env.CONTENT_ENGINE_REPORT_API_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.CONTENT_ENGINE_REPORT_API_URL;
    else process.env.CONTENT_ENGINE_REPORT_API_URL = previousUrl;
  });

  test('injects the private token server-side and forwards safe response headers', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    }));
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/?limit=30'), res);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://content-engine-report-api:8765/v1/daily-reports/?limit=30',
      expect.objectContaining({ headers: { Authorization: 'Bearer private-upstream-token' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  test('streams authenticated artifact bytes without exposing the upstream token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'x-content-type-options': 'nosniff' },
    }));
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/report-1/artifacts/local-audio'), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('private-upstream-token');
  });

  test('serves byte ranges for resumable mobile background playback', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), {
      status: 200,
      headers: { 'content-type': 'audio/ogg' },
    }));
    const res = responseMock();
    await proxyContentEngineRequest(request(
      '/v1/daily-reports/report-1/artifacts/local-audio',
      'GET',
      { range: 'bytes=2-4' },
    ), res);
    expect(res.statusCode).toBe(206);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-range']).toBe('bytes 2-4/6');
    expect(res.headers['content-length']).toBe('3');
    expect([...res.body]).toEqual([2, 3, 4]);
  });

  test('rejects unsatisfiable artifact ranges without returning private bytes', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(new Uint8Array([0, 1, 2]), {
      status: 200,
      headers: { 'content-type': 'audio/ogg' },
    }));
    const res = responseMock();
    await proxyContentEngineRequest(request(
      '/v1/daily-reports/report-1/artifacts/local-audio',
      'GET',
      { range: 'bytes=99-100' },
    ), res);
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */3');
    expect(res.body.length).toBe(0);
  });

  test.each([
    { data: [{ relative_path: 'runs/private/audio.opus', title: 'safe title' }] },
    { data: [{ provider_url: 'https://provider.invalid/private', title: 'safe title' }] },
  ])('redacts private JSON fields while preserving safe report data', async unsafe => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(unsafe), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/'), res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body.data[0]).toEqual({ title: 'safe title' });
    expect(JSON.stringify(body)).not.toContain('relative_path');
    expect(JSON.stringify(body)).not.toContain('provider_url');
  });

  test.each([
    { data: [{ title: 'unsafe', detail: '/home/clawd/private/report.json' }] },
    { data: [{ download_url: 'http://content-engine-report-api:8765/private' }] },
    { data: [{ canonical_url: 'https://example.com/story?access_token=secret' }] },
  ])('fails closed when JSON contains a private locator value', async unsafe => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(unsafe), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/'), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Content Engine report service returned an unsafe response' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(JSON.stringify(res.body)).not.toContain('/home/');
  });

  test('allows privacy-safe relative download routes and provider labels', async () => {
    const safe = { data: [{ provider: 'qwen-serena', download_url: '/v1/daily-reports/report-1/artifacts/audio-1' }] };
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(safe), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/'), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual(safe);
  });

  test('fails closed when the upstream token is absent', async () => {
    delete process.env.CONTENT_ENGINE_REPORT_API_TOKEN;
    const fetchMock = jest.spyOn(global, 'fetch');
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/'), res);

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['/../../etc/passwd', 'GET', 400],
    ['/v1/daily-reports/', 'POST', 405],
    ['/v1/other-service', 'GET', 400],
  ])('rejects unsafe or unsupported request %s', async (url, method, status) => {
    const res = responseMock();
    await proxyContentEngineRequest(request(url, method), res);
    expect(res.statusCode).toBe(status);
  });

  test('returns a truthful 503 when the private service is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect refused'));
    const res = responseMock();

    await proxyContentEngineRequest(request('/v1/daily-reports/'), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Content Engine report service unavailable' });
  });
});
