# TOOLS.md Auto-Generation

## Overview

The tools management system stores all tool definitions in the database.
`TOOLS.md` can be auto-generated from the database, replacing manual maintenance.

## Quick Start

```bash
# Generate to stdout
task management CLI tools generate-md

# Generate to a specific file
task management CLI tools generate-md --output /path/to/TOOLS.md

# Output raw JSON (for programmatic use)
task management CLI tools generate-md --json

# Without the auto-generated header
task management CLI tools generate-md --no-header --output TOOLS.md
```

## Standalone Script

The underlying script can also be run directly:

```bash
python3 scripts/generate-tools-md.py
python3 scripts/generate-tools-md.py --output TOOLS.md
python3 scripts/generate-tools-md.py --api-url http://localhost:3001/api
```

## Auto-Regeneration

### Option 1: Cron Job

Set up a cron job to regenerate TOOLS.md periodically:

```bash
# Every 6 hours
0 */6 * * * cd /home/clawd/clawd && python3 projects/clawboard/repo/scripts/generate-tools-md.py --output TOOLS.md 2>/dev/null
```

### Option 2: Post-Change Hook

After creating/updating/deleting tools via `task management CLI tools`, run:

```bash
task management CLI tools add "my-tool" --category dev --description "..." && task management CLI tools generate-md -o TOOLS.md
```

### Option 3: Backend Webhook (Future)

A future enhancement could add a webhook that triggers regeneration
whenever tools are created, updated, or deleted via the API. This would
be implemented as middleware on the tools routes that calls the script
or publishes an event.

## Output Format

The generated markdown includes:
- Header with generation timestamp and tool count
- Table of contents grouped by category
- Each tool section with:
  - Name and badges (global, tags)
  - Description
  - Usage instructions (preserved as-is from DB)
- Category-based grouping with alphabetical sorting

## Managing Tools

```bash
# List all tools
task management CLI tools list

# Add a new tool
task management CLI tools add "my-tool" --category dev --description "A dev tool" --instructions "Run it with..."

# Update tool instructions
task management CLI tools update "my-tool" --instructions "Updated usage..."

# Link a tool to a project
task management CLI tools link my-project my-tool

# Preview effective tools for a project (global + linked)
task management CLI tools context my-project
```
