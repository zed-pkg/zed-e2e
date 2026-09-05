# Agent instructions

## Scope and hierarchy

- These instructions apply to the whole `zed-pkg/zed-e2e` repository unless a deeper lowercase `agents.md` adds narrower rules.
- Before editing, resolve the current working directory and load every readable ancestor `agents.md` from the filesystem root to the working directory. Do not search siblings. Resolve symlinks, deduplicate resolved files, and report unreadable or cyclic instruction files.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.openai/AGENTS.md` are pointers only. Never duplicate instructions in tool-specific files.

## Repository role

This repository owns controlled cross-stack end-to-end validation for the Zed CLI, registry services, web UI, clients, persistence, and browser workflows.

## Working rules

- Run tests only against isolated local or CI fixtures, never against production or personal accounts.
- Pin service, browser, driver, image, and fixture versions; make ports, clocks, randomness, and dependencies deterministic where possible.
- Prefer observable readiness conditions over sleeps. Bound every wait, retry, download, process, and browser session.
- Retries may diagnose infrastructure flakes but must not hide deterministic product failures; preserve the first failure and useful artifacts.
- Isolate test identities and data, clean up containers/processes/files, and make repeated or parallel runs safe.
- Sanitize screenshots, traces, videos, logs, and uploaded artifacts before retention.
- Exercise success, authorization, malformed input, network interruption, restart, upgrade, and rollback paths that cross repository boundaries.
- Never commit credentials, reusable sessions, private certificates, sensitive fixtures, or production environment files.

## Validation

The pinned `agents policy` workflow validates this hierarchy and the three tool pointers. Follow `README.md` and existing cross-stack CI for test-specific validation before requesting review.

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.
