# Test selection pattern

## Language detection

Check in this order:
1. Look at file extensions in `affected_paths`
2. Check for marker files in the worktree root or app directory

| Marker file | Language | Test command |
|-------------|----------|-------------|
| `go.mod` | Go | `go test ./...` |
| `Gemfile` | Ruby | `bundle exec rspec` |
| `package.json` | Node/TS | `npm test` or `npx vitest` or `npx jest` |
| `*.tf` files | Terraform | `terraform fmt -check && terraform validate` |

## Test commands by language

### Go

```bash
cd {worktree_path}/{app_dir}
go test ./...
```

### Ruby

Without Docker:
```bash
cd {worktree_path}/{app_dir}
bundle exec rspec
```

With Docker (if `docker-compose.yaml` or `docker-compose.yml` exists):
```bash
cd {worktree_path}/{app_dir}
docker compose run {service} bundle exec rspec
```

### Node / TypeScript

Check `package.json` for the test script name, then:
```bash
cd {worktree_path}/{app_dir}
npm test
```

Or for specific frameworks:
```bash
npx vitest run    # Vitest
npx jest          # Jest
```

### Terraform

```bash
cd {worktree_path}
terraform fmt -check
terraform validate
```

## Retry policy

| Worker type | Max retries | Action on final failure |
|-------------|------------|------------------------|
| executor | 2 attempts | Mark ticket `failed`, comment on Linear |
| reviewer | 1 attempt | Mark review run `failed` |
| ci-fix | 1 attempt | Mark ci_fix_run `failed` |

"Retry" means: fix the issue and re-run tests, not re-run the same failing test.

## Determining app_dir

The `app_dir` is the subdirectory containing the service. Detect it from:
- `affected_paths` — find the common parent directory
- Look for `go.mod`, `Gemfile`, or `package.json` in subdirectories
- Common patterns: `apps/{service}/`, `services/{service}/`, or repo root
