// JournalService.ts - CRUD for bot daily journal entries
import { pool } from '../db/connection';

export interface JournalEntry {
  id: string;
  date: string;
  sequence: number;
  mood: string | null;
  reflection_text: string;
  image_path: string | null;
  highlights: string[] | null;
  created_at: string;
}

export interface CreateJournalEntryInput {
  date: string;
  sequence?: number; // Auto-calculated if not provided
  mood?: string;
  reflection_text: string;
  image_path?: string;
  highlights?: string[];
}

export class JournalService {
  /**
   * List journal entries, paginated, newest first
   */
  async list(limit = 20, offset = 0): Promise<{ entries: JournalEntry[]; total: number }> {
    const countResult = await pool.query('SELECT COUNT(*) FROM journal_entries');
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await pool.query(
      'SELECT * FROM journal_entries ORDER BY date DESC, sequence DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    return { entries: result.rows, total };
  }

  /**
   * Get a single journal entry by ID
   */
  async getById(id: string): Promise<JournalEntry> {
    const result = await pool.query('SELECT * FROM journal_entries WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      throw new Error(`Journal entry not found: ${id}`);
    }
    return result.rows[0];
  }

  /**
   * Get the most recent journal entry
   */
  async getLatest(): Promise<JournalEntry | null> {
    const result = await pool.query(
      'SELECT * FROM journal_entries ORDER BY date DESC, sequence DESC LIMIT 1'
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new journal entry
   */
  async create(input: CreateJournalEntryInput): Promise<JournalEntry> {
    const { date, mood, reflection_text, image_path, highlights } = input;

    // Auto-calculate sequence if not provided
    let sequence = input.sequence;
    if (!sequence) {
      const maxSeqResult = await pool.query(
        'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM journal_entries WHERE date = $1',
        [date]
      );
      sequence = maxSeqResult.rows[0].max_seq + 1;
    }

    const result = await pool.query(
      `INSERT INTO journal_entries (date, sequence, mood, reflection_text, image_path, highlights)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [date, sequence, mood || null, reflection_text, image_path || null, highlights || null]
    );

    return result.rows[0];
  }

  /**
   * Update an existing journal entry
   */
  async update(id: string, input: Partial<CreateJournalEntryInput>): Promise<JournalEntry> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.date !== undefined) {
      fields.push(`date = $${paramIndex++}`);
      values.push(input.date);
    }
    if (input.mood !== undefined) {
      fields.push(`mood = $${paramIndex++}`);
      values.push(input.mood);
    }
    if (input.reflection_text !== undefined) {
      fields.push(`reflection_text = $${paramIndex++}`);
      values.push(input.reflection_text);
    }
    if (input.image_path !== undefined) {
      fields.push(`image_path = $${paramIndex++}`);
      values.push(input.image_path);
    }
    if (input.highlights !== undefined) {
      fields.push(`highlights = $${paramIndex++}`);
      values.push(input.highlights);
    }

    if (fields.length === 0) {
      return this.getById(id);
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE journal_entries SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error(`Journal entry not found: ${id}`);
    }

    return result.rows[0];
  }

  /**
   * Delete a journal entry
   */
  async delete(id: string): Promise<void> {
    const result = await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      throw new Error(`Journal entry not found: ${id}`);
    }
  }

  /**
   * Get navigation info for an entry (previous/next IDs)
   */
  async getNavigation(id: string): Promise<{ previousId: string | null; nextId: string | null }> {
    // First, get the entry to know its date and sequence
    const entry = await this.getById(id);

    // Get previous entry (earlier in timeline)
    const prevResult = await pool.query(
      `SELECT id FROM journal_entries
       WHERE (date = $1 AND sequence < $2) OR (date < $1)
       ORDER BY date DESC, sequence DESC
       LIMIT 1`,
      [entry.date, entry.sequence]
    );

    // Get next entry (later in timeline)
    const nextResult = await pool.query(
      `SELECT id FROM journal_entries
       WHERE (date = $1 AND sequence > $2) OR (date > $1)
       ORDER BY date ASC, sequence ASC
       LIMIT 1`,
      [entry.date, entry.sequence]
    );

    return {
      previousId: prevResult.rows[0]?.id || null,
      nextId: nextResult.rows[0]?.id || null,
    };
  }
}

export const journalService = new JournalService();
