import fs from 'fs';
import path from 'path';

const route = fs.readFileSync(path.join(__dirname, '../routes/botStatus.ts'), 'utf8');

describe('personality status response privacy', () => {
  test('dashboard responses use the public narrative projection on current, history, create and replay', () => {
    expect(route).toContain("const publicProjection = 'id, mood, status_text, avatar_url, updated_at, author, author_harness'");
    expect((route.match(/\$\{publicProjection\}/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  test('public projection excludes provenance and control metadata', () => {
    const projection = route.match(/const publicProjection = ([^;]+);/)?.[1] || '';
    for (const field of ['source_receipts', 'idempotency_key', 'scheduler_tick_id', 'cadence_window_start', 'cadence_window_end', 'run_type', 'failure']) {
      expect(projection).not.toContain(field);
    }
  });
});
