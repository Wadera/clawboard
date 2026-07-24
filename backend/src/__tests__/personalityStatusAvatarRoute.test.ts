import fs from 'fs';
import path from 'path';

describe('personality status avatar privacy routes', () => {
  const route = fs.readFileSync(path.join(__dirname, '../routes/botStatus.ts'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');

  test('serves status avatars only through an authenticated id-scoped route', () => {
    expect(route).toContain("router.get('/:id/avatar'");
    expect(route).toContain('SELECT avatar_url FROM bot_status WHERE id=$1');
    expect(route).toContain("'private, no-store'");
    expect(route).toContain('res.sendFile');
    expect(server).toContain("app.use('/nim-status', authMiddleware, botStatusRoutes)");
  });

  test('allows only the generated Hermes status subtree and blocks its public static URL', () => {
    expect(route).toContain("const STATUS_AVATAR_PUBLIC_PREFIX = '/media/generated/hermes-status/'");
    expect(route).toContain('path.resolve(STATUS_AVATAR_ROOT, fileName)');
    expect(route).toContain('resolved.startsWith(`${STATUS_AVATAR_ROOT}${path.sep}`)');
    expect(route).not.toContain('provider_url');
    expect(server).toContain("app.use('/media/generated/hermes-status'");
    expect(server.indexOf("app.use('/media/generated/hermes-status'")).toBeLessThan(server.indexOf("app.use('/media/generated', express.static"));
  });
});
