import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { ClawBoardPublicConfig, DEFAULT_CONFIG, fetchConfig } from '../config/clawboard';

interface ClawBoardConfigContextType {
  config: ClawBoardPublicConfig;
  loading: boolean;
  error: Error | null;
}

const ClawBoardConfigContext = createContext<ClawBoardConfigContextType>({
  config: DEFAULT_CONFIG,
  loading: true,
  error: null,
});

export function useClawBoardConfig() {
  return useContext(ClawBoardConfigContext);
}

interface ClawBoardConfigProviderProps {
  children: ReactNode;
}

export function ClawBoardConfigProvider({ children }: ClawBoardConfigProviderProps) {
  const [config, setConfig] = useState<ClawBoardPublicConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function loadConfig() {
      try {
        const fetchedConfig = await fetchConfig();
        setConfig(fetchedConfig);
        
        // Apply CSS variables from config
        if (fetchedConfig.branding) {
          document.documentElement.style.setProperty('--config-primary', fetchedConfig.branding.primaryColor);
          document.documentElement.style.setProperty('--config-accent', fetchedConfig.branding.accentColor);
          document.documentElement.style.setProperty('--config-bg', fetchedConfig.branding.backgroundColor);
          document.documentElement.style.setProperty('--config-surface', fetchedConfig.branding.surfaceColor);
          document.documentElement.style.setProperty('--config-text', fetchedConfig.branding.textColor);
        }
        
        setLoading(false);
      } catch (err) {
        console.error('Error loading config:', err);
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }

    loadConfig();
  }, []);

  return (
    <ClawBoardConfigContext.Provider value={{ config, loading, error }}>
      {children}
    </ClawBoardConfigContext.Provider>
  );
}
