-- Migration 015: Support multiple journal entries per day
-- Adds sequence column and changes unique constraint from date to (date, sequence)

-- Add sequence column (default 1 for existing entries)
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS sequence INTEGER NOT NULL DEFAULT 1;

-- Drop old unique constraint on date
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_date_key;

-- Add new unique constraint on (date, sequence)
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_date_sequence_key UNIQUE (date, sequence);

-- Update index to include sequence
DROP INDEX IF EXISTS idx_journal_entries_date;
CREATE INDEX IF NOT EXISTS idx_journal_entries_date_seq ON journal_entries(date DESC, sequence DESC);
