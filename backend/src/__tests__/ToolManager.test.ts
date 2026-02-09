// ToolManager.test.ts - Tests for tool override resolution logic
//
// Tests verify the core business logic of getEffectiveToolsForProject:
// - Global tools appear for all projects
// - Project-linked overrides replace base instructions
// - Projects with no linked tools get only globals
//
// NOTE: These tests mock the pg pool to avoid needing a real database.

import { ToolManager } from '../services/ToolManager';

// Mock the pg pool
const mockQuery = jest.fn();
jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

// Mock uuid
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

describe('ToolManager - getEffectiveToolsForProject', () => {
  let tm: ToolManager;

  beforeEach(() => {
    tm = new ToolManager();
    mockQuery.mockReset();
  });

  test('returns global tools when project has no linked tools', async () => {
    // Global tools query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'tool-1',
          name: 'task management CLI',
          category: 'task-management',
          description: 'Task CLI',
          usage_instructions: 'Use task management CLI to manage tasks',
          config: '{}',
          tags: ['cli'],
          is_global: true,
          version: 1,
        },
      ],
    });

    // Project-linked tools query (empty)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await tm.getEffectiveToolsForProject('project-1');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('task management CLI');
    expect(result[0].instructions).toBe('Use task management CLI to manage tasks');
    expect(result[0].is_global).toBe(true);
    expect(result[0].has_override).toBe(false);
  });

  test('global tool + project override → override wins', async () => {
    const globalTool = {
      id: 'tool-1',
      name: 'task management CLI',
      category: 'task-management',
      description: 'Task CLI',
      usage_instructions: 'Base instructions for task management CLI',
      config: '{}',
      tags: ['cli'],
      is_global: true,
      version: 1,
    };

    // Global tools query
    mockQuery.mockResolvedValueOnce({ rows: [globalTool] });

    // Project-linked tools query (same tool with override)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          ...globalTool,
          override_instructions: 'Custom project-specific task management CLI instructions',
        },
      ],
    });

    const result = await tm.getEffectiveToolsForProject('project-1');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('task management CLI');
    expect(result[0].instructions).toBe('Custom project-specific task management CLI instructions');
    expect(result[0].has_override).toBe(true);
  });

  test('global tool, no override → base instructions', async () => {
    const globalTool = {
      id: 'tool-1',
      name: 'imagine',
      category: 'image-generation',
      description: 'Image gen',
      usage_instructions: 'Base imagine instructions',
      config: '{}',
      tags: ['images'],
      is_global: true,
      version: 1,
    };

    // Global tools query
    mockQuery.mockResolvedValueOnce({ rows: [globalTool] });

    // Project-linked tools query (same tool, no override)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          ...globalTool,
          override_instructions: null,
        },
      ],
    });

    const result = await tm.getEffectiveToolsForProject('project-1');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('imagine');
    expect(result[0].instructions).toBe('Base imagine instructions');
    expect(result[0].has_override).toBe(false);
  });

  test('project has no tools and no globals → empty context', async () => {
    // No global tools
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // No project-linked tools
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await tm.getEffectiveToolsForProject('project-1');

    expect(result).toHaveLength(0);
  });

  test('mixes global and project-specific tools correctly', async () => {
    // Global tools
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'tool-1',
          name: 'task management CLI',
          category: 'task-management',
          description: 'Task CLI',
          usage_instructions: 'Global task management CLI instructions',
          is_global: true,
          version: 1,
        },
      ],
    });

    // Project-linked tools (a different non-global tool)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'tool-2',
          name: 'custom-deploy',
          category: 'devops',
          description: 'Deploy script',
          usage_instructions: 'Run deploy.sh',
          is_global: false,
          version: 1,
          override_instructions: null,
        },
      ],
    });

    const result = await tm.getEffectiveToolsForProject('project-1');

    expect(result).toHaveLength(2);
    const names = result.map(t => t.name);
    expect(names).toContain('task management CLI');
    expect(names).toContain('custom-deploy');
  });
});
