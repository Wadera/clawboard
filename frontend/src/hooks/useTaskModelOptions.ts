import { useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '../utils/auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

interface ModelStatusModelEntry {
  id: string;
  provider?: string;
  alias?: string;
}

interface ModelStatusResponse {
  preferredDefaultModel?: string;
  preferredDefaultModelAlias?: string;
  defaultModel?: string;
  defaultModelAlias?: string;
  models?: {
    available?: ModelStatusModelEntry[];
  };
}

export interface TaskModelOption {
  value: string;
  label: string;
}

function formatModelLabel(model: ModelStatusModelEntry | string): string {
  if (typeof model === 'string') {
    return model;
  }

  const alias = model.alias?.trim();
  if (alias && alias !== model.id) {
    return `${alias} (${model.id})`;
  }

  return model.id;
}

function buildOptions(data: ModelStatusResponse | null, currentModel?: string): TaskModelOption[] {
  const preferredLabel = data?.preferredDefaultModelAlias || data?.defaultModelAlias || data?.preferredDefaultModel || data?.defaultModel || 'configured default';
  const options: TaskModelOption[] = [{ value: '', label: `Default (${preferredLabel})` }];
  const seen = new Set<string>(['']);

  for (const model of data?.models?.available || []) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    options.push({ value: model.id, label: formatModelLabel(model) });
  }

  if (currentModel && !seen.has(currentModel)) {
    options.push({ value: currentModel, label: `${formatModelLabel(currentModel)} (legacy/unavailable)` });
  }

  return options;
}

export function useTaskModelOptions(currentModel?: string) {
  const [status, setStatus] = useState<ModelStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchModels = async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE}/models/status`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data?.success !== false) {
          setStatus(data);
        }
      } catch {
        // Silent fallback to current value only.
      }
    };

    fetchModels();

    const handleRealtimeUpdate = (event: Event) => {
      const detail = (event as CustomEvent<ModelStatusResponse>).detail;
      if (!cancelled && detail) {
        setStatus(detail);
      }
    };

    window.addEventListener('model:status', handleRealtimeUpdate as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener('model:status', handleRealtimeUpdate as EventListener);
    };
  }, []);

  const modelOptions = useMemo(() => buildOptions(status, currentModel), [status, currentModel]);

  return { modelOptions, modelStatus: status };
}
