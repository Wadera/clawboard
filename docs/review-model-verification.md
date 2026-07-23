# Review handoff and model-default verification

## Verified now

### Model-default fix
- UI task model pickers now show canonical configured/default-oriented values instead of legacy `sonnet/opus` aliases.
- Backend `/tasks/:id/spawn-prompt` and `/tasks/:id/spawn-agent` normalize legacy task values:
  - `sonnet` -> `anthropic/claude-sonnet-4-5`
  - `opus` -> `openai-codex/gpt-5.4`
  - `sonnet-1m` -> `anthropic/claude-sonnet-4-5`
  - `opus-1m` -> `openai-codex/gpt-5.4`
- CLI help/examples now use canonical model ids and describe GPT-5.4 as the effective default.

### Review handoff fix
- CLI examples now use `clawboard review TASK_ID` for normal successful agent handoff.
- Generated project brief text now instructs agents to move tasks to `review`, and reserves `stuck` for real blockers or ambiguous human intervention.
- `docs/PROJECT-OVERVIEW.md` now describes the same lifecycle.

## Command-level proof collected in this run
- `python3 -m py_compile cli/clawboard` passed.
- Grep confirmed stale `stuck` completion guidance was removed from:
  - `cli/clawboard`
  - `backend/src/routes/projects.ts`
  - `docs/PROJECT-OVERVIEW.md`
- Live task workflow proof:
  - task `2c427717` was moved back to `in-progress`
  - rejected subtasks were re-opened and worked again
  - canonical handoff used `clawboard review 2c427717`

## Known bounded verification gaps

### Reviewer route still failing in running stack
Attempted:

```bash
python3 /home/clawd/clawd/projects/clawboard-nim/repo/cli/clawboard review 2c427717 --run-reviewer
```

Observed result:
- HTTP 404
- path: `/tasks/reviewer/2c427717-7af0-4ae5-ae34-8c5d98f358a4/run`

Interpretation:
- automated reviewer verification is not complete in the currently running environment
- this is a runtime/backend routing gap, not something proven fixed by the doc/copy changes above

### Jest not runnable locally in current environment
Attempted:

```bash
cd backend && npx jest --runInBand src/__tests__/ReviewHandoffService.test.ts
```

Observed result:
- `Preset ts-jest not found.`

Interpretation:
- local automated test verification is blocked by missing test preset/runtime dependency
- do not claim full backend test verification until `ts-jest` is installed/configured or an equivalent runnable test path is restored

## What remains to fully close verification
1. Fix or expose the reviewer route in the running backend so `clawboard review --run-reviewer` returns a non-404 result.
2. Restore runnable backend tests by installing/configuring `ts-jest` or updating Jest config to the current toolchain.
3. Optionally add a focused integration test for spawn effective-model resolution plus a reviewer handoff test covering `review` vs `stuck` semantics.
