import fs from 'fs';
import path from 'path';

describe('Journal public media root', () => {
  test('server honors the mounted media root in every environment', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');
    expect(server).toContain("process.env.CLAWD_MEDIA_ROOT ||");
    expect(server).toContain("app.use('/clawd-media', express.static(clawdMediaPath");
  });

  test.each(['docker-compose.dev.yml', 'docker-compose.prod.yml'])('%s pins the public media mount root', file => {
    const compose = fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
    expect(compose).toContain('CLAWD_MEDIA_ROOT: /clawd-media');
  });
});
