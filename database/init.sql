-- ClawBoard Database Schema
-- PostgreSQL 16
-- Consolidated from all migrations (004-010)
-- Single source of truth for fresh installations

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- CORE TABLES
-- =====================================================

-- Bot Status Table (Agent's avatar and status updates)
CREATE TABLE IF NOT EXISTS bot_status (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mood VARCHAR(100) NOT NULL,
    status_text TEXT NOT NULL,
    avatar_url TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for quick retrieval of latest status
CREATE INDEX IF NOT EXISTS idx_bot_status_updated_at ON bot_status(updated_at DESC);

COMMENT ON TABLE bot_status IS 'Agent avatar and status updates, displayed on dashboard';

-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    source_dir VARCHAR(255),
    nfs_dir VARCHAR(255),
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT projects_status_check CHECK (status IN ('active', 'paused', 'archived', 'completed'))
);

-- Create indexes for projects
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_nfs_dir ON projects(nfs_dir);
CREATE INDEX IF NOT EXISTS idx_projects_is_hidden ON projects(is_hidden);

-- Project Links Table
CREATE TABLE IF NOT EXISTS project_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT project_links_type_check CHECK (type IN ('git', 'doc', 'url', 'api'))
);

CREATE INDEX IF NOT EXISTS idx_project_links_project_id ON project_links(project_id);

-- Tasks Table (Kanban tasks with Work Orchestration System features)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'todo' CHECK (status IN ('ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived')),
    priority VARCHAR(50) CHECK (priority IN ('low', 'medium', 'high')),
    tags TEXT[],
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    
    -- Work Orchestration System fields
    auto_created BOOLEAN DEFAULT FALSE,
    auto_start BOOLEAN DEFAULT TRUE,
    last_checked TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    archived_at TIMESTAMP WITH TIME ZONE,
    blocked_reason TEXT,
    session_refs JSONB DEFAULT '[]',
    links JSONB DEFAULT '[]',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for tasks
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_auto_start ON tasks(auto_start, status) WHERE auto_start = TRUE AND status = 'todo';
CREATE INDEX IF NOT EXISTS idx_tasks_session_refs ON tasks USING GIN (session_refs);
CREATE INDEX IF NOT EXISTS idx_tasks_links ON tasks USING GIN (links);

-- Task History Table (audit log of task changes)
CREATE TABLE IF NOT EXISTS task_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id);

-- Agents Table (spawned sub-agents)
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    task TEXT,
    spawned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- Chain of Thought Table (execution logs)
CREATE TABLE IF NOT EXISTS thoughts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    entry_type VARCHAR(100) NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_thoughts_agent_id ON thoughts(agent_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_task_id ON thoughts(task_id);

-- Approvals Table (commands and plans)
CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL CHECK (type IN ('command', 'plan')),
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'commented')),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    data JSONB NOT NULL,
    link_token VARCHAR(255) UNIQUE NOT NULL,
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP WITH TIME ZONE,
    response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approvals_link_token ON approvals(link_token);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Image Generations Table
CREATE TABLE IF NOT EXISTS image_generations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prompt TEXT NOT NULL,
    model VARCHAR(255) NOT NULL DEFAULT 'gemini/gemini-3-pro-image-preview',
    file_path VARCHAR(500) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT image_generations_status_check CHECK (status IN ('pending', 'generating', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_image_generations_status ON image_generations(status);
CREATE INDEX IF NOT EXISTS idx_image_generations_created_at ON image_generations(created_at DESC);

-- =====================================================
-- TRIGGERS AND FUNCTIONS
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to auto-update updated_at
CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_approvals_updated_at BEFORE UPDATE ON approvals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- TOOLS MANAGEMENT SYSTEM
-- =====================================================

-- Tools registry table (from migration 009)
CREATE TABLE IF NOT EXISTS tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    category VARCHAR(100),
    description TEXT,
    usage_instructions TEXT,
    config JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    is_global BOOLEAN DEFAULT FALSE,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);
CREATE INDEX IF NOT EXISTS idx_tools_category ON tools(category);
CREATE INDEX IF NOT EXISTS idx_tools_tags ON tools USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_tools_is_global ON tools(is_global);

-- Comments
COMMENT ON TABLE tools IS 'Registry of tools available to agents and projects';
COMMENT ON COLUMN tools.config IS 'JSONB config - encrypted at app level for sensitive values';
COMMENT ON COLUMN tools.tags IS 'Array of tags for filtering and categorization';
COMMENT ON COLUMN tools.is_global IS 'Global tools are available to all projects';
COMMENT ON COLUMN tools.version IS 'Auto-incremented on each update';

-- Project tools junction table (from migration 010)
CREATE TABLE IF NOT EXISTS project_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    override_instructions TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, tool_id)
);

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_project_tools_project_id ON project_tools(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tools_tool_id ON project_tools(tool_id);

COMMENT ON TABLE project_tools IS 'Junction table linking tools to projects with optional instruction overrides';
COMMENT ON COLUMN project_tools.override_instructions IS 'When set, replaces the tool base usage_instructions for this project';

-- =====================================================
-- JOURNAL SYSTEM
-- =====================================================

-- Journal entries table (from migrations 006 and 015)
-- Supports multiple entries per day with sequence numbers
CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 1,
    mood VARCHAR(50),
    reflection_text TEXT NOT NULL,
    image_path VARCHAR(500),
    highlights TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT journal_entries_date_sequence_key UNIQUE (date, sequence)
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_date_seq ON journal_entries(date DESC, sequence DESC);

COMMENT ON TABLE journal_entries IS 'Daily reflection journal with mood tracking and AI-generated art';
COMMENT ON COLUMN journal_entries.sequence IS 'Allows multiple entries per day (1, 2, 3, ...)';

-- =====================================================
-- USER PREFERENCES
-- =====================================================

-- User preferences table (from migration 014)
CREATE TABLE IF NOT EXISTS user_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE user_preferences IS 'Dashboard settings and user preferences';

-- =====================================================
-- INITIAL DATA
-- =====================================================

-- Insert default bot status
INSERT INTO bot_status (mood, status_text, avatar_url) 
VALUES ('neutral', 'Ready to explore and create', NULL)
ON CONFLICT DO NOTHING;

-- Seed generic ClawBoard tools (from migration 013)
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

-- Schema initialization complete
SELECT 'ClawBoard database schema initialized successfully' AS status;
