# Standard git operation patterns

## Push (explicit refspec)

Never rely on upstream tracking. Always push with explicit refspec:

```bash
git push origin HEAD:refs/heads/{branch_name}
```

Never force-push. Never use `-f` or `--force`.

## Worktree creation

```bash
cd {repo_path}
git fetch origin main
git worktree add {worktree_path} -b {branch_name} origin/main
cd {worktree_path}
git branch --unset-upstream {branch_name} 2>/dev/null || true
```

Always unset upstream tracking to prevent accidental push to main.

## Worktree sync (existing worktree)

```bash
cd {worktree_path}
git fetch origin {branch_name}
git pull origin {branch_name}
```

## Commit with Co-Authored-By

```bash
cd {worktree_path}
git add -A
git commit -m "$(cat <<'EOF'
{identifier}: {title}

{description of changes}

Co-Authored-By: Marvin (Claude Code) <noreply@anthropic.com>
EOF
)"
```

For CI fixes, use `git add <file1> <file2>` instead of `git add -A` (stage specific files only).

## Rebase on origin/main

```bash
cd {worktree_path}
git fetch origin main
git rebase origin/main
```

If conflicts occur:

```bash
# Check conflict status
git diff --name-only --diff-filter=U

# If conflicts are trivial, resolve them, then:
git add <resolved_files>
git rebase --continue

# If conflicts are non-trivial, abort:
git rebase --abort
```

After successful rebase, push with explicit refspec:

```bash
git push origin HEAD:refs/heads/{branch_name} --force-with-lease
```

Note: `--force-with-lease` is the ONLY acceptable force variant, and only after a rebase.

## Branch naming conventions

- Implementation: `{branch_prefix}/gm-{ticket_number}-{slug}`
- Documentation: `{branch_prefix}/docs-{identifier}`
- Always branch from `origin/main`
