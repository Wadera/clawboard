#!/usr/bin/env python3
"""Index JSONL session transcripts into PostgreSQL sessions table."""

import json, os, sys, glob
from datetime import datetime
import psycopg2
from psycopg2.extras import Json

SESSIONS_DIR = os.getenv('SESSIONS_DIR', os.path.expanduser('~/.openclaw/agents/main/sessions'))
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': os.getenv('DB_PORT', '5432'),
    'database': os.getenv('DB_NAME', 'clawboard'),
    'user': os.getenv('DB_USER', 'clawboard'),
    'password': os.getenv('DB_PASSWORD', 'clawboard')
}

def parse_jsonl(filepath):
    """Parse a JSONL transcript and extract metadata."""
    meta = {
        'message_count': 0, 'tool_call_count': 0,
        'input_tokens': 0, 'output_tokens': 0, 'thinking_tokens': 0,
        'cache_read_tokens': 0, 'total_cost': 0.0,
        'models': set(), 'labels': set(), 'session_keys': set(),
        'first_ts': None, 'last_ts': None,
    }
    
    try:
        with open(filepath, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                
                msg = entry.get('message', {})
                ts = entry.get('timestamp')
                
                if ts:
                    if not meta['first_ts'] or ts < meta['first_ts']:
                        meta['first_ts'] = ts
                    if not meta['last_ts'] or ts > meta['last_ts']:
                        meta['last_ts'] = ts
                
                role = msg.get('role', '')
                if role in ('user', 'assistant', 'toolResult'):
                    meta['message_count'] += 1
                
                # Count tool calls
                content = msg.get('content', [])
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get('type') == 'toolCall':
                            meta['tool_call_count'] += 1
                
                # Extract usage
                usage = msg.get('usage', {})
                if usage:
                    meta['input_tokens'] += usage.get('input', 0) or 0
                    meta['output_tokens'] += usage.get('output', 0) or 0
                    meta['cache_read_tokens'] += usage.get('cacheRead', 0) or 0
                    cost = usage.get('cost', {})
                    if isinstance(cost, dict):
                        meta['total_cost'] += cost.get('total', 0) or 0
                
                model = msg.get('model')
                if model:
                    meta['models'].add(model)
                
                # Extract session key and label from session metadata
                if entry.get('type') == 'session':
                    sk = entry.get('sessionKey')
                    if sk:
                        meta['session_keys'].add(sk)
                    lbl = entry.get('label')
                    if lbl:
                        meta['labels'].add(lbl)
    except Exception as e:
        print(f"  Warning: Error parsing {filepath}: {e}", file=sys.stderr)
    
    return meta


def derive_kind(session_key):
    if not session_key:
        return 'unknown'
    if ':heartbeat' in session_key:
        return 'heartbeat'
    if ':subagent:' in session_key:
        return 'subagent'
    if ':main' in session_key:
        return 'main'
    return 'unknown'


def main():
    files = sorted(glob.glob(os.path.join(SESSIONS_DIR, '*.jsonl')))
    print(f"Found {len(files)} JSONL files to index")
    
    # No sessions.json available — session keys derived from transcripts
    key_map = {}
    
    DB_IP = os.popen("sudo docker inspect clawboard-db --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").read().strip()
    DB_PASS = os.popen("grep POSTGRES_PASSWORD .env | cut -d= -f2").read().strip()
    
    conn = psycopg2.connect(host=DB_IP, port=5432, database='clawboard', user='clawboard', password=DB_PASS)
    conn.autocommit = False
    
    indexed = 0
    skipped = 0
    
    for i, filepath in enumerate(files):
        basename = os.path.basename(filepath)
        session_id = basename.replace('.jsonl', '')
        
        if i % 100 == 0:
            print(f"  [{i}/{len(files)}]...")
        
        meta = parse_jsonl(filepath)
        
        # Get session key from sessions.json
        sinfo = key_map.get(session_id, {})
        session_key = sinfo.get('sessionKey') or session_id
        label = sinfo.get('label') or (list(meta['labels'])[0] if meta['labels'] else None)
        model = sinfo.get('model') or (list(meta['models'])[0] if meta['models'] else None)
        kind = derive_kind(session_key)
        
        # Determine status
        status = 'completed'
        if sinfo.get('abortedLastRun'):
            status = 'failed'
        
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO sessions (
                    id, session_key, label, model, kind, status,
                    message_count, tool_call_count,
                    input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
                    total_cost_usd, transcript_path,
                    started_at, ended_at, last_activity_at, metadata
                ) VALUES (
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s
                ) ON CONFLICT (session_key) DO UPDATE SET
                    message_count = EXCLUDED.message_count,
                    tool_call_count = EXCLUDED.tool_call_count,
                    input_tokens = EXCLUDED.input_tokens,
                    output_tokens = EXCLUDED.output_tokens,
                    cache_read_tokens = EXCLUDED.cache_read_tokens,
                    total_cost_usd = EXCLUDED.total_cost_usd,
                    last_activity_at = EXCLUDED.last_activity_at,
                    updated_at = CURRENT_TIMESTAMP
            """, (
                session_id, session_key, label, model, kind, status,
                meta['message_count'], meta['tool_call_count'],
                meta['input_tokens'], meta['output_tokens'], meta['thinking_tokens'], meta['cache_read_tokens'],
                meta['total_cost'], basename,
                meta['first_ts'], meta['last_ts'], meta['last_ts'],
                Json({'models': list(meta['models'])})
            ))
        
        indexed += 1
    
    conn.commit()
    conn.close()
    print(f"\n✅ Indexed {indexed} sessions, skipped {skipped}")


if __name__ == '__main__':
    main()
