#!/usr/bin/env python3
"""
Migration 020: Data Migration from tasks.json to PostgreSQL
Reads tasks from tasks.json and inserts into relational schema
Run after executing 020_tasks_redesign.sql
"""

import json
import sys
import os
from datetime import datetime
import psycopg2
from psycopg2.extras import Json
from typing import Dict, List, Any, Optional

# Database connection configuration
# Override with environment variables if needed
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': os.getenv('DB_PORT', '5432'),
    'database': os.getenv('DB_NAME', 'clawboard'),
    'user': os.getenv('DB_USER', 'clawboard'),
    'password': os.getenv('DB_PASSWORD', 'clawboard')
}

TASKS_JSON_PATH = os.getenv('TASKS_JSON_PATH', os.path.expanduser('~/clawd/memory/tasks.json'))


def parse_timestamp(ts: Optional[str]) -> Optional[str]:
    """Parse ISO timestamp string, return None if invalid/missing"""
    if not ts:
        return None
    try:
        # Validate it's a proper timestamp
        datetime.fromisoformat(ts.replace('Z', '+00:00'))
        return ts
    except (ValueError, AttributeError):
        return None


def get_project_id(conn, project_name: Optional[str]) -> Optional[str]:
    """Look up project ID by name, return None if not found"""
    if not project_name:
        return None
    
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM projects WHERE name = %s", (project_name,))
        result = cur.fetchone()
        return result[0] if result else None


def migrate_task(conn, task: Dict[str, Any], project_mapping: Dict[str, str]) -> str:
    """
    Insert task into tasks table
    Returns task ID for subtask/tag/dependency/link insertion
    """
    
    # Handle ID - use existing if valid UUID, generate new otherwise
    import re
    uuid_pattern = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    task_id = task.get('id')
    if not task_id or not uuid_pattern.match(str(task_id)):
        task_id = None  # Let DB generate UUID
    
    # Map project name to project_id
    project_name = task.get('project')
    project_id = project_mapping.get(project_name) if project_name else None
    
    # Extract fields with fallbacks
    title = task.get('title', 'Untitled Task')
    description = task.get('description')
    status = task.get('status', 'todo')
    priority = task.get('priority', 'normal')
    
    # Execution configuration
    thinking_budget = task.get('thinking', 'medium')
    thinking_auto_estimated = task.get('thinkingAutoEstimated', False)
    model = task.get('model')
    execution_mode = task.get('executionMode')
    auto_created = task.get('autoCreated', False)
    auto_start = task.get('autoStart', True)
    
    # Blocking & status
    blocked_reason = task.get('blockedReason') or task.get('notes')
    status_reason = task.get('statusReason')
    
    # Agent tracking
    active_agent_raw = task.get('activeAgent')
    active_agent = active_agent_raw.get('name', str(active_agent_raw)) if isinstance(active_agent_raw, dict) else active_agent_raw
    completed_by_raw = task.get('completedBy')
    completed_by = completed_by_raw.get('name', str(completed_by_raw)) if isinstance(completed_by_raw, dict) else completed_by_raw
    attempt_count = task.get('attemptCount', 0)
    
    # Session references
    session_refs = task.get('sessionRefs', [])
    if not isinstance(session_refs, list):
        session_refs = []
    
    # Parent task (for hierarchical tasks)
    parent_id = task.get('parentId')
    
    # Timestamps
    created_at = parse_timestamp(task.get('created'))
    updated_at = parse_timestamp(task.get('updated'))
    started_at = parse_timestamp(task.get('startedAt'))
    completed_at = parse_timestamp(task.get('completedAt') or task.get('completed'))
    archived_at = parse_timestamp(task.get('archivedAt'))
    
    with conn.cursor() as cur:
        if task_id:
            # Insert with explicit ID
            cur.execute("""
                INSERT INTO tasks (
                    id, title, description, status, priority, project_id,
                    thinking_budget, thinking_auto_estimated, model, execution_mode,
                    auto_created, auto_start, blocked_reason, status_reason,
                    active_agent, completed_by, attempt_count, session_refs, parent_id,
                    created_at, updated_at, started_at, completed_at, archived_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s
                ) RETURNING id
            """, (
                task_id, title, description, status, priority, project_id,
                thinking_budget, thinking_auto_estimated, model, execution_mode,
                auto_created, auto_start, blocked_reason, status_reason,
                active_agent, completed_by, attempt_count, Json(session_refs), parent_id,
                created_at, updated_at, started_at, completed_at, archived_at
            ))
        else:
            # Let DB generate ID
            cur.execute("""
                INSERT INTO tasks (
                    title, description, status, priority, project_id,
                    thinking_budget, thinking_auto_estimated, model, execution_mode,
                    auto_created, auto_start, blocked_reason, status_reason,
                    active_agent, completed_by, attempt_count, session_refs, parent_id,
                    created_at, updated_at, started_at, completed_at, archived_at
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s
                ) RETURNING id
            """, (
                title, description, status, priority, project_id,
                thinking_budget, thinking_auto_estimated, model, execution_mode,
                auto_created, auto_start, blocked_reason, status_reason,
                active_agent, completed_by, attempt_count, Json(session_refs), parent_id,
                created_at, updated_at, started_at, completed_at, archived_at
            ))
        
        task_id = cur.fetchone()[0]
    
    return task_id


def migrate_subtasks(conn, task_id: str, subtasks: List[Dict[str, Any]]):
    """Insert subtasks for a task"""
    if not subtasks:
        return
    
    with conn.cursor() as cur:
        for index, subtask in enumerate(subtasks):
            title = subtask.get('text') or subtask.get('title', 'Untitled subtask')
            status = subtask.get('status', 'new')
            note = subtask.get('note')
            
            created_at = parse_timestamp(subtask.get('createdAt'))
            updated_at = parse_timestamp(subtask.get('updatedAt'))
            completed_at = parse_timestamp(subtask.get('completedAt'))
            
            # Map old boolean 'completed' to status if needed
            if subtask.get('completed') and status == 'new':
                status = 'completed'
            
            cur.execute("""
                INSERT INTO subtasks (
                    task_id, index, title, status, note,
                    created_at, updated_at, completed_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (task_id, index, title, status, note, created_at, updated_at, completed_at))


def migrate_tags(conn, task_id: str, tags: List[str]):
    """Insert tags for a task"""
    if not tags:
        return
    
    with conn.cursor() as cur:
        for tag in tags:
            if tag:  # Skip empty tags
                cur.execute("""
                    INSERT INTO task_tags (task_id, tag)
                    VALUES (%s, %s)
                    ON CONFLICT (task_id, tag) DO NOTHING
                """, (task_id, tag))


def migrate_dependencies(conn, task_id: str, depends_on: List[str], task_id_mapping: dict):
    """Insert task dependencies"""
    if not depends_on:
        return
    
    with conn.cursor() as cur:
        for dep_id in depends_on:
            # Map old ID to new UUID
            mapped_id = task_id_mapping.get(dep_id)
            if mapped_id:
                try:
                    cur.execute("""
                        INSERT INTO task_dependencies (task_id, depends_on_task_id)
                        VALUES (%s, %s)
                        ON CONFLICT (task_id, depends_on_task_id) DO NOTHING
                    """, (task_id, mapped_id))
                except psycopg2.IntegrityError:
                    # Handle circular dependencies gracefully
                    print(f"  Warning: Circular dependency {task_id} -> {dep_id}", file=sys.stderr)
                    conn.rollback()


def migrate_links(conn, task_id: str, links: List[Dict[str, str]]):
    """Insert task links"""
    if not links:
        return
    
    with conn.cursor() as cur:
        for link in links:
            link_type = link.get('type', 'unknown')
            title = link.get('title', 'Untitled link')
            url = link.get('url', '')
            
            if url:  # Only insert if URL exists
                cur.execute("""
                    INSERT INTO task_links (task_id, type, title, url)
                    VALUES (%s, %s, %s, %s)
                """, (task_id, link_type, title, url))


def main():
    """Main migration logic"""
    print(f"Loading tasks from {TASKS_JSON_PATH}...")
    
    # Load tasks.json
    try:
        with open(TASKS_JSON_PATH, 'r') as f:
            data = json.load(f)
            tasks = data.get('tasks', [])
    except FileNotFoundError:
        print(f"Error: tasks.json not found at {TASKS_JSON_PATH}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in tasks.json: {e}", file=sys.stderr)
        sys.exit(1)
    
    print(f"Found {len(tasks)} tasks to migrate")
    
    # Connect to database
    print(f"Connecting to PostgreSQL at {DB_CONFIG['host']}:{DB_CONFIG['port']}...")
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = False  # Use transactions
    except psycopg2.Error as e:
        print(f"Error: Could not connect to database: {e}", file=sys.stderr)
        sys.exit(1)
    
    try:
        # Build project mapping (name -> id)
        print("Building project mapping...")
        with conn.cursor() as cur:
            cur.execute("SELECT id, name FROM projects")
            project_mapping = {name: id for id, name in cur.fetchall()}
        print(f"  Found {len(project_mapping)} projects")
        
        # First pass: Create all tasks and collect IDs
        print("\nMigrating tasks...")
        task_id_mapping = {}  # old_id -> new_id
        all_task_ids = set()
        
        for i, task in enumerate(tasks, 1):
            old_id = task.get('id')
            print(f"  [{i}/{len(tasks)}] {task.get('title', 'Untitled')[:50]}...")
            
            new_id = migrate_task(conn, task, project_mapping)
            task_id_mapping[old_id] = new_id
            all_task_ids.add(new_id)
        
        # Second pass: Migrate related data
        print("\nMigrating subtasks, tags, dependencies, and links...")
        for i, task in enumerate(tasks, 1):
            task_id = task_id_mapping[task.get('id')]
            
            # Subtasks
            subtasks = task.get('subtasks', [])
            if subtasks:
                migrate_subtasks(conn, task_id, subtasks)
            
            # Tags
            tags = task.get('tags', [])
            if tags:
                migrate_tags(conn, task_id, tags)
            
            # Dependencies (blockedBy and dependsOn)
            depends_on = []
            if task.get('blockedBy'):
                depends_on.extend(task['blockedBy'])
            if task.get('dependsOn'):
                depends_on.extend(task['dependsOn'])
            
            if depends_on:
                migrate_dependencies(conn, task_id, depends_on, task_id_mapping)
            
            # Links
            links = task.get('links', [])
            if links:
                migrate_links(conn, task_id, links)
        
        # Commit transaction
        conn.commit()
        print("\n✅ Migration completed successfully!")
        print(f"   Migrated {len(tasks)} tasks")
        
    except Exception as e:
        conn.rollback()
        print(f"\n❌ Migration failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
