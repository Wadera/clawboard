-- ClawBoard Database Seed Data
-- Optional: Run after init.sql to populate with example data
-- Usage: psql -U clawboard -d clawboard -f seed.sql

-- Insert sample bot status updates
INSERT INTO bot_status (mood, status_text, avatar_url) VALUES
('happy', 'Exploring new possibilities', NULL),
('focused', 'Deep diving into code', NULL),
('creative', 'Building something amazing', NULL);

-- Insert sample projects
INSERT INTO projects (id, name, description, status, source_dir, nfs_dir, is_hidden) VALUES
(
    'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890',
    'Sample Project',
    'A sample project to demonstrate ClawBoard features',
    'active',
    '/project-sources/sample-project',
    'sample-project',
    false
),
(
    'b2c3d4e5-f6a7-4890-b1c2-d3e4f5a67891',
    'Documentation',
    'Project documentation and guides',
    'active',
    NULL,
    'documentation',
    false
);

-- Insert sample project links
INSERT INTO project_links (project_id, type, title, url) VALUES
(
    'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890',
    'git',
    'Repository',
    'https://github.com/username/sample-project'
),
(
    'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890',
    'doc',
    'Documentation',
    'https://docs.example.com/sample-project'
),
(
    'b2c3d4e5-f6a7-4890-b1c2-d3e4f5a67891',
    'url',
    'Wiki',
    'https://wiki.example.com'
);

-- Insert sample tasks
INSERT INTO tasks (
    id,
    title,
    description,
    status,
    priority,
    tags,
    project_id,
    auto_created,
    auto_start
) VALUES
(
    'c3d4e5f6-a789-401b-c2d3-e4f5a6789012',
    'Setup development environment',
    'Install dependencies and configure development tools',
    'completed',
    'high',
    ARRAY['setup', 'devops'],
    'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890',
    false,
    true
),
(
    'd4e5f6a7-8901-402c-d3e4-f5a678901234',
    'Implement user authentication',
    'Add JWT-based authentication for API endpoints',
    'in-progress',
    'high',
    ARRAY['backend', 'security'],
    'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890',
    false,
    true
),
(
    'e5f6a789-0123-403d-e4f5-a67890123456',
    'Design dashboard UI',
    'Create mockups and wireframes for the main dashboard',
    'todo',
    'medium',
    ARRAY['frontend', 'design'],
    'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890',
    false,
    true
),
(
    'f6a78901-2345-404e-f5a6-789012345678',
    'Write API documentation',
    'Document all REST API endpoints with examples',
    'todo',
    'low',
    ARRAY['documentation'],
    'b2c3d4e5-f6a7-4890-b1c2-d3e4f5a67891',
    false,
    true
),
(
    'a789012b-3456-405f-a678-901234567890',
    'Research GraphQL integration',
    'Explore possibilities for GraphQL API layer',
    'ideas',
    'low',
    ARRAY['research', 'backend'],
    NULL,
    false,
    false
);

-- Insert sample task history
INSERT INTO task_history (task_id, event_type, old_value, new_value, note) VALUES
(
    'c3d4e5f6-a789-401b-c2d3-e4f5a6789012',
    'status_change',
    'todo',
    'in-progress',
    'Started working on setup'
),
(
    'c3d4e5f6-a789-401b-c2d3-e4f5a6789012',
    'status_change',
    'in-progress',
    'completed',
    'Setup complete and verified'
),
(
    'd4e5f6a7-8901-402c-d3e4-f5a678901234',
    'status_change',
    'todo',
    'in-progress',
    'Implementing JWT middleware'
);

-- Insert sample agents (sub-agents)
INSERT INTO agents (id, name, status, task, spawned_at, completed_at) VALUES
(
    'b234c567-d890-401e-f123-456789abcdef',
    'setup-agent',
    'completed',
    'Setup development environment',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '1 hour'
),
(
    'c345d678-e901-402f-a234-567890bcdefg',
    'auth-agent',
    'running',
    'Implement user authentication',
    NOW() - INTERVAL '30 minutes',
    NULL
);

-- Insert sample thoughts (chain of thought logs)
INSERT INTO thoughts (agent_id, task_id, entry_type, content, metadata) VALUES
(
    'b234c567-d890-401e-f123-456789abcdef',
    'c3d4e5f6-a789-401b-c2d3-e4f5a6789012',
    'reasoning',
    'Need to install Node.js dependencies and configure environment variables',
    '{"step": 1}'::jsonb
),
(
    'b234c567-d890-401e-f123-456789abcdef',
    'c3d4e5f6-a789-401b-c2d3-e4f5a6789012',
    'tool_call',
    'Running: npm install',
    '{"command": "npm install", "cwd": "/workspace/project"}'::jsonb
),
(
    'b234c567-d890-401e-f123-456789abcdef',
    'c3d4e5f6-a789-401b-c2d3-e4f5a6789012',
    'result',
    'Successfully installed 127 packages',
    '{"step": 2, "success": true}'::jsonb
),
(
    'c345d678-e901-402f-a234-567890bcdefg',
    'd4e5f6a7-8901-402c-d3e4-f5a678901234',
    'reasoning',
    'Planning JWT implementation: generate secret, create middleware, protect routes',
    '{"step": 1}'::jsonb
);

-- Seed data complete
SELECT 'Seed data inserted successfully' AS status;
SELECT 
    (SELECT COUNT(*) FROM projects) AS projects,
    (SELECT COUNT(*) FROM tasks) AS tasks,
    (SELECT COUNT(*) FROM agents) AS agents,
    (SELECT COUNT(*) FROM thoughts) AS thoughts;
