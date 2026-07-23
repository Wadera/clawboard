import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const page = fs.readFileSync(path.join(__dirname, '../pages/JournalPage.tsx'), 'utf8');

describe('Journal status avatars', () => {
  test('loads current and history avatars as authenticated blobs scoped by status id', () => {
    expect(page).toContain('function StatusAvatarImage');
    expect(page).toContain('/nim-status/${encodeURIComponent(status.id)}/avatar');
    expect(page).toContain('URL.createObjectURL');
    expect(page).toContain('URL.revokeObjectURL');
    expect(page).not.toContain('resolveAvatarUrl');
    expect(page).not.toContain('src={resolvedAvatarUrl}');
    expect(page).not.toContain('src={itemAvatarUrl}');
  });
});
