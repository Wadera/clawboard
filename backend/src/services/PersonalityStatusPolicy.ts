import crypto from 'crypto';

export const STATUS_TIME_ZONE = 'Europe/London';
export const MAX_STATUSES_PER_DAY = 3;
export const MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const NEAR_DUPLICATE_THRESHOLD = 0.72;
export type StatusTrigger = 'meaningful_goal_completed' | 'manual';

export interface PersonalityStatusInput {
  mood: string;
  status_text: string;
  author: 'Hermes';
  author_harness: 'hermes';
  trigger: StatusTrigger;
  event_id: string;
  event_completed_at: string;
  avatar_url?: string | null;
  avatar_attempted?: boolean;
  avatar_failure?: 'image_generate_failed' | 'delivery_failed' | null;
}

export interface ExistingStatus {
  status_text: string;
  updated_at: string;
}

const AUDIT_PATTERNS: RegExp[] = [
  /\b(task|ticket|session)\s*(id|#|[0-9a-f]{8})/i,
  /\b(in[- ]progress|blocked|stuck|awaiting review|queue|health check|uptime)\b/i,
  /\b(completed|active|blocked|failed)\s*:/i,
  /(^|\n)\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+/m,
  /\b\d+\s+tasks?\b/i,
  /\b(audit|digest|watchdog|smoke test|deploy status)\b/i,
];

export function normalizeStatusText(value: string): string {
  return value.toLocaleLowerCase('en-GB').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function lexicalSet(value: string, width: number): Set<string> {
  const normalized = width === 1 ? normalizeStatusText(value) : `  ${normalizeStatusText(value)}  `;
  if (width === 1) return new Set(normalized.split(' ').filter(Boolean));
  const parts = new Set<string>();
  for (let index = 0; index <= normalized.length - width; index += 1) parts.add(normalized.slice(index, index + width));
  return parts;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  left.forEach(value => { if (right.has(value)) intersection += 1; });
  return intersection / (left.size + right.size - intersection);
}

/** Deterministic lexical score robust to punctuation, casing, and small word edits. */
export function lexicalSimilarity(left: string, right: string): number {
  return Math.max(jaccard(lexicalSet(left, 1), lexicalSet(right, 1)), jaccard(lexicalSet(left, 3), lexicalSet(right, 3)));
}

export function validateEditorialContract(body: any): string | null {
  if (!body || typeof body !== 'object') return 'request body is required';
  if (body.author !== 'Hermes' || body.author_harness !== 'hermes') return 'author and author_harness must identify Hermes';
  if (!['meaningful_goal_completed', 'manual'].includes(body.trigger)) return 'trigger must be meaningful_goal_completed or manual';
  if (typeof body.event_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{2,199}$/.test(body.event_id)) return 'event_id must be a stable non-secret identifier';
  if (typeof body.event_completed_at !== 'string' || Number.isNaN(Date.parse(body.event_completed_at))) return 'event_completed_at must be an ISO timestamp';
  if (body.trigger === 'meaningful_goal_completed' && !/^task:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.event_id)) return 'meaningful_goal_completed event_id must be task:<UUID>';
  if (typeof body.mood !== 'string' || !body.mood.trim() || body.mood.length > 100) return 'mood must be 1-100 characters';
  if (typeof body.status_text !== 'string' || body.status_text.trim().length < 20 || body.status_text.length > 500) return 'status_text must be 20-500 characters';
  if (!/\b(I|I'm|I’m|my|me)\b/i.test(body.status_text)) return 'status_text must be a first-person personality comment';
  if (AUDIT_PATTERNS.some((pattern) => pattern.test(body.status_text))) return 'status_text contains a prohibited audit-log pattern';
  if (body.avatar_url !== undefined && body.avatar_url !== null && (typeof body.avatar_url !== 'string' || !/^\/media\/generated\/hermes-status\/[0-9a-f]{24}\.png$/.test(body.avatar_url))) return 'avatar_url must be a delivered Hermes status URL or null';
  if (body.trigger === 'meaningful_goal_completed') {
    if (body.avatar_attempted !== true) return 'meaningful statuses require one recorded remote avatar attempt';
    if (body.avatar_url && body.avatar_failure) return 'successful avatar delivery cannot include avatar_failure';
    if (!body.avatar_url && !['image_generate_failed', 'delivery_failed'].includes(body.avatar_failure)) return 'failed avatar attempts require a bounded avatar_failure code';
  }
  return null;
}

export function londonDayBounds(now: Date): { start: Date; end: Date; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: STATUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  // Find UTC instants corresponding to London local midnight without relying on process TZ.
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offsetAt = (instant: number) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: STATUS_TIME_ZONE, timeZoneName: 'longOffset' }).formatToParts(new Date(instant));
    const label = p.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
    const match = label.match(/GMT([+-])(\d{2}):(\d{2})/);
    return match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000 : 0;
  };
  const start = new Date(guess - offsetAt(guess));
  const nextGuess = guess + 26 * 60 * 60 * 1000;
  const nextParts = new Intl.DateTimeFormat('en-CA', { timeZone: STATUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nextGuess));
  const nextDay = `${nextParts.find(p => p.type === 'year')!.value}-${nextParts.find(p => p.type === 'month')!.value}-${nextParts.find(p => p.type === 'day')!.value}`;
  const nextMidnightGuess = Date.parse(`${nextDay}T00:00:00Z`);
  return { start, end: new Date(nextMidnightGuess - offsetAt(nextMidnightGuess)), day };
}

export function eventFingerprint(input: PersonalityStatusInput): string {
  return crypto.createHash('sha256').update(JSON.stringify({ author_harness: input.author_harness, trigger: input.trigger, event_id: input.event_id })).digest('hex');
}

export function cadenceDecision(input: PersonalityStatusInput, existing: ExistingStatus[], now: Date): string | null {
  const { start, end } = londonDayBounds(now);
  const today = existing.filter(row => { const t = new Date(row.updated_at); return t >= start && t < end; });
  if (today.length >= MAX_STATUSES_PER_DAY) return 'daily_cap';
  const newest = existing.map(row => new Date(row.updated_at).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (input.trigger !== 'manual' && newest !== undefined && now.getTime() - newest < MIN_INTERVAL_MS) return 'four_hour_cadence';
  const normalized = normalizeStatusText(input.status_text);
  if (existing.some(row => lexicalSimilarity(row.status_text, normalized) >= NEAR_DUPLICATE_THRESHOLD)) return 'near_duplicate_text';
  return null;
}
