import { 
  Home, 
  ListTodo, 
  FolderKanban, 
  BookOpen, 
  Wand2, 
  Activity, 
  BarChart3,
  Wrench,
  LucideIcon
} from 'lucide-react';

/**
 * Navigation configuration - Single source of truth for all navigation items.
 * Used by Sidebar and Dashboard HeroCard quick actions.
 */

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
}

/**
 * All navigation items in the application.
 * Add new pages here and they'll automatically appear in both sidebar and hero.
 */
export const navigationItems: NavItem[] = [
  {
    id: 'dashboard',
    path: '/',
    label: 'Dashboard',
    icon: Home,
    showInSidebar: true,
    showInHero: false, // Already on dashboard, no need to link to it
    order: 0,
  },
  {
    id: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    heroLabel: 'On My Mind', // Different label for hero
    icon: ListTodo,
    showInSidebar: true,
    showInHero: true,
    order: 1,
  },
  {
    id: 'projects',
    path: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    showInSidebar: true,
    showInHero: true,
    order: 2,
  },
  {
    id: 'journal',
    path: '/journal',
    label: 'Journal',
    icon: BookOpen,
    showInSidebar: true,
    showInHero: true,
    order: 3,
  },
  {
    id: 'images',
    path: '/images',
    label: 'Images',
    icon: Wand2,
    showInSidebar: true,
    showInHero: true,
    order: 4,
  },
  {
    id: 'tools',
    path: '/tools',
    label: 'Tools',
    icon: Wrench,
    showInSidebar: true,
    showInHero: true,
    order: 5,
  },
  {
    id: 'audit',
    path: '/audit',
    label: 'Audit Log',
    icon: Activity,
    showInSidebar: true,
    showInHero: true,
    order: 6,
  },
  {
    id: 'stats',
    path: '/stats',
    label: 'Stats',
    icon: BarChart3,
    showInSidebar: true,
    showInHero: true,
    order: 7,
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
