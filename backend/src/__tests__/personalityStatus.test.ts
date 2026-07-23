import {
  cadenceDecision, eventFingerprint, lexicalSimilarity, londonDayBounds, PersonalityStatusInput,
  validateEditorialContract,
} from '../services/PersonalityStatusPolicy';

const input: PersonalityStatusInput = {
  mood: 'Quietly delighted',
  status_text: 'I finally made this little timeline sound like a person again, and I’m quietly delighted by the breathing room.',
  author: 'Hermes', author_harness: 'hermes', trigger: 'meaningful_goal_completed',
  event_id: 'task:516c4974-1234-4abc-8def-1234567890ab', event_completed_at: '2026-07-12T10:00:00Z',
  avatar_url: null, avatar_attempted: true, avatar_failure: 'image_generate_failed',
};
const row = (when: string, text = 'I enjoyed finishing a different meaningful piece of work today.') => ({ updated_at: when, status_text: text });

describe('Hermes personality status policy', () => {
  test('accepts personality prose and rejects audit/list/status patterns and wrong authorship', () => {
    expect(validateEditorialContract(input)).toBeNull();
    expect(validateEditorialContract({ ...input, author: 'Nim' })).toMatch(/identify Hermes/);
    expect(validateEditorialContract({ ...input, status_text: 'I checked everything.\n- task abcdef12\n- health check healthy' })).toMatch(/audit-log/);
    expect(validateEditorialContract({ ...input, status_text: 'Completed: J12. Active: J13. I am happy.' })).toMatch(/audit-log/);
  });

  test('same event has a stable fingerprint and prose does not change it', () => {
    expect(eventFingerprint(input)).toHaveLength(64);
    expect(eventFingerprint(input)).toBe(eventFingerprint({ ...input, status_text: 'I chose different words for the same moment.' }));
  });

  test('requires task UUID receipts for meaningful triggers but keeps manual explicit', () => {
    expect(validateEditorialContract({ ...input, event_id: 'goal:caller-asserted' })).toMatch(/task:<UUID>/);
    expect(validateEditorialContract({ ...input, trigger: 'manual', event_id: 'manual:wadera-request' })).toBeNull();
  });

  test('requires exactly one recorded remote avatar outcome for meaningful statuses', () => {
    expect(validateEditorialContract({ ...input, avatar_attempted: false })).toMatch(/avatar attempt/);
    expect(validateEditorialContract({ ...input, avatar_failure: null })).toMatch(/avatar_failure/);
    expect(validateEditorialContract({ ...input, avatar_url: '/media/generated/hermes-status/0123456789abcdef01234567.png', avatar_failure: null })).toBeNull();
    expect(validateEditorialContract({ ...input, avatar_url: '/media/generated/hermes-status/0123456789abcdef01234567.png', avatar_failure: 'delivery_failed' })).toMatch(/cannot include/);
  });

  test('suppresses lexical near-duplicates, not merely exact normalized text', () => {
    const near = 'I finally made the little timeline sound like a real person again, and I am quietly delighted by all that breathing room.';
    const different = 'I untangled the photo review and feel relieved that choosing the next route will be pleasant.';
    expect(lexicalSimilarity(input.status_text, near)).toBeGreaterThanOrEqual(0.72);
    expect(lexicalSimilarity(input.status_text, different)).toBeLessThan(0.72);
    expect(cadenceDecision({ ...input, trigger: 'manual', status_text: near }, [row('2026-07-11T18:00:00Z', input.status_text)], new Date('2026-07-12T12:00:00Z'))).toBe('near_duplicate_text');
  });

  test('enforces four hours, permits explicit manual bypass, and suppresses duplicate prose', () => {
    const now = new Date('2026-07-12T12:00:00Z');
    expect(cadenceDecision(input, [row('2026-07-12T09:00:01Z')], now)).toBe('four_hour_cadence');
    expect(cadenceDecision({ ...input, trigger: 'manual' }, [row('2026-07-12T09:00:01Z')], now)).toBeNull();
    expect(cadenceDecision({ ...input, trigger: 'manual' }, [row('2026-07-11T18:00:00Z', input.status_text.toUpperCase())], now)).toBe('near_duplicate_text');
  });

  test('caps at three Europe/London statuses, including across BST UTC boundary', () => {
    const now = new Date('2026-07-12T22:30:00Z'); // 23:30 London
    const bounds = londonDayBounds(now);
    expect(bounds.start.toISOString()).toBe('2026-07-11T23:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-07-12T23:00:00.000Z');
    expect(cadenceDecision({ ...input, trigger: 'manual' }, [
      row('2026-07-12T00:00:00Z'), row('2026-07-12T08:00:00Z'), row('2026-07-12T20:00:00Z'),
    ], now)).toBe('daily_cap');
  });
});
