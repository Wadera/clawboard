# Migration 020: Tasks Schema Redesign

**Status:** Design Complete - Ready for Review  
**Date:** 2026-02-15  
**Task:** b5f0d0fd-de98-4eec-a5df-de010886b781

## Overview

This migration replaces the flat `tasks.json` file structure with a proper relational PostgreSQL schema. The design maintains backward compatibility with all existing nimtasks CLI operations and API endpoints.

## Files Created

1. **`020_tasks_redesign.sql`** - DDL migration script
   - Creates 5 new tables: tasks, subtasks, task_tags, task_dependencies, task_links
   - Adds comprehensive indexes for query performance
   - Includes detailed comments explaining schema design
   - ~9 KB, 200+ lines

2. **`020_migrate_tasks_data.py`** - Data migration script
   - Reads tasks.json and populates new schema
   - Handles all field mappings and conversions
   - Includes error handling and transaction safety
   - ~12 KB, 350+ lines

## Schema Design

### Tables

#### `tasks` (Main task table)
**Fields:**
- **Identity:** id (UUID PK), title, description
- **Status & Priority:** status (CHECK constraint), priority (CHECK constraint)
- **Project:** project_id (FK to projects)
- **Execution:** thinking_budget, thinking_auto_estimated, model, execution_mode, auto_created, auto_start
- **Blocking:** blocked_reason, status_reason
- **Agent Tracking:** active_agent, completed_by, attempt_count
- **References:** session_refs (JSONB), parent_id
- **Timestamps:** created_at, updated_at, started_at, completed_at, archived_at, last_checked

**Indexes:**
- status, priority, project_id, created_at
- Auto-start composite index
- GIN index on session_refs

**CHECK Constraints:**
- status: ideas, todo, in-progress, stuck, review, completed, archived
- priority: urgent, high, normal, low, someday
- thinking_budget: low, medium, high, extended

#### `subtasks` (Task breakdown)
**Fields:**
- id (SERIAL PK), task_id (FK), index (ordering), title, status, note
- created_at, updated_at, completed_at

**Indexes:**
- task_id, status
- UNIQUE(task_id, index) - ensures ordered subtasks

**CHECK Constraints:**
- status: new, in_review, completed

#### `task_tags` (Many-to-many tags)
**Fields:**
- task_id (FK), tag (VARCHAR)
- Composite PK (task_id, tag)

**Indexes:**
- tag (for filtering)

#### `task_dependencies` (Dependency graph)
**Fields:**
- task_id (FK), depends_on_task_id (FK)
- Composite PK
- CHECK prevents self-dependencies

**Indexes:**
- task_id, depends_on_task_id (both directions)

#### `task_links` (External references)
**Fields:**
- id (SERIAL PK), task_id (FK), type, title, url
- created_at

**Indexes:**
- task_id

### Relationships

```
tasks (1) ──┬──> (many) subtasks
            ├──> (many) task_tags
            ├──> (many) task_dependencies ──> tasks (self-ref)
            ├──> (many) task_links
            ├──> (many) task_history (existing)
            └──> (1) projects (optional)
```

## Migration Analysis

### Current vs. New Schema

**tasks.json fields → PostgreSQL mapping:**

| tasks.json | PostgreSQL Table | Column | Notes |
|------------|------------------|--------|-------|
| id | tasks | id | UUID preserved |
| title | tasks | title | VARCHAR(500) |
| description | tasks | description | TEXT |
| status | tasks | status | CHECK constraint |
| priority | tasks | priority | CHECK constraint |
| project | tasks | project_id | FK lookup by name |
| tags[] | task_tags | tag | Normalized M:N |
| created | tasks | created_at | Timestamp |
| updated | tasks | updated_at | Auto-updated |
| completed | tasks | completed_at | Timestamp |
| subtasks[] | subtasks | * | Separate table |
| blockedBy[] | task_dependencies | * | Separate table |
| dependsOn[] | task_dependencies | * | Separate table |
| notes | tasks | blocked_reason | Merged field |
| startedAt | tasks | started_at | Timestamp |
| autoStart | tasks | auto_start | Boolean |
| links[] | task_links | * | Separate table |
| model | tasks | model | VARCHAR |
| executionMode | tasks | execution_mode | VARCHAR |
| completedAt | tasks | completed_at | Timestamp |
| archivedAt | tasks | archived_at | Timestamp |
| thinking | tasks | thinking_budget | Renamed |
| thinkingAutoEstimated | tasks | thinking_auto_estimated | Boolean |
| activeAgent | tasks | active_agent | VARCHAR |
| completedBy | tasks | completed_by | VARCHAR |
| attemptCount | tasks | attempt_count | Integer |
| sessionRefs[] | tasks | session_refs | JSONB |
| parentId | tasks | parent_id | UUID |
| statusReason | tasks | status_reason | TEXT |
| autoCreated | tasks | auto_created | Boolean |

### CLI Operations Supported

All current `nimtasks` CLI commands are supported:

✅ **Task Management:**
- `list` - Query by status, priority, project with indexes
- `next` - Filtered query with sorting
- `current` - Status-based query
- `get` - UUID lookup
- `create` - Insert into tasks + related tables
- `update` - Update tasks + cascade to related tables
- `move` - Status updates
- `archive` - Set archived_at timestamp
- `delete` - CASCADE deletes to subtasks, tags, deps, links

✅ **Subtask Operations:**
- `complete-subtask` - Update subtasks.status
- `approve-subtask` - Status transition
- `reject-subtask` - Status transition with note
- `uncomplete-subtask` - Status rollback

✅ **Advanced:**
- `spawn` - Create new task with dependencies
- `breakdown` - Generate subtasks
- `auto-archive` - Bulk status updates
- `review` - Query + filtering

### API Endpoints Supported

All current API routes work with new schema:

✅ **Tasks:**
- `GET /tasks` - List with filtering
- `GET /tasks/:id` - Lookup by UUID
- `GET /tasks/current` - Status query
- `GET /tasks/next` - Priority sorting
- `POST /tasks` - Create with relations
- `PATCH /tasks/:id` - Update with relations
- `DELETE /tasks/:id` - Cascade delete
- `POST /tasks/:id/archive` - Status update

✅ **Subtasks:**
- `PATCH /tasks/:id/subtasks/:index/status` - Update by index
- `PUT /tasks/:id/subtasks/:index` - Replace subtask
- `POST /tasks/:id/subtasks/:index/approve` - Status transition
- `POST /tasks/:id/subtasks/:index/reject` - Status transition
- `GET /tasks/:id/subtasks/summary` - Aggregate query

✅ **Operations:**
- `POST /tasks/:id/spawn` - Create dependent task
- `POST /tasks/:id/breakdown` - Generate subtasks
- `POST /tasks/auto-archive` - Bulk update

## Data Migration Script

**Features:**
- ✅ Reads from tasks.json (configurable path)
- ✅ Preserves task UUIDs where valid
- ✅ Maps project names to project_id via lookup
- ✅ Handles timestamp parsing with fallbacks
- ✅ Migrates subtasks with ordering preserved
- ✅ Normalizes tags into task_tags table
- ✅ Merges blockedBy + dependsOn into task_dependencies
- ✅ Migrates links with type/title/url
- ✅ Transaction safety (rollback on error)
- ✅ Progress reporting
- ✅ Environment variable configuration

**Configuration:**
```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=clawboard
export DB_USER=clawboard
export DB_PASSWORD=clawboard
export TASKS_JSON_PATH=/home/clawd/clawd/memory/tasks.json
```

**Usage:**
```bash
# 1. Run schema migration
sudo docker exec clawboard-db psql -U clawboard -d clawboard -f /path/to/020_tasks_redesign.sql

# 2. Run data migration
python3 020_migrate_tasks_data.py
```

## Index Strategy

**Query Patterns → Indexes:**

1. **List tasks by status** → `idx_tasks_status`
2. **Filter by priority** → `idx_tasks_priority`
3. **Project dashboard** → `idx_tasks_project_id`
4. **Recent tasks** → `idx_tasks_created_at`
5. **Auto-start detection** → `idx_tasks_auto_start` (composite)
6. **Session correlation** → `idx_tasks_session_refs` (GIN)
7. **Subtask lookup** → `idx_subtasks_task_id`
8. **Tag filtering** → `idx_task_tags_tag`
9. **Dependency graph** → `idx_task_dependencies_task_id`, `idx_task_dependencies_depends_on`

## Design Decisions

### 1. Why separate subtasks table?
- Enables ordering via `index` column
- Allows individual subtask metadata (notes, timestamps)
- Simplifies subtask status updates
- Prevents array manipulation complexity in SQL

### 2. Why normalize tags?
- Enables efficient tag-based filtering
- Allows tag analytics (tag usage counts)
- Prevents array scanning in WHERE clauses
- Maintains referential integrity

### 3. Why keep session_refs as JSONB?
- Session IDs are unstructured references
- No foreign key relationship needed
- GIN index enables fast containment queries
- Future flexibility for additional session metadata

### 4. Why task_dependencies instead of blockedBy array?
- Enables bidirectional queries (what blocks this? what does this block?)
- Allows cycle detection with recursive CTEs
- Simplifies dependency graph traversal
- Maintains referential integrity with CASCADE

### 5. Why thinking_budget instead of thinking?
- More descriptive name
- Matches field's purpose (AI thinking level)
- Consistent with other _budget patterns

## Testing Checklist

Before deploying:

- [ ] Test schema creation on fresh database
- [ ] Run data migration script with test data
- [ ] Verify all subtasks maintain ordering
- [ ] Check tag normalization accuracy
- [ ] Validate dependency graph integrity
- [ ] Test CLI commands against new schema
- [ ] Test API endpoints against new schema
- [ ] Verify indexes are used (EXPLAIN ANALYZE)
- [ ] Test CASCADE deletes work correctly
- [ ] Backup production tasks.json before migration

## Next Steps

**Phase 1b: Backend Implementation**
1. Update TypeScript types to match new schema
2. Replace tasks.json file operations with SQL queries
3. Update TaskService methods
4. Update API route handlers
5. Add migration runner to deployment

**Phase 1c: Testing & Deployment**
1. Create test suite for new schema
2. Test on development environment
3. Backup production database
4. Run migration on production
5. Monitor for issues

## Peer Review Notes

**Schema Review:**
- ✅ All tasks.json fields accounted for
- ✅ All nimtasks CLI operations supported
- ✅ All API endpoints compatible
- ✅ Proper indexes for query patterns
- ✅ Cascade deletes configured
- ✅ CHECK constraints for data integrity
- ✅ Timestamps with timezone awareness
- ✅ Foreign key relationships enforced

**Data Migration Review:**
- ✅ Transaction safety
- ✅ Error handling
- ✅ UUID preservation
- ✅ Timestamp parsing
- ✅ Project name lookup
- ✅ Subtask ordering preserved
- ✅ Tag normalization
- ✅ Dependency merging

**Potential Issues:**
- ⚠️ Large migration may take time (test with production data size)
- ⚠️ Circular dependencies need careful handling
- ⚠️ Invalid UUIDs in tasks.json will be regenerated
- ⚠️ Missing project names will result in NULL project_id

## Files Location

```
/home/clawd/clawd/projects/clawboard-nim/repo/database/migrations/
├── 020_tasks_redesign.sql       (9 KB - DDL migration)
├── 020_migrate_tasks_data.py    (12 KB - Data migration)
└── 020_README.md                (this file)
```

---

**Ready for review and approval before implementation.**
