export interface BotConfig {
  name: string;
  displayName: string;
  emoji: string;
  description: string;
  avatarUrl: string;
}

export interface BrandingConfig {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  sidebarTitle: string;
  loginTitle: string;
  loginSubtitle: string;
}

export interface FeaturesConfig {
  journal: boolean;
  imageGeneration: boolean;
  taskBoard: boolean;
  projects: boolean;
  tools: boolean;
  sessions: boolean;
  auditLog: boolean;
  stats: boolean;
  botStatus: boolean;
  avatarPage: boolean;
}

export interface ClawBoardPublicConfig {
  bot: BotConfig;
  branding: BrandingConfig;
  features: FeaturesConfig;
}

/**
 * Default configuration - used as fallback if API is unavailable
 */
export const DEFAULT_CONFIG: ClawBoardPublicConfig = {
  bot: {
    name: 'ClawBot',
    displayName: 'My ClawBoard',
    emoji: '🤖',
    description: 'My OpenClaw Dashboard',
    avatarUrl: '/assets/avatar-placeholder.png',
  },
  branding: {
    primaryColor: '#6366f1',
    accentColor: '#8b5cf6',
    backgroundColor: '#0f172a',
    surfaceColor: '#1e293b',
    textColor: '#e2e8f0',
    sidebarTitle: 'ClawBoard',
    loginTitle: 'Welcome to ClawBoard',
    loginSubtitle: 'Your AI Dashboard',
  },
  features: {
    journal: true,
    imageGeneration: false,
    taskBoard: true,
    projects: true,
    tools: true,
    sessions: true,
    auditLog: true,
    stats: true,
    botStatus: true,
    avatarPage: true,
  },
};

/**
 * Fetch configuration from backend API
 */
export async function fetchConfig(): Promise<ClawBoardPublicConfig> {
  try {
    const response = await fetch('/config');
    
    if (!response.ok) {
      console.warn('Failed to fetch config from API, using defaults');
      return DEFAULT_CONFIG;
    }
    
    const config = await response.json();
    return config;
  } catch (error) {
    console.error('Error fetching config:', error);
    return DEFAULT_CONFIG;
  }
}
