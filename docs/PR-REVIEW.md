# PR Review Workflow

> How to review, fix, and merge pull requests in MorrisCode — agent-assisted.

## Overview

**All PRs must target `develop`.** The setup phase enforces this automatically. Features accumulate via squash-merges. `main` stays aligned with the latest published version (see release process in [AGENTS.md](../AGENTS.md#release)).

PRs can come from **same-repo branches** or **forks** — the workflow is identical for both. We never push to the contributor's branch. All review fixes land as a single commit directly on `develop` after the merge.

## Agent-Assisted Workflow

The agent drives the review. The user reviews code, confirms fixes, and does manual testing.

### Phase 1 — Setup

The agent creates an isolated workspace and pulls in the PR branch.

```bash
# 1. Create/switch to a review workspace (auto-creates if new, runs npm install)
workspace switch review-pr-<N>

# 2. Point origin to GitHub (workspaces use --shared clone, origin
#    defaults to the local repo path — gh needs a GitHub remote)
git remote set-url origin git@github.com:morrisdevstudio/morriscode.git

# 3. Sync workspace with develop
git fetch origin
git reset --hard origin/develop

# 4. Fetch the PR branch
gh pr checkout <N>

# 5. Verify PR targets develop (all PRs must target develop, not main)
PR_BASE=$(gh pr view <N> --json baseRefName --jq '.baseRefName')
if [ "$PR_BASE" != "develop" ]; then
  echo "⚠️  PR #<N> targets '$PR_BASE' — retargeting to 'develop'"
  gh api repos/morrisdevstudio/morriscode/pulls/<N> -X PATCH -f base=develop
  git fetch origin
fi

# 6. Rebase PR branch onto latest develop (ensures review is against current code)
#    If conflicts arise, resolve them or abort with git rebase --abort.
git rebase origin/develop
```

### Phase 2 — Review

The agent examines the PR:

- Read the diff: `git diff origin/develop...HEAD`
- List changed files: `git diff --stat origin/develop...HEAD`
- Run full test suite: `npm run test:unit && npm run test:e2e`
- Run typecheck and lint: `npm run typecheck && npm run lint`
- Inspect code quality, error handling, edge cases
- Report findings to the user with specific line references

### Phase 3 — Fix

The user approves the fix plan. The agent applies fixes in the workspace.

```bash
# Apply fixes (agent uses write_file / edit_file tools)
git add -A && git commit -m "review: <summary of fixes> (#<N>)"   # timeout: 120000ms
git tag review-fixes-<N>
```

### Phase 4 — User Tests

The agent starts the dev server and hands off with a summary — no asking, just doing:

```bash
# Agent starts the dev server (no question — just do it)
dev_server start   # → http://localhost:<port>
```

Handoff format:

> **"PR #N is ready at http://localhost:<port>.**
>
> **Metrics:** Tests X → Y (+Z), Typecheck ✅, Lint ✅
>
> **What I fixed:**
>
> - _bullet list of specific changes_
> - _why each matters_
>
> **What to test:**
>
> Write each test item from the user's perspective. Describe what they do
> (e.g. 'tell the agent to…', 'click the branch modal button…', 'open
> settings and toggle…') and what they should observe as a result.
>
> - _specific things to try_
> - _edge cases_"

The user opens the link and kicks the tires. Loop back to Phase 3 if adjustments are needed.

### Phase 5 — Merge

When the user says **"Merge it"**, the agent runs a single unified flow. It works identically for same-repo branches and forks — we never push to the contributor's branch.

```bash
# ──────────────────────────────────────────────
# 1. Push our fix tag to origin (workspace objects
#    aren't visible from the original repo)
# ──────────────────────────────────────────────
git push origin review-fixes-<N>

# ──────────────────────────────────────────────
# 2. Squash-merge the PR (original contributor code only)
#    The API operates on the remote PR branch — it ignores our
#    local state entirely. No force-push needed.
# ──────────────────────────────────────────────
gh api repos/morrisdevstudio/morriscode/pulls/<N>/merge -X PUT \
  -f merge_method=squash \
  -f commit_title="feat: description (#<N>)"

# ──────────────────────────────────────────────
# 3. Switch back to the original project
# ──────────────────────────────────────────────
workspace switch original

# ──────────────────────────────────────────────
# 4. Pull the latest develop (now includes the squash-merge)
# ──────────────────────────────────────────────
git checkout develop && git pull origin develop --ff-only

# ──────────────────────────────────────────────
# 5. Fetch our tag and cherry-pick the fixes onto develop
# ──────────────────────────────────────────────
git fetch origin refs/tags/review-fixes-<N>
git cherry-pick FETCH_HEAD
git push origin develop

# ──────────────────────────────────────────────
# 6. ✅ Verify — both commits visible on origin/develop
# ──────────────────────────────────────────────
echo "=== origin/develop after merge ==="
git log --oneline origin/develop -3

# ──────────────────────────────────────────────
# 7. Clean up (remote tag + local tag)
# ──────────────────────────────────────────────
git push origin --delete refs/tags/review-fixes-<N>
git tag -d review-fixes-<N>
workspace delete review-pr-<N>
```

**What's happening under the hood:**

- **Phase 3** commits our fixes and tags them with `review-fixes-<N>`.
- **Step 1** pushes the tag to origin so it's accessible from the original repo (workspaces share objects one-way via alternates — the original repo can't see workspace-local objects).
- **Step 2** tells GitHub to squash-merge the PR's remote branch into `develop`.
- **Step 5** fetches the tag (into `FETCH_HEAD`) and cherry-picks it. Unlike `git apply` (which uses fuzzy line-context matching), cherry-pick operates on committed tree objects — it's immune to context shifts from the squash.

**Result on `origin/develop`:**

```
abc1234 review: <summary> (#<N>)      ← our fix commit (cherry-picked)
def5678 feat: description (#<N>)      ← PR squash-merge
ghi9012 ...                            ← previous develop
```

## Complete Example

```bash
# ── Setup ──
workspace switch review-pr-103
git remote set-url origin git@github.com:morrisdevstudio/morriscode.git
git fetch origin && git reset --hard origin/develop
gh pr checkout 103

PR_BASE=$(gh pr view 103 --json baseRefName --jq '.baseRefName')
if [ "$PR_BASE" != "develop" ]; then
  echo "⚠️  PR #103 targets '$PR_BASE' — retargeting to 'develop'"
  gh api repos/morrisdevstudio/morriscode/pulls/103 -X PATCH -f base=develop
  git fetch origin
fi

git rebase origin/develop

# ── Review ──
git diff --stat origin/develop...HEAD
npm run typecheck
npm run test:unit && npm run test:e2e

# ── Fix (agent proposes → user approves) ──
# agent applies fixes via edit_file
git add -A && git commit -m "review: fix windows path handling in npm spawn (#103)"   # timeout: 120000ms
git tag review-fixes-103

# ── Agent starts dev server and hands off ──
dev_server start
# "PR #103 ready at http://localhost:.... Metrics: ..., Typecheck ✅, Lint ✅
#  What I fixed: ... What to test: ..."
# ── User tests, iterates if needed ──

# ── Merge (user says "merge it") ──
gh api repos/morrisdevstudio/morriscode/pulls/103/merge -X PUT \
  -f merge_method=squash \
  -f commit_title="feat: PDF embedded-image support (#103)"
workspace switch original
git checkout develop && git pull origin develop --ff-only
git cherry-pick review-fixes-103
git push origin develop
git log --oneline origin/develop -3
git tag -d review-fixes-103
workspace delete review-pr-103
```

## Common Pitfalls

### Cherry-pick conflicts

**Scenario:** `git cherry-pick review-fixes-<N>` fails with conflicts.

**Root cause:** The PR was force-pushed between Phase 3 (fix commit) and Phase 5 (merge), causing the squash-merge to produce different code than what our fixes were based on.

**Fix:** Re-review from Phase 2 — the PR changed under us.

```bash
# Abort the cherry-pick
git cherry-pick --abort

# Switch back to the workspace to re-evaluate
workspace switch review-pr-<N>
# Continue from Phase 2
```

### `gh pr merge` GraphQL deprecation

`gh pr merge` may fail with `GraphQL: Projects (classic) is being deprecated` even when the merge succeeds. Use the REST API directly instead:

```bash
gh api repos/morrisdevstudio/morriscode/pulls/<N>/merge -X PUT \
  -f merge_method=squash \
  -f commit_title="feat: description (#<N>)"
```

### Orphaned workspaces

If a workspace switch fails midway, clean up manually:

```bash
workspace delete <name>          # via tool
# or manually:
rm -rf ~/.local/share/morriscode/workspaces/<project>/<name>
```

### Rebase conflicts

If `git rebase origin/develop` produces conflicts in Phase 1:

```bash
# Check status
git status

# Resolve each conflicted file, then:
git add <file>
git rebase --continue

# Or abort entirely:
git rebase --abort
```

## Squash-Merge via API

Always use the REST API for merging to avoid GraphQL deprecation errors:

```bash
gh api repos/morrisdevstudio/morriscode/pulls/<N>/merge -X PUT \
  -f merge_method=squash \
  -f commit_title="feat: description (#<N>)"
```
