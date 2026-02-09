import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import { authenticatedFetch } from '../utils/auth';

export interface StatusUpdate {
  main: {
    state: 'idle' | 'thinking' | 'typing' | 'tool-use' | 'waiting' | 'error';
    detail: string;
    tools: string[];
  };
  agents: Array<{
    key: string;
    label: string;
    state: 'running' | 'idle' | 'completed';
    updatedAt: number;
  }>;
  agentCount: number;
  stats: {
    messageCount: number;
    toolsUsed: number;
  };
  timestamp: number;
}

export function useRealtimeStatus() {
  const [status, setStatus] = useState<StatusUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { subscribe, connected } = useWebSocket();

  // Fetch initial status via REST
  useEffect(() => {
    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
    
    async function fetchInitialStatus() {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/status`);
        const data = await response.json();
        
        const statusUpdate: StatusUpdate = {
          main: {
            state: data.status === 'working' ? 'waiting' : 'idle',
            detail: data.details || 'Connecting to real-time status...',
            tools: []
          },
          agents: [],
          agentCount: data.subAgents || 0,
          stats: { messageCount: 0, toolsUsed: 0 },
          timestamp: Date.now()
        };
        
        setStatus(statusUpdate);
      } catch (err) {
        console.error('Failed to fetch initial status:', err);
      }
    }
    
    fetchInitialStatus();
  }, []);

  // Subscribe to status-update events
  const handleStatusUpdate = useCallback((message: any) => {
    setStatus(message.data);
  }, []);

  const handleModelStatus = useCallback((message: any) => {
    window.dispatchEvent(new CustomEvent('model:status', { detail: message.data }));
  }, []);

  const handleFilesUpdated = useCallback((message: any) => {
    window.dispatchEvent(new CustomEvent('workspace:files-updated', { detail: message.data }));
  }, []);

  const handleError = useCallback((message: any) => {
    setError(message.error);
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe('status-update', handleStatusUpdate),
      subscribe('model:status', handleModelStatus),
      subscribe('workspace:files-updated', handleFilesUpdated),
      subscribe('error', handleError),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [subscribe, handleStatusUpdate, handleModelStatus, handleFilesUpdated, handleError]);

  return { status, connected, error };
}
