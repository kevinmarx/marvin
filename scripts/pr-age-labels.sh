#!/usr/bin/env bash
# pr-age-labels.sh — Apply age labels to stale PRs
# Only labels PRs open > 3 days. Intended to run via cron or phase-pr.
#
# Usage: ./scripts/pr-age-labels.sh [config_path]
# Reads github_org, github_user, repos, state_db from config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${1:-${MARVIN_CONFIG:-$SCRIPT_DIR/../config/default.json}}"
DB_PATH=$(python3 -c "import json,os; c=json.load(open('$CONFIG')); print(os.path.expanduser(c.get('state_db','~/.marvin/state/marvin.db')))")
GITHUB_ORG=$(python3 -c "import json; print(json.load(open('$CONFIG')).get('github_org','your-org'))")
GITHUB_USER=$(python3 -c "import json; print(json.load(open('$CONFIG')).get('github_user','your-user'))")
REPOS=$(python3 -c "import json; print(' '.join(json.load(open('$CONFIG')).get('repos',{}).keys()))")

# Create labels idempotently
for REPO_NAME in $REPOS; do
  gh label create "age:overripe" --repo "$GITHUB_ORG/$REPO_NAME" --color "d93f0b" --description "PR open 3-7 days" 2>/dev/null || true
  gh label create "age:rotting" --repo "$GITHUB_ORG/$REPO_NAME" --color "b60205" --description "PR open more than 7 days" 2>/dev/null || true
done

# Apply labels based on PR age
python3 -c "
import sqlite3, subprocess, datetime, sys

db = sqlite3.connect('$DB_PATH')
db.row_factory = sqlite3.Row
now = datetime.datetime.now(datetime.timezone.utc)
updated = 0

for pr in db.execute(\"SELECT pr_number, repo, gh_created_at FROM pull_requests WHERE state='open' AND author='$GITHUB_USER'\"):
    try:
        created = datetime.datetime.fromisoformat(pr['gh_created_at'].replace('Z','+00:00'))
        days = (now - created).days
    except Exception:
        continue

    repo = '$GITHUB_ORG/' + pr['repo']
    pr_num = str(pr['pr_number'])

    if days <= 3:
        # Remove stale labels if present
        subprocess.run(['gh', 'pr', 'edit', pr_num, '--repo', repo,
            '--remove-label', 'age:overripe', '--remove-label', 'age:rotting'],
            capture_output=True)
    elif days <= 7:
        subprocess.run(['gh', 'pr', 'edit', pr_num, '--repo', repo,
            '--remove-label', 'age:rotting', '--add-label', 'age:overripe'],
            capture_output=True)
        updated += 1
    else:
        subprocess.run(['gh', 'pr', 'edit', pr_num, '--repo', repo,
            '--remove-label', 'age:overripe', '--add-label', 'age:rotting'],
            capture_output=True)
        updated += 1

db.close()
print(f'Updated {updated} PR age labels')
"
