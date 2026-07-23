# Execution Profiles

Task execution profiles define how ClawBoard should run agent work without relying on fragile cron-session assumptions.

## Goals

- keep task spawn behavior explicit
- separate run mode from access requirements
- preserve backward compatibility with existing `executionMode` and capability tags
- allow safe gradual rollout across frontend, backend, and CLI

## Data Model

Tasks may now store a structured `executionProfile` alongside legacy `executionMode`.

```json
{
  "mode": "interactive",
  "accessProfile": "homelab",
  "requiredCapabilities": ["network", "long-running"],
  "allowOverrideAtSpawn": true,
  "notes": "Use interactive ACP for homelab tasks that may need steering"
}
```

### Fields

- `mode`: `main | subagent | interactive`
- `accessProfile`: `safe | dev | network | homelab | browser | elevated`
- `requiredCapabilities`: extra capability requirements merged with derived profile capabilities
- `allowOverrideAtSpawn`: whether orchestrator spawn-time overrides are allowed
- `notes`: optional human guidance

## Access Profile Defaults

| Access profile | Derived capabilities |
|---|---|
| `safe` | none |
| `dev` | none |
| `network` | `network` |
| `homelab` | `network`, `long-running` |
| `browser` | `browser` |
| `elevated` | `elevated`, `network` |

## Backward Compatibility

During rollout:

- `executionMode` remains supported
- legacy capability tags still work
- backend hydrates `executionMode` from `executionProfile.mode` when needed
- spawn policy merges profile-derived capabilities with legacy task tags as fallback

## Spawn-Time Override Behavior

If `allowOverrideAtSpawn !== false`, orchestrator spawn requests may override:

- `model`
- `thinking`
- `executionMode`
- `accessProfile`
- `requiredCapabilities`
- interactive request flag

If `allowOverrideAtSpawn === false`, spawn uses the saved task profile and ignores runtime override attempts for those fields.

## Validation Rules

Backend normalization currently enforces:

- valid `mode`
- valid `accessProfile`
- `requiredCapabilities` must be an array
- capabilities must be from the approved set
- profile capabilities are merged and deduplicated
- `allowOverrideAtSpawn` defaults to `true`
- blank notes are dropped

Invalid execution-profile input returns HTTP 400.

## Migration Notes

1. Existing tasks with only `executionMode` still work.
2. New UI writes both `executionMode` and structured `executionProfile`.
3. CLI create/update/get supports structured execution profiles.
4. Spawn paths now resolve policy from `executionProfile` first, then fall back to legacy tags/mode.
5. Final cleanup later can remove legacy-only paths once all task producers and readers use `executionProfile` consistently.

## Remaining Cleanup

- align stale-task detection with main-session work so `no_process` is not treated as agent failure
- decide whether spawn-policy mapping should be marked complete separately from override behavior
- remove stale rejected notes from subtasks that were later genuinely completed
