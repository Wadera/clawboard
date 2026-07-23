// AgentTypeService.ts — CRUD + sync for agent persona types
import { pool } from '../db/connection';
import * as fs from 'fs';
import * as path from 'path';

/** Provenance of a persona row: git-managed (round-trips through the
 *  agency-agents repo sync) vs a legacy row that only lives in the DB. */
export type AgentTypeSource = 'git' | 'legacy-db';

export interface AgentType {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  content: string | null;
  source_file: string | null;
  is_custom: boolean;
  source: AgentTypeSource;
  retired_at: string | null;
  retired_reason: string | null;
  retired_in_favor_of: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTypeSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  is_custom: boolean;
  source: AgentTypeSource;
  retired_at: string | null;
}

/** Parse frontmatter + content from a markdown persona file */
function parseAgentFile(filePath: string): { name: string; description: string; color: string; content: string } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const fmText = fmMatch[1];

    const nameMatch = fmText.match(/^name:\s*(.+)$/m);
    const descMatch = fmText.match(/^description:\s*(.+)$/m);
    const colorMatch = fmText.match(/^color:\s*(.+)$/m);

    const name = nameMatch ? nameMatch[1].trim() : path.basename(filePath, '.md');
    const description = descMatch ? descMatch[1].trim() : '';
    const color = colorMatch ? colorMatch[1].trim() : 'gray';

    return { name, description, color, content: raw };
  } catch {
    return null;
  }
}

/** Convert a filename like "engineering-backend-architect.md" to slug "engineering-backend-architect" */
function fileToSlug(_category: string, filename: string): string {
  return filename.replace(/\.md$/, '');
}

const AGENCY_AGENTS_PATH = process.env.AGENCY_AGENTS_REPO || '/tmp/agency-agents-local';

export class AgentTypeService {
  /** Sync agent types from the local agency-agents clone */
  async syncFromRepo(repoPath: string = AGENCY_AGENTS_PATH): Promise<{ synced: number; errors: number }> {
    if (!fs.existsSync(repoPath)) {
      console.log('[AgentTypeService] Agent repo path not found, skipping sync:', repoPath);
      return { synced: 0, errors: 0 };
    }

    const categories = fs.readdirSync(repoPath).filter(d => {
      const full = path.join(repoPath, d);
      return fs.statSync(full).isDirectory() &&
        !d.startsWith('.') &&
        !['examples', 'playbooks', 'runbooks', 'strategy', 'coordination', 'scripts', 'design'].includes(d);
    });

    let synced = 0;
    let errors = 0;

    for (const category of categories) {
      const catPath = path.join(repoPath, category);
      let files: string[];
      try {
        files = fs.readdirSync(catPath).filter(f => f.endsWith('.md') && !f.startsWith('README'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(catPath, file);
        const parsed = parseAgentFile(filePath);
        if (!parsed) { errors++; continue; }

        const slug = fileToSlug(category, file);
        const relPath = `${category}/${file}`;

        try {
          // A slug present in the repo manifest IS a git-managed persona, so
          // stamp source='git' on both insert and update — this is the live,
          // authoritative provenance backfill.
          const result = await pool.query(`
            INSERT INTO agent_types (slug, name, description, category, color, content, source_file, is_custom, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'git')
            ON CONFLICT (slug) DO UPDATE SET
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              category = EXCLUDED.category,
              color = EXCLUDED.color,
              content = EXCLUDED.content,
              source_file = EXCLUDED.source_file,
              source = 'git',
              updated_at = now()
            WHERE agent_types.retired_at IS NULL
            RETURNING slug
          `, [slug, parsed.name, parsed.description, category, parsed.color, parsed.content, relPath]);
          // A retired slug remains a tombstone even while its source file still
          // exists. The guarded upsert returns no row for that conflict, so it is
          // intentionally excluded from the successful sync count.
          if ((result.rowCount ?? result.rows.length) > 0) synced++;
        } catch (err) {
          console.error('[AgentTypeService] Error syncing', slug, err);
          errors++;
        }
      }
    }

    console.log(`[AgentTypeService] Synced ${synced} agent types (${errors} errors)`);
    return { synced, errors };
  }

  /**
   * List agent personas. Retired (soft-deleted duplicate) rows are EXCLUDED by
   * default so consumers — including `clawboard doctor` — see one live row per
   * name/slug. Pass includeRetired to surface them (e.g. an admin registry view).
   */
  async list(category?: string, includeRetired = false): Promise<AgentTypeSummary[]> {
    let query = `SELECT id, slug, name, description, category, color, is_custom, source, retired_at FROM agent_types`;
    const params: any[] = [];
    const where: string[] = [];
    if (!includeRetired) {
      where.push(`retired_at IS NULL`);
    }
    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (where.length) {
      query += ` WHERE ` + where.join(' AND ');
    }
    query += ` ORDER BY category, name`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  async getById(id: string): Promise<AgentType | null> {
    const result = await pool.query('SELECT * FROM agent_types WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async getBySlug(slug: string): Promise<AgentType | null> {
    const result = await pool.query('SELECT * FROM agent_types WHERE slug = $1', [slug]);
    return result.rows[0] || null;
  }

  /** Get sessions that used this agent type */
  async getLinkedSessions(agentTypeId: string): Promise<any[]> {
    const result = await pool.query(`
      SELECT session_key, kind, label, model, started_at, ended_at, total_cost_usd, message_count
      FROM sessions
      WHERE agent_type_id = $1
      ORDER BY started_at DESC
      LIMIT 50
    `, [agentTypeId]);
    return result.rows;
  }

  /** Get tasks that used this agent type */
  async getLinkedTasks(agentTypeId: string): Promise<any[]> {
    const result = await pool.query(`
      SELECT t.id, t.title, t.status, t.priority, p.name as project, t.created_at, t.completed_at
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.agent_type_id = $1
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [agentTypeId]);
    return result.rows;
  }

  async categories(): Promise<string[]> {
    const result = await pool.query(
      `SELECT DISTINCT category FROM agent_types WHERE category IS NOT NULL AND retired_at IS NULL ORDER BY category`
    );
    return result.rows.map(r => r.category);
  }

  /**
   * Safely retire a duplicate persona: repoint every task and session that
   * references the loser to the canonical winner (across ALL statuses,
   * including archived), then soft-delete the loser via retired_at. The row is
   * preserved — never hard-deleted — so historical detail/provenance survives.
   *
   * Matched by slug (IDs vary per environment). Idempotent: a no-op if the
   * loser is absent or already retired, or if the winner is absent.
   *
   * @returns null if nothing was done, otherwise the repoint counts.
   */
  async retireDuplicate(
    loserSlug: string,
    winnerSlug: string,
    reason?: string,
  ): Promise<{ tasksRepointed: number; sessionsRepointed: number; loserId: string; winnerId: string } | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const loser = await client.query('SELECT id, retired_at FROM agent_types WHERE slug = $1', [loserSlug]);
      const winner = await client.query('SELECT id FROM agent_types WHERE slug = $1', [winnerSlug]);
      if (loser.rowCount === 0 || winner.rowCount === 0 || loser.rows[0].retired_at !== null) {
        await client.query('ROLLBACK');
        return null;
      }

      const loserId: string = loser.rows[0].id;
      const winnerId: string = winner.rows[0].id;

      const t = await client.query('UPDATE tasks SET agent_type_id = $1 WHERE agent_type_id = $2', [winnerId, loserId]);
      const s = await client.query('UPDATE sessions SET agent_type_id = $1 WHERE agent_type_id = $2', [winnerId, loserId]);

      await client.query(
        `UPDATE agent_types
           SET retired_at = now(),
               retired_reason = $2,
               retired_in_favor_of = $3,
               updated_at = now()
         WHERE id = $1`,
        [loserId, reason || `duplicate persona name; retired in favor of ${winnerSlug}`, winnerId],
      );

      await client.query('COMMIT');
      return {
        tasksRepointed: t.rowCount ?? 0,
        sessionsRepointed: s.rowCount ?? 0,
        loserId,
        winnerId,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const agentTypeService = new AgentTypeService();
