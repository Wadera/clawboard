describe('reports reader credential scope', () => {
  beforeEach(() => { jest.resetModules(); process.env.JWT_SECRET = 'test-secret'; process.env.CLAWBOARD_REPORTS_READ_API_KEY = 'reports-read-secret'; });
  async function invoke(path: string, method: string, baseUrl = '', key = 'reports-read-secret') {
    const { authMiddleware } = await import('../middleware/auth'); const req: any = { baseUrl, path, method, headers: { 'x-reports-read-key': key } }; let status = 200; let next = false;
    const res: any = { status: (s: number) => { status = s; return res; }, json: () => res }; authMiddleware(req, res, () => { next = true; }); return { status, next, userId: req.userId };
  }
  const RID = '11111111-1111-4111-8111-111111111111';
  it('accepts GET on reports list and item', async () => {
    expect(await invoke('/', 'GET', '/reports')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
    expect(await invoke(`/${RID}`, 'GET', '/reports')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
  });
  it('accepts GET on journal list, latest, item and navigation', async () => {
    expect(await invoke('/', 'GET', '/journal')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
    expect(await invoke('/latest', 'GET', '/journal')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
    expect(await invoke(`/${RID}`, 'GET', '/journal')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
    expect(await invoke(`/${RID}/navigation`, 'GET', '/journal')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
  });
  it('rejects non-GET methods with the key', async () => {
    expect(await invoke('/', 'POST', '/reports')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'PATCH', '/reports')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'DELETE', '/reports')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'PUT', '/journal')).toMatchObject({ status: 403, next: false });
  });
  it('rejects out-of-scope paths with the key', async () => {
    expect(await invoke('/', 'GET', '/tasks')).toMatchObject({ status: 403, next: false });
    expect(await invoke('/hermes-runs/abc', 'GET', '/journal')).toMatchObject({ status: 403, next: false });
    expect(await invoke('/', 'GET', '/webhooks')).toMatchObject({ status: 403, next: false });
  });
  it('rejects a wrong key value on a scoped path', async () => {
    expect(await invoke('/', 'GET', '/reports', 'wrong-key')).toMatchObject({ status: 403, next: false });
  });
});
