-- Migration 011: Seed initial tools from TOOLS.md
-- Inserts common tools with category, description, and usage instructions

INSERT INTO tools (id, name, category, description, usage_instructions, tags, is_global, version)
VALUES
  (
    gen_random_uuid(),
    'clawboard',
    'task-management',
    'CLI tool for managing tasks, projects, subtasks, and journals via the ClawBoard Dashboard API.',
    E'## clawboard CLI\n\n**Location:** `cli/clawboard` (or `python3 cli/clawboard`)\n**API:** Wraps your dashboard API at `/api/tasks`\n\n### Key Commands\n```bash\nclawboard list                          # all non-archived\nclawboard list --status todo -v         # verbose with subtasks\nclawboard next                          # next auto-pickup task\nclawboard get <id>                      # by short ID prefix\nclawboard create "Title" --project X    # create task\nclawboard move <id> in-progress         # change status\nclawboard complete-subtask <id> <idx>   # mark subtask in_review\n```\n\n### Subtask Workflow (Tri-State)\n- `new` ⬜ → `in_review` 🔄 (agent) → `completed` ✅ (orchestrator)\n- Agents use `complete-subtask`, orchestrator uses `approve-subtask` / `reject-subtask`',
    ARRAY['cli', 'tasks', 'project-management'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'imagine',
    'image-generation',
    'Image generation tool using LiteLLM proxy to Gemini/Imagen models.',
    E'## Image Generation (Nano Banana Pro)\n\n**Tool:** `python3 tools/imagine.py "your prompt here"`\n**Output:** `media/generated/` directory\n\n### Models\n- `gemini/gemini-3-pro-image-preview` — default, best quality\n- `gemini/imagen-4.0-generate-001` — Imagen 4\n- `gemini/imagen-4.0-fast-generate-001` — Imagen 4 Fast\n\n### Usage\n```bash\npython3 tools/imagine.py "a futuristic city at sunset"\npython3 tools/imagine.py "a cat" --model gemini/imagen-4.0-generate-001\n```\n\nTo send in chat: use `MEDIA:/path/to/image.png` in reply.',
    ARRAY['images', 'ai', 'generation'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'semaphore',
    'devops',
    'Ansible Semaphore integration for running infrastructure automation tasks.',
    E'## Semaphore (Ansible UI)\n\n**Tool:** `python3 tools/semaphore`\n**URL:** Configure in your environment\n\n### Commands\n```bash\npython3 tools/semaphore templates         # list templates\npython3 tools/semaphore run <template_id> # run a template\npython3 tools/semaphore status <task_id>  # check status\n```\n\nKey templates include patching, snapshots, and deployment tasks.',
    ARRAY['ansible', 'automation', 'infrastructure'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'whisper',
    'audio',
    'Voice transcription using OpenAI Whisper model (tiny, CPU-based).',
    E'## Whisper Voice Transcription\n\n**Venv:** `~/whisper-env/`\n**Model:** tiny (CPU, fast)\n\n### Usage\n```bash\n# Convert ogg to wav first\nffmpeg -i input.ogg -ar 16000 -ac 1 /tmp/voice.wav -y\n\n# Transcribe\n~/whisper-env/bin/python3 -c "\nimport whisper\nmodel = whisper.load_model(''tiny'', device=''cpu'')\nresult = model.transcribe(''/tmp/voice.wav'', language=''en'')\nprint(result[''text''])\n"\n```\n\nSupports language auto-detect or specify: `language=''en''`, `language=''pl''`',
    ARRAY['audio', 'transcription', 'voice'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'notebooklm',
    'research',
    'NotebookLM MCP integration for AI-powered notebook research and content generation.',
    E'## NotebookLM MCP\n\n**Usage via mcporter:**\n```bash\nmcporter call notebooklm.notebook_list\nmcporter call notebooklm.notebook_create title="My Research"\nmcporter call notebooklm.notebook_query notebook_id="UUID" query="What is..."\nmcporter call notebooklm.research_start query="topic" mode="fast" notebook_id="UUID"\n```\n\n### Key Patterns\n- `notebook_query` = ask about sources already IN the notebook\n- `research_start` = find NEW sources from web/Drive\n- Research workflow: `research_start` → `research_status` → `research_import`\n- Destructive ops need `confirm=true`',
    ARRAY['research', 'ai', 'mcp', 'notebooks'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'miniflux',
    'content',
    'Miniflux RSS reader API for fetching and managing RSS feeds and entries.',
    E'## Miniflux RSS Reader\n\n**URL:** Configure your Miniflux instance\n**API:** Your Miniflux URL + `/v1`\n\n### Quick API Usage\n```bash\nTOKEN="<api-token>"\ncurl -s "https://your-miniflux.example.com/v1/entries?limit=10&order=published_at&direction=desc" -H "X-Auth-Token: $TOKEN"\ncurl -s "https://your-miniflux.example.com/v1/feeds/counters" -H "X-Auth-Token: $TOKEN"\n```\n\n### Feeds\nConfigure feeds across categories: Tech News, AI & ML, Homelab, Linux, Security.',
    ARRAY['rss', 'news', 'content', 'feeds'],
    TRUE,
    1
  )
ON CONFLICT (name) DO NOTHING;

SELECT 'Initial tools seeded' AS status;
