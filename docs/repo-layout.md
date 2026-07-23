# ClawBoard repository layout — canonical paths

_Last updated: 2026-07-23 (convergence-20260723)._

## The live checkouts

| Path | Branch | Role |
|---|---|---|
| `/srv/ai-stack/projects/nimspace/clawboard/repo` | `main` | Working checkout of main. **NOT a production build source** — see the deploy rule below. |
| `/srv/ai-stack/projects/nimspace/clawboard/dev` | `dev` | **Dev worktree** (of the same repo). All implementation happens here; dev stack builds via `docker-compose.dev.yml`. |
| `…/clawboard/worktrees/4abab434-prod-deploy` | `main` (exact `origin/main`) | **Dedicated deployment clone.** The ONLY directory production images are ever built from, and only via the wrapper. |

Origin: `ssh://git@git.skyday.eu:222/nim/ClawBoard-Nim.git`.

## THE ONE PRODUCTION DEPLOY RULE

Production is deployed **exclusively** with:

```bash
sudo /usr/local/sbin/clawboard-deploy-main <origin-main-sha>
```

The wrapper fast-forwards the dedicated deployment clone to exact
`origin/main`, refuses tracked or non-runtime untracked changes, tags rollback
images, bakes release provenance (`/release-manifest.json` + OCI labels) into
both images, and deploys backend + frontend together. Its versioned source is
`scripts/clawboard-deploy-main` in this repository.

**Never** run `docker compose -f docker-compose.prod.yml build/up` by hand
against production, and never build production images from `/repo`, the dev
worktree, or task worktrees. That path is how production drifted from
canonical main (audit report `39fdf0e9`, 2026-07-23).

## Rules

1. **No new long-lived checkouts.** Task work happens on branches inside the
   dev worktree (or short-lived worktrees that are removed the same week —
   `git worktree remove` when done, `git worktree prune` for strays).
2. **No NFS mirrors.** The remote (Gitea) is the backup of record; DB dumps and
   salvage bundles go to `/mnt/nfs/NimsProjects/backups/`. Historical mirrors
   (`NimsProjects/clawboard*`) were audited and retired 2026-07-04 — unique
   content lives in `backups/clawboard-cleanup-20260704/`.
3. **Shared-worktree discipline**: multiple agents may touch the dev worktree —
   stage precisely (never `git add -A`), re-diff before committing.
4. **CLI**: the deployed `clawboard`/`clawbeat` come from the canonical repo
   (`cli/`); never run them from ad-hoc clones.

## Where old work went (2026-07-04 cleanup, task 12b69857)

`/mnt/nfs/NimsProjects/backups/clawboard-cleanup-20260704/`:
- `dirty-clone-all-refs.bundle` — every local branch of the retired
  nim-projects clone, incl. the reviewer lineage (`task/1a13178b` etc., also
  still on origin) and video-factory commits `8ea68c2`/`32ca28d`.
- `dirty-clone-{unstaged,staged}.patch` — the uncommitted reviewer-UX
  evolution (~500 lines: TaskReviewerService/TaskDetailModal/tests) and
  superseded WIP.
- `dirty-clone-untracked.tgz` — untracked files (minus build junk).
- `video-factory-automation.tgz` — the whole 1.1G subproject (code + render/TTS
  artifacts); restore this if the video-factory project resumes.
- `old-upstream-dev.bundle` — 6 dev commits that existed only in the old
  Homelab/ClawBoard NFS mirror (public-release scrub era).
- `docs-salvage/` — loose analysis docs; `SCAN-REPORT.md.SECRET` (mode 600,
  contains a credential — rotate/verify before sharing).
- `taxonomy-worktree-dirty.patch` — 6-line TS fix from the taxonomy worktree;
  local branch `feature/hermes-session-taxonomy` (unpushed draft `25f2635`)
  retained in the canonical repo as insurance.
