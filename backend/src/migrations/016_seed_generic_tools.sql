-- Migration 013: Seed generic ClawBoard tools
-- Generic tools suitable for any OpenClaw bot deployment
-- Safe to re-run: ON CONFLICT DO NOTHING

INSERT INTO tools (id, name, category, description, usage_instructions, tags, is_global, version)
VALUES
  (
    gen_random_uuid(),
    'task-management',
    'workflow',
    'Manage tasks via ClawBoard CLI. Commands: list, create, move, complete-subtask, approve-subtask.',
    E'## Task Management\n\n**Command:** `nimtasks` (or your configured CLI tool)\n\n### Key Commands\n```bash\nnimtasks list                          # List all non-archived tasks\nnimtasks list --status todo            # Filter by status\nnimtasks next                          # Get next auto-pickup task\nnimtasks get <id>                      # Get task by short ID\nnimtasks create "Title" -p project     # Create new task\nnimtasks move <id> in-progress         # Change task status\nnimtasks complete-subtask <id> <idx>   # Mark subtask complete\nnimtasks approve-subtask <id> <idx>    # Approve completed subtask\n```\n\n### Task Statuses\n- `todo` - Not started\n- `in-progress` - Currently working\n- `review` - Awaiting review\n- `done` - Completed\n- `archived` - Archived\n\n### Subtask Workflow\nSubtasks have tri-state status:\n- `new` ⬜ → Task is pending\n- `in_review` 🔄 → Agent marked complete, awaiting approval\n- `completed` ✅ → Approved and done\n\nAgents use `complete-subtask`, orchestrators use `approve-subtask`/`reject-subtask`.',
    ARRAY['cli', 'tasks', 'workflow', 'productivity'],
    TRUE,
    1
  ),
  
  (
    gen_random_uuid(),
    'project-management',
    'workflow',
    'Manage projects. Commands: list, create, archive.',
    E'## Project Management\n\n**Command:** `nimtasks projects` (or your configured CLI tool)\n\n### Key Commands\n```bash\nnimtasks projects                      # List all projects\nnimtasks project create "name"         # Create new project\nnimtasks project archive <id>          # Archive project\n```\n\n### Project Organization\nProjects group related tasks together:\n- Each task can belong to one project\n- Projects help organize work by area/goal\n- Archive completed projects to keep workspace clean\n\n### Usage Tips\n- Create projects for major initiatives or areas of work\n- Use consistent naming (e.g., "HomeServer", "WebsiteRedesign")\n- Review project task lists: `nimtasks list --project <name>`',
    ARRAY['cli', 'projects', 'workflow', 'organization'],
    TRUE,
    1
  ),
  
  (
    gen_random_uuid(),
    'heartbeat-monitoring',
    'monitoring',
    'Heartbeat watchdog for proactive monitoring. Create a script that checks task status, agent activity, and system health.',
    E'## Heartbeat Monitoring\n\n**Purpose:** Proactive monitoring and health checks\n**Implementation:** Custom script run via HEARTBEAT.md cron\n\n### What to Monitor\n1. **Task Status**\n   - Overdue tasks\n   - Tasks stuck in review\n   - Newly created high-priority tasks\n\n2. **Agent Activity**\n   - Last activity timestamp\n   - Session status\n   - Error logs\n\n3. **System Health**\n   - Disk space\n   - Database connectivity\n   - External API availability\n\n### Example Script Structure\n```python\n#!/usr/bin/env python3\nimport requests\nimport sys\nfrom datetime import datetime, timedelta\n\ndef check_tasks():\n    # Check for overdue or stuck tasks\n    response = requests.get("http://localhost:3001/api/tasks")\n    tasks = response.json()\n    # ... analyze tasks ...\n    \ndef check_system():\n    # Health checks\n    # ... check disk, db, etc ...\n    \nif __name__ == "__main__":\n    check_tasks()\n    check_system()\n    print("HEARTBEAT_OK")  # or raise issues\n```\n\n### Integration\nAdd to `HEARTBEAT.md` with cron schedule:\n```bash\n*/15 * * * * /path/to/nimbeat.py\n```\n\nThe script should output `HEARTBEAT_OK` when all is well, or specific issues when action is needed.',
    ARRAY['monitoring', 'automation', 'health-check', 'cron'],
    TRUE,
    1
  ),
  
  (
    gen_random_uuid(),
    'tool-management',
    'admin',
    'Manage the tools registry. Commands: list, get, generate-md.',
    E'## Tool Management\n\n**Command:** `nimtasks tools` (or your configured CLI tool)\n\n### Key Commands\n```bash\nnimtasks tools list                    # List all tools\nnimtasks tools list --category admin   # Filter by category\nnimtasks tools get <name>              # Get tool details\nnimtasks tools update <id> --instructions "..." # Update tool\nnimtasks tools generate-md --slim      # Regenerate TOOLS.md\n```\n\n### Tool Categories\nTools are organized by category:\n- `workflow` - Task and project management\n- `monitoring` - Health checks and alerts\n- `admin` - System administration\n- `research` - Information gathering\n- `automation` - Browser and task automation\n- `devops` - Infrastructure and deployment\n- `audio` - Voice and audio processing\n- `image-generation` - Image creation\n\n### TOOLS.md Generation\nThe `TOOLS.md` file is auto-generated from the database:\n```bash\nnimtasks tools generate-md --slim -o /path/to/TOOLS.md\n```\n\n**Never edit TOOLS.md manually** - always update via the database and regenerate.',
    ARRAY['admin', 'tools', 'registry', 'documentation'],
    TRUE,
    1
  ),
  
  (
    gen_random_uuid(),
    'web-search',
    'research',
    'Search the web via SearXNG or built-in web_fetch tool. Use for research, fact-checking, and gathering information.',
    E'## Web Search & Research\n\n**Tools Available:**\n1. OpenClaw built-in `web_fetch` function\n2. SearXNG self-hosted instance (if configured)\n\n### Using web_fetch\nBuilt into OpenClaw, no setup needed:\n```python\n# Fetch and extract content from URL\nresult = web_fetch("https://example.com")\nprint(result.markdown)  # Clean markdown content\n```\n\n### Using SearXNG\nPrivacy-respecting meta search engine:\n```bash\n# Search via API\ncurl "http://your-searxng-instance/search?q=query&format=json"\n```\n\n### When to Use\n- **Research:** Gather information on unfamiliar topics\n- **Fact-checking:** Verify information before sharing\n- **Documentation:** Find API docs, guides, tutorials\n- **News:** Check current events or status updates\n- **Troubleshooting:** Search for error messages and solutions\n\n### Best Practices\n- Verify sources (prefer official documentation)\n- Cross-reference important facts\n- Check publication dates for time-sensitive info\n- Respect robots.txt and rate limits\n- Cache results when appropriate',
    ARRAY['research', 'search', 'web', 'information-gathering'],
    TRUE,
    1
  ),
  
  (
    gen_random_uuid(),
    'browser-automation',
    'automation',
    'Control a headless browser for web scraping, screenshots, and UI testing. Available via OpenClaw browser tool.',
    E'## Browser Automation\n\n**Built-in Tool:** OpenClaw `browser` function\n**Backend:** Playwright with Chrome/Chromium\n\n### Key Actions\n```python\n# Take screenshot\nbrowser(action="screenshot", targetUrl="https://example.com")\n\n# Navigate and interact\nbrowser(action="open", targetUrl="https://example.com")\nbrowser(action="snapshot")  # Get page structure\nbrowser(action="act", request={\n    "kind": "click",\n    "ref": "button-id"\n})\n\n# Extract content\nbrowser(action="snapshot", snapshotFormat="aria")\n```\n\n### Common Use Cases\n1. **Screenshots:** Capture visual state of pages\n2. **Web Scraping:** Extract data from dynamic sites\n3. **Form Filling:** Automate form submissions\n4. **Testing:** Verify UI behavior\n5. **Monitoring:** Check if pages load correctly\n\n### Snapshot Modes\n- `role` - Role-based element refs (default)\n- `aria` - ARIA-based refs (more stable)\n- `ai` - AI-optimized format\n\n### Best Practices\n- Use `refs="aria"` for stable element references\n- Add delays for dynamic content: `act:wait`\n- Handle dialogs and popups explicitly\n- Close tabs when done to free resources\n- Respect target site terms of service',
    ARRAY['automation', 'browser', 'scraping', 'testing', 'screenshots'],
    TRUE,
    1
  )
ON CONFLICT (name) DO NOTHING;
