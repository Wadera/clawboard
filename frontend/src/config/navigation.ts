import { 
  Home, 
  ListTodo, 
  FolderKanban, 
  BookOpen, 
  Wand2, 
  Activity, 
  BarChart3,
  Wrench,
  Radio,
  Briefcase,
  LucideIcon
} from 'lucide-react';

/**
 * Navigation configuration - Single source of truth for all navigation items.
 * Used by Sidebar and Dashboard HeroCard quick actions.
 */

/** Sidebar menu group identifiers */
export type NavGroup = 'main' | 'workspace';

export interface NavItem {
  /** Unique identifier for the nav item */
  id: string;
  /** Route path (e.g., '/tasks') */
  path: string;
  /** Display label in sidebar */
  label: string;
  /** Optional alternate label for dashboard quick actions */
  heroLabel?: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Whether to show in sidebar navigation */
  showInSidebar: boolean;
  /** Whether to show in dashboard hero quick actions */
  showInHero: boolean;
  /** Sort order (lower = first) */
  order: number;
  /** Sidebar group — 'main' (always visible) or 'workspace' (collapsible) */
  group: NavGroup;
}

/** Group metadata for rendering collapsible sections */
export interface NavGroupMeta {
  id: NavGroup;
  label: string;
  icon: LucideIcon;
  /** Whether the group is collapsible */
  collapsible: boolean;
  /** Default collapsed state */
  defaultCollapsed: boolean;
  order: number;
}

export const navGroups: NavGroupMeta[] = [
  { id: 'main', label: 'Main', icon: Home, collapsible: false, defaultCollapsed: false, order: 0 },
  { id: 'workspace', label: 'Workspace', icon: Briefcase, collapsible: true, defaultCollapsed: false, order: 1 },
];

/**
 * All navigation items in the application.
 * Add new pages here and they'll automatically appear in both sidebar and hero.
 */
export const navigationItems: NavItem[] = [
  // === Main group (always visible, not collapsible) ===
  {
    id: 'dashboard',
    path: '/',
    label: 'Dashboard',
    icon: Home,
    showInSidebar: true,
    showInHero: false,
    order: 0,
    group: 'main',
  },
  {
    id: 'sessions',
    path: '/sessions',
    label: 'Sessions',
    icon: Radio,
    showInSidebar: true,
    showInHero: true,
    order: 1,
    group: 'main',
  },
  {
    id: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    heroLabel: 'On My Mind',
    icon: ListTodo,
    showInSidebar: true,
    showInHero: true,
    order: 2,
    group: 'main',
  },
  {
    id: 'projects',
    path: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    showInSidebar: true,
    showInHero: true,
    order: 3,
    group: 'main',
  },
  {
    id: 'journal',
    path: '/journal',
    label: 'Journal',
    icon: BookOpen,
    showInSidebar: true,
    showInHero: true,
    order: 4,
    group: 'main',
  },

  // === Workspace group (collapsible) ===
  {
    id: 'images',
    path: '/images',
    label: 'Images',
    icon: Wand2,
    showInSidebar: true,
    showInHero: true,
    order: 5,
    group: 'workspace',
  },
  {
    id: 'tools',
    path: '/tools',
    label: 'Tools',
    icon: Wrench,
    showInSidebar: true,
    showInHero: true,
    order: 6,
    group: 'workspace',
  },
  {
    id: 'audit',
    path: '/audit',
    label: 'Audit Log',
    icon: Activity,
    showInSidebar: true,
    showInHero: true,
    order: 7,
    group: 'workspace',
  },
  {
    id: 'stats',
    path: '/stats',
    label: 'Stats',
    icon: BarChart3,
    showInSidebar: true,
    showInHero: true,
    order: 8,
    group: 'workspace',
  },
];

/**
 * Get navigation items for sidebar (filtered and sorted)
 */
export const getSidebarNavItems = (): NavItem[] => {
  return navigationItems
    .filter(item => item.showInSidebar)
    .sort((a, b) => a.order - b.order);
};

/**
 * Get sidebar items grouped by their NavGroup
 */
export const getSidebarGroups = (): { group: NavGroupMeta; items: NavItem[] }[] => {
  const sidebarItems = getSidebarNavItems();
  return navGroups
    .sort((a, b) => a.order - b.order)
    .map(group => ({
      group,
      items: sidebarItems.filter(item => item.group === group.id),
    }))
    .filter(g => g.items.length > 0);
};

/**
 * Get navigation items for hero quick actions (filtered and sorted)
 */
export const getHeroNavItems = (): NavItem[] => {
  return navigationItems
    .filter(item => item.showInHero)
    .sort((a, b) => a.order - b.order);
};

/**
 * Get display label for a nav item (uses heroLabel if available and in hero context)
 */
export const getNavLabel = (item: NavItem, context: 'sidebar' | 'hero' = 'sidebar'): string => {
  if (context === 'hero' && item.heroLabel) {
    return item.heroLabel;
  }
  return item.label;
};
