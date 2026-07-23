import { createContext, useContext, useMemo, useState } from 'react';
import { MindscapePanel } from '../components/MindscapePanel';

type MindscapeUiContextValue = {
  openMindscape: () => void;
  closeMindscape: () => void;
};

const MindscapeUiContext = createContext<MindscapeUiContextValue | null>(null);

export function MindscapeUiProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({
    openMindscape: () => setOpen(true),
    closeMindscape: () => setOpen(false),
  }), []);

  return (
    <MindscapeUiContext.Provider value={value}>
      {children}
      <MindscapePanel open={open} onClose={value.closeMindscape} />
    </MindscapeUiContext.Provider>
  );
}

export function useMindscapeUi(): MindscapeUiContextValue {
  const value = useContext(MindscapeUiContext);
  if (!value) throw new Error('useMindscapeUi must be used within MindscapeUiProvider');
  return value;
}
