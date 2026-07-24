import { TASK_CAPABILITY_TAGS, TaskAccessProfile, TaskCapability, TaskExecutionHarness, TaskExecutionMode, TaskPlanningMode } from '../types/task';

export const TASK_EXECUTION_MODE_OPTIONS: { value: TaskExecutionMode; label: string }[] = [
  { value: 'main', label: 'Run in main session' },
  { value: 'interactive', label: 'Interactive steering session' },
  { value: 'subagent', label: 'One-shot spawned agent' },
];

export const TASK_EXECUTION_HARNESS_OPTIONS: { value: TaskExecutionHarness; label: string; hint: string }[] = [
  { value: 'openclaw', label: 'OpenClaw', hint: 'OpenClaw-compatible executor and session flow.' },
  { value: 'hermes', label: 'Hermes', hint: 'Hermes-native executor with skills and tool browsing.' },
];

export const TASK_PLANNING_MODE_OPTIONS: { value: TaskPlanningMode; label: string; hint: string }[] = [
  { value: 'fixed', label: 'Fixed plan', hint: 'Follow the existing task structure strictly.' },
  { value: 'refine', label: 'Refine plan', hint: 'Improve or split subtasks when helpful, but stay close to the existing plan.' },
  { value: 'adaptive', label: 'Adaptive plan', hint: 'Create or refine subtasks based on findings during research or investigation work.' },
];

export const TASK_ACCESS_PROFILE_OPTIONS: { value: TaskAccessProfile; label: string; hint: string }[] = [
  { value: 'safe', label: 'Safe', hint: 'Local workspace only, minimal access.' },
  { value: 'dev', label: 'Dev', hint: 'Normal coding and repository work.' },
  { value: 'network', label: 'Network', hint: 'Outbound network and internal APIs.' },
  { value: 'homelab', label: 'Homelab', hint: 'SSH/LAN/API access to trusted homelab systems.' },
  { value: 'browser', label: 'Browser', hint: 'Browser or host-browser driven tasks.' },
  { value: 'elevated', label: 'Elevated', hint: 'May require privileged commands and approvals.' },
];

export const TASK_ACCESS_PROFILE_LABELS: Record<TaskAccessProfile, string> = {
  safe: '🟢 Safe',
  dev: '🔵 Dev',
  network: '🌐 Network',
  homelab: '🏠 Homelab',
  browser: '🧭 Browser',
  elevated: '🔐 Elevated',
};

export const TASK_PROFILE_CAPABILITIES: Record<TaskAccessProfile, TaskCapability[]> = {
  safe: [],
  dev: [],
  network: ['network'],
  homelab: ['network', 'long-running'],
  browser: ['browser'],
  elevated: ['elevated', 'network'],
};

export const TASK_CAPABILITY_OPTIONS = TASK_CAPABILITY_TAGS;

export function getExtraTaskCapabilities(
  accessProfile: TaskAccessProfile,
  capabilities: readonly string[] = [],
): TaskCapability[] {
  const derived = new Set<string>(TASK_PROFILE_CAPABILITIES[accessProfile] || []);
  return capabilities.filter(
    (capability): capability is TaskCapability =>
      TASK_CAPABILITY_TAGS.includes(capability as TaskCapability) && !derived.has(capability),
  );
}
