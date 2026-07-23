import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface ModelSwitchState {
  isSwitching: boolean;
  targetModel: string | null;
  error: string | null;
}

interface ModelSwitchContextValue {
  state: ModelSwitchState;
  startSwitch: (modelId: string) => void;
  completeSwitch: (success: boolean, error?: string) => void;
}

const ModelSwitchContext = createContext<ModelSwitchContextValue | null>(null);

export function ModelSwitchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModelSwitchState>({
    isSwitching: false,
    targetModel: null,
    error: null,
  });

  const startSwitch = useCallback((modelId: string) => {
    setState({
      isSwitching: true,
      targetModel: modelId,
      error: null,
    });
  }, []);

  const completeSwitch = useCallback((success: boolean, error?: string) => {
    setState(prev => ({
      isSwitching: false,
      targetModel: success ? null : prev.targetModel,
      error: success ? null : (error || 'Switch failed'),
    }));
    
    // Clear error after 5 seconds
    if (!success) {
      setTimeout(() => {
        setState(prev => ({ ...prev, error: null }));
      }, 5000);
    }
  }, []);

  return (
    <ModelSwitchContext.Provider value={{ state, startSwitch, completeSwitch }}>
      {children}
    </ModelSwitchContext.Provider>
  );
}

export function useModelSwitch() {
  const context = useContext(ModelSwitchContext);
  if (!context) {
    throw new Error('useModelSwitch must be used within ModelSwitchProvider');
  }
  return context;
}

// Export the context for optional use
export { ModelSwitchContext };
