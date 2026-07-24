import jwt from 'jsonwebtoken';

describe('Content Engine scoped media cookie', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = 'test-media-cookie-secret';
  });

  async function invoke(path: string, method = 'GET', baseUrl = '/content-engine', cookie = '') {
    const { authMiddleware } = await import('../middleware/auth');
    const req: any = { baseUrl, path, method, headers: cookie ? { cookie } : {} };
    let status = 200;
    let next = false;
    const res: any = { status: (value: number) => { status = value; return res; }, json: () => res };
    authMiddleware(req, res, () => { next = true; });
    return { status, next, userId: req.userId };
  }

  test('accepts the cookie only for GET artifact routes', async () => {
    const token = jwt.sign({ userId: 'dashboard_user' }, 'test-media-cookie-secret', { expiresIn: '1h' });
    const cookie = `nim_content_engine_media=${encodeURIComponent(token)}`;
    expect(await invoke('/v1/daily-reports/report-1/artifacts/audio-1', 'GET', '/content-engine', cookie))
      .toMatchObject({ status: 200, next: true, userId: 'dashboard_user' });
    expect(await invoke('/v1/daily-reports/', 'GET', '/content-engine', cookie))
      .toMatchObject({ status: 401, next: false });
    expect(await invoke('/v1/daily-reports/report-1/artifacts/audio-1', 'POST', '/content-engine', cookie))
      .toMatchObject({ status: 401, next: false });
    expect(await invoke('/reports/report-1', 'GET', '/reports', cookie))
      .toMatchObject({ status: 401, next: false });
  });

  test('rejects invalid media cookies', async () => {
    expect(await invoke(
      '/v1/daily-reports/report-1/artifacts/audio-1',
      'GET',
      '/content-engine',
      'nim_content_engine_media=invalid',
    )).toMatchObject({ status: 401, next: false });
  });
});
