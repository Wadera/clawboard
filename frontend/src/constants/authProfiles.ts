/**
 * Auth profile display name mapping
 * Maps OpenClaw auth profile keys to human-readable names and status
 */

export interface ProfileInfo {
  name: string;
  primary: boolean;
}

export const PROFILE_NAMES: Record<string, ProfileInfo> = {
  'user-claude-max': { name: 'User Max', primary: true },
  'walter-claude-max-backup': { name: 'Walter Backup', primary: false },
};

/**
 * Get friendly display name for an auth profile
 * Falls back to the raw profile key if not in mapping
 */
export function getProfileDisplayName(profileKey: string): string {
  return PROFILE_NAMES[profileKey]?.name || profileKey;
}

/**
 * Check if a profile is a primary (non-fallback) profile
 */
export function isPrimaryProfile(profileKey: string): boolean {
  return PROFILE_NAMES[profileKey]?.primary ?? true; // Default to primary if unknown
}
