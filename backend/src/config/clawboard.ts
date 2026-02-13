import fs from 'fs';
import path from 'path';

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

export interface PathsConfig {
  dataDir: string;
  openclawDir: string;
  mediaDir: string;
  sessionsDir: string;
}

export interface ServicesConfig {
  taskApiUrl: string;
  openclawGatewayWs: string;
  openclawApiUrl: string;
  imageGenEndpoint: string;
  imageGenProvider: string;
}

export interface DeploymentConfig {
  domain: string;
  port: number;
  useHttps: boolean;
  corsOrigin: string;
}

export interface ClawBoardConfig {
  bot: BotConfig;
  branding: BrandingConfig;
  features: FeaturesConfig;
  paths: PathsConfig;
  services: ServicesConfig;
  deployment: DeploymentConfig;
}

/**
 * Default configuration - used as fallback and for merging with partial configs
 */
const DEFAULT_CONFIG: ClawBoardConfig = {
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
  paths: {
    dataDir: '/data',
    openclawDir: '/home/user/.openclaw',
    mediaDir: '/data/media',
    sessionsDir: '/home/user/.openclaw/agents/main/sessions',
  },
  services: {
    taskApiUrl: 'http://localhost:3001/api',
    openclawGatewayWs: 'ws://localhost:3120',
    openclawApiUrl: 'http://localhost:3120',
    imageGenEndpoint: '',
    imageGenProvider: 'none',
  },
  deployment: {
    domain: 'localhost',
    port: 8082,
    useHttps: false,
    corsOrigin: 'http://localhost:8082',
  },
};

/**
 * Deep merge utility for config objects
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    
    if (sourceValue !== undefined) {
      if (
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        sourceValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue) &&
        targetValue !== null
      ) {
        result[key] = deepMerge(targetValue, sourceValue);
      } else {
        result[key] = sourceValue as any;
      }
    }
  }
  
  return result;
}

/**
 * Load ClawBoard configuration from file or use defaults
 */
function loadConfig(): ClawBoardConfig {
  const configPath = process.env.CLAWBOARD_CONFIG || './clawboard.config.json';
  
  try {
    // Try to resolve path relative to project root
    const resolvedPath = path.resolve(process.cwd(), configPath);
    
    if (!fs.existsSync(resolvedPath)) {
      console.log(`ℹ️  Config file not found at ${resolvedPath}, using defaults`);
      return DEFAULT_CONFIG;
    }
    
    const configFile = fs.readFileSync(resolvedPath, 'utf-8');
    const userConfig = JSON.parse(configFile) as Partial<ClawBoardConfig>;
    
    // Merge user config with defaults
    const mergedConfig = deepMerge(DEFAULT_CONFIG, userConfig);
    
    console.log(`✅ Loaded ClawBoard config from ${resolvedPath}`);
    return mergedConfig;
  } catch (error) {
    console.error(`⚠️  Error loading config from ${configPath}:`, error instanceof Error ? error.message : error);
    console.log('   Using default configuration');
    return DEFAULT_CONFIG;
  }
}

/**
 * Get public config (safe to send to frontend)
 * Excludes sensitive paths and service URLs
 */
export function getPublicConfig(config: ClawBoardConfig) {
  return {
    bot: config.bot,
    branding: config.branding,
    features: config.features,
  };
}

// Load config once on module import
export const clawboardConfig = loadConfig();
