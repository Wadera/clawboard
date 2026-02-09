import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface BotStatus {
  id: string;
  mood: string;
  status_text: string;
  avatar_url: string | null;
  updated_at: string;
}

export function useBotStatus() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStatus();
    
    // Refresh every 60 seconds
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/bot-status/current`);
      if (!response.ok) {
        if (response.status === 404) {
          setStatus(null);
          setError('No status available');
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      if (data.success && data.status) {
        setStatus(data.status);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to fetch bot status:', err);
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  };

  return { status, loading, error, refetch: fetchStatus };
}
