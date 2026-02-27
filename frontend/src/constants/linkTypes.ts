import { GitBranch, FileText, Globe, Box, Link as LinkIcon, Wrench, Database, Calendar } from 'lucide-react';

/**
 * Unified link type definitions used across the dashboard
 * BUG-006 fix: Single source of truth for link types and categories
 */

// All possible link types (superset)
export const LINK_TYPES = [
  'git',
  'doc',
  'url',
  'api',
  'project',
  'dashboard',
  'notebooklm',
  'file',
  'tool',
  'memory',
  'session'
] as const;

// Project-specific link types
export const PROJECT_LINK_TYPES = [
  'git',
  'doc',
  'url',
  'api',
  'project',
  'dashboard',
  'notebooklm',
  'file'
] as const;

// Task-specific link types
export const TASK_LINK_TYPES = [
  'project',
  'tool',
  'git',
  'doc',
  'memory',
  'session'
] as const;

// Link categories
export const LINK_CATEGORIES = [
  'repository',
  'environment',
  'documentation',
  'research',
  'reference',
  'tool'
] as const;

export type LinkType = typeof LINK_TYPES[number];
export type ProjectLinkType = typeof PROJECT_LINK_TYPES[number];
export type TaskLinkType = typeof TASK_LINK_TYPES[number];
export type LinkCategory = typeof LINK_CATEGORIES[number];

// Type metadata: labels and icons
export const LINK_TYPE_METADATA: Record<LinkType, { label: string; icon: any }> = {
  git: { label: 'Git Repository', icon: GitBranch },
  doc: { label: 'Documentation', icon: FileText },
  url: { label: 'URL', icon: Globe },
  api: { label: 'API', icon: Box },
  project: { label: 'Project', icon: LinkIcon },
  dashboard: { label: 'Dashboard', icon: Globe },
  notebooklm: { label: 'NotebookLM', icon: FileText },
  file: { label: 'File', icon: FileText },
  tool: { label: 'Tool', icon: Wrench },
  memory: { label: 'Memory', icon: Database },
  session: { label: 'Session', icon: Calendar }
};

// Category metadata
export const LINK_CATEGORY_METADATA: Record<LinkCategory, { label: string }> = {
  repository: { label: 'Repository' },
  environment: { label: 'Environment' },
  documentation: { label: 'Documentation' },
  research: { label: 'Research' },
  reference: { label: 'Reference' },
  tool: { label: 'Tool' }
};

// Helper functions
export function getLinkTypeLabel(type: LinkType): string {
  return LINK_TYPE_METADATA[type]?.label || type;
}

export function getLinkTypeIcon(type: LinkType): any {
  return LINK_TYPE_METADATA[type]?.icon || Globe;
}

export function getLinkCategoryLabel(category: LinkCategory): string {
  return LINK_CATEGORY_METADATA[category]?.label || category;
}

export function isProjectLinkType(type: string): type is ProjectLinkType {
  return (PROJECT_LINK_TYPES as readonly string[]).includes(type);
}

export function isTaskLinkType(type: string): type is TaskLinkType {
  return (TASK_LINK_TYPES as readonly string[]).includes(type);
}
