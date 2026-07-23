-- Migration 012: Seed additional tools from TOOLS.md not covered in 011
-- Adds: homelab-snapshots, browser-automation, tts-voice, web-search, rss-bridge, clawboard

INSERT INTO tools (id, name, category, description, usage_instructions, tags, is_global, version)
VALUES
  (
    gen_random_uuid(),
    'homelab-snapshots',
    'devops',
    'Proxmox VM snapshot automation via Ansible for safe rollbacks before risky changes.',
    E'## Homelab Snapshots\n\n**⚠️ ALWAYS snapshot before risky system changes!**\n\n**Location:** Configure your Ansible playbook path\n\n### Command\n```bash\nansible-playbook -i inventory create_snapshot.yml \\\n  --vault-password-file=~/.ansible/vault_pass \\\n  -e "snapshot_description=''Before changes''"\n```\n\n### Details\n- Configure your VM ID in the playbook\n- Auto-named: `ans-YYYYMMDDHHMMSS`\n- Takes ~2-5 minutes\n\n### When to Snapshot\n- Before disk operations (resize, mount changes, fstab edits)\n- Before major package installations\n- Before config changes that might break boot\n- Before kernel or driver updates',
    ARRAY['proxmox', 'ansible', 'backup', 'infrastructure'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'browser-automation',
    'automation',
    'Headless Chrome browser automation via Playwright for web scraping, screenshots, and UI testing.',
    E'## Browser Automation\n\n**Setup:**\n- Google Chrome (`/usr/bin/google-chrome-stable`)\n- Playwright installed globally\n- Headless mode with screenshot capability\n\n**Capabilities:**\n- ✅ Open any website\n- ✅ Take screenshots (full page or elements)\n- ✅ Click buttons, fill forms\n- ✅ Navigate and interact with web apps\n\n**Usage:** Use the `browser` tool from the OpenClaw toolkit.',
    ARRAY['browser', 'playwright', 'chrome', 'screenshots'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'tts-voice',
    'audio',
    'Text-to-speech voice note generation and delivery via Discord/messaging.',
    E'## Voice Notes (TTS)\n\n### How to send voice notes\n1. Generate audio with `tts` tool:\n```\ntts(text="Your message here", channel="discord")\n```\n→ Returns `MEDIA:/tmp/tts-xxx/voice-xxx.mp3`\n\n2. Send via `message` tool with `filePath`:\n```\nmessage(action="send", target="channel:ID", filePath="/tmp/tts-xxx/voice-xxx.mp3")\n```\n\n**⚠️ DO NOT use `MEDIA:/absolute/path` in replies — blocked for security!**\nFor local files, always use the `message` tool with `filePath`.',
    ARRAY['tts', 'voice', 'audio', 'speech'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'web-search',
    'research',
    'SearXNG self-hosted meta search engine for privacy-respecting web searches.',
    E'## Web Search (SearXNG)\n\nSelf-hosted SearXNG instance for web searching.\nUse the `web_fetch` tool for fetching and reading web content.\nFor broader searches, use SearXNG API or browser automation.',
    ARRAY['search', 'web', 'searxng'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'rss-bridge',
    'content',
    'RSS-Bridge instance for generating RSS feeds from websites that dont natively support them.',
    E'## RSS-Bridge\n\n**URL:** Configure your RSS-Bridge instance\n**Docker:** Can be deployed alongside other services\n**Bridges:** Whitelist bridges you need (Reddit, GitHub, HackerNews, etc.)\n\nUse to generate RSS feeds for sites without native RSS support.',
    ARRAY['rss', 'feeds', 'content', 'bridge'],
    TRUE,
    1
  )
ON CONFLICT (name) DO NOTHING;

SELECT 'Additional tools seeded' AS status;
