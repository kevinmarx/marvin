#!/usr/bin/env python3
"""Marvin dashboard — simple local web UI for viewing ticket state and digests."""

import base64
import html as html_mod
import json
import os
import socket
import sqlite3
import subprocess
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, parse_qs

DB_PATH = Path.home() / ".marvin" / "state" / "marvin.db"
SCRIPT_DIR = Path(__file__).parent
PORT = 7777
BIND_HOST = "0.0.0.0" if os.environ.get("MARVIN_REMOTE") == "1" else "127.0.0.1"

# Read Linear workspace slug from config
_CONFIG_PATH = Path(os.environ.get("MARVIN_CONFIG", str(Path(__file__).parent.parent / "config" / "default.json")))
try:
    _config = json.load(open(_CONFIG_PATH))
    LINEAR_WORKSPACE_SLUG = _config.get("linear_workspace_slug", "your-workspace")
except (FileNotFoundError, json.JSONDecodeError):
    LINEAR_WORKSPACE_SLUG = "your-workspace"

# Embed mascot image as base64 data URI
_MASCOT_PATH = Path(__file__).parent.parent / "assets" / "marvin_vibing_128.png"
try:
    MASCOT_DATA_URI = "data:image/png;base64," + base64.b64encode(_MASCOT_PATH.read_bytes()).decode()
except FileNotFoundError:
    MASCOT_DATA_URI = ""

# Embed favicon as base64 data URI
_FAVICON_PATH = Path(__file__).parent.parent / "assets" / "favicon.png"
try:
    FAVICON_DATA_URI = "data:image/png;base64," + base64.b64encode(_FAVICON_PATH.read_bytes()).decode()
except FileNotFoundError:
    FAVICON_DATA_URI = MASCOT_DATA_URI


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def query(sql, params=()):
    db = _shared_db()
    rows = db.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def _shared_db():
    """Reuse a single connection per request instead of opening/closing per query."""
    if not hasattr(_shared_db, '_conn') or _shared_db._conn is None:
        _shared_db._conn = get_db()
    return _shared_db._conn


def _close_shared_db():
    """Close the shared connection after a request is complete."""
    if hasattr(_shared_db, '_conn') and _shared_db._conn is not None:
        _shared_db._conn.close()
        _shared_db._conn = None


def get_tickets_by_status():
    statuses = ["failed", "executing", "triaged", "deferred", "reassigned", "done"]
    result = {}
    for s in statuses:
        result[s] = query(
            "SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC", (s,)
        )
    return result


def get_runs():
    return query("SELECT * FROM runs ORDER BY started_at DESC LIMIT 20")


def get_digests():
    return query("SELECT * FROM digests ORDER BY sent_at DESC LIMIT 50")


def render_digest_markdown(md_text):
    """Convert the markdown subset Marvin generates to styled HTML.

    Handles: # headings, ## headings, **bold**, - list items, numbered lists.
    Server-side rendering keeps the client JS simple.
    """
    import re

    lines = (md_text or "").split("\n")
    out = []
    in_list = False
    for line in lines:
        stripped = line.strip()
        # Skip HTML comments
        if stripped.startswith("<!--") and "-->" in stripped:
            continue
        # Headings
        if stripped.startswith("## "):
            if in_list:
                out.append("</ul>")
                in_list = False
            heading = html_mod.escape(stripped[3:])
            out.append(f'<h3 style="color:#f0f6fc;font-size:14px;margin:16px 0 8px 0;border-bottom:1px solid #21262d;padding-bottom:4px;">{heading}</h3>')
            continue
        if stripped.startswith("# "):
            if in_list:
                out.append("</ul>")
                in_list = False
            heading = html_mod.escape(stripped[2:])
            out.append(f'<h2 style="color:#f0f6fc;font-size:16px;margin:0 0 12px 0;">{heading}</h2>')
            continue
        # Bold delta line
        if stripped.startswith("**") and "**" in stripped[2:]:
            if in_list:
                out.append("</ul>")
                in_list = False
            escaped = html_mod.escape(stripped)
            escaped = re.sub(r'\*\*(.+?)\*\*', r'<strong style="color:#f0f6fc">\1</strong>', escaped)
            out.append(f'<p style="margin:8px 0;font-size:13px;">{escaped}</p>')
            continue
        # List items
        if stripped.startswith("- ") or (stripped and stripped[0].isdigit() and ". " in stripped[:4]):
            if not in_list:
                out.append('<ul style="margin:4px 0;padding-left:20px;list-style:disc;">')
                in_list = True
            if stripped.startswith("- "):
                item = stripped[2:]
            else:
                item = stripped.split(". ", 1)[1] if ". " in stripped else stripped
            escaped = html_mod.escape(item)
            escaped = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', escaped)
            # Link PR references like PR #123 or #123
            escaped = re.sub(r'PR #(\d+)', r'PR #\1', escaped)
            out.append(f'<li style="font-size:13px;margin:2px 0;color:#c9d1d9;">{escaped}</li>')
            continue
        # Empty line
        if not stripped:
            if in_list:
                out.append("</ul>")
                in_list = False
            continue
        # Plain text
        if in_list:
            out.append("</ul>")
            in_list = False
        escaped = html_mod.escape(stripped)
        escaped = re.sub(r'\*\*(.+?)\*\*', r'<strong style="color:#f0f6fc">\1</strong>', escaped)
        out.append(f'<p style="margin:4px 0;font-size:13px;color:#c9d1d9;">{escaped}</p>')
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def format_coverage_period(seconds):
    """Format a duration in seconds as a human-readable coverage period."""
    if seconds is None or seconds < 0:
        return ""
    minutes = int(seconds // 60)
    hours = minutes // 60
    mins = minutes % 60
    days = hours // 24
    if days > 0:
        remaining_hours = hours % 24
        if remaining_hours > 0:
            return f"{days}d {remaining_hours}h"
        return f"{days}d"
    if hours > 0:
        if mins > 0:
            return f"{hours}h {mins}m"
        return f"{hours}h"
    return f"{mins}m"


def get_stats():
    rows = query(
        "SELECT status, COUNT(*) as count FROM tickets GROUP BY status ORDER BY count DESC"
    )
    return {r["status"]: r["count"] for r in rows}


def get_heartbeat():
    """Get orchestrator heartbeat status."""
    try:
        rows = query("SELECT * FROM heartbeat WHERE id = 1")
        if not rows:
            return None
        hb = rows[0]
        last_beat = hb.get("last_beat_at", "")
        if last_beat:
            try:
                dt = datetime.fromisoformat(last_beat.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                age_seconds = (now - dt).total_seconds()
                hb["age_seconds"] = int(age_seconds)
                if age_seconds < 4500:  # 75 minutes (covers 1h sleep + cycle time)
                    hb["health"] = "healthy"
                elif age_seconds < 5400:  # 90 minutes
                    hb["health"] = "warning"
                else:
                    hb["health"] = "dead"
            except (ValueError, AttributeError):
                hb["age_seconds"] = 0
                hb["health"] = "unknown"
        else:
            hb["age_seconds"] = 0
            hb["health"] = "unknown"
        return hb
    except sqlite3.OperationalError:
        return None


def get_cycle_events(limit=50):
    """Get recent cycle events for the activity log."""
    try:
        return query(
            "SELECT * FROM cycle_events ORDER BY id DESC LIMIT ?", (limit,)
        )
    except sqlite3.OperationalError:
        return []


def get_active_work():
    """Get all in-progress work: executing tickets, exploring tickets, active worktrees."""
    work_items = []
    now = datetime.utcnow()

    # Executing tickets (full implementation in progress)
    for t in query(
        "SELECT linear_id, identifier, title, target_repo, complexity, "
        "branch_name, worktree_path, error, updated_at, status "
        "FROM tickets WHERE status IN ('executing', 'exploring') "
        "ORDER BY updated_at DESC"
    ):
        created = t.get("updated_at", "")
        delta_min = _minutes_since(created, now) if created else 0
        work_items.append({
            "type": "executor" if t["status"] == "executing" else "explorer",
            "icon": "🔨" if t["status"] == "executing" else "🔍",
            "identifier": t.get("identifier", ""),
            "linear_id": t.get("linear_id", ""),
            "title": t.get("title", ""),
            "repo": t.get("target_repo", ""),
            "complexity": t.get("complexity", "?"),
            "branch": t.get("branch_name", ""),
            "worktree": t.get("worktree_path", ""),
            "error": t.get("error", ""),
            "duration_min": delta_min,
            "last_update": created,
            "status": t["status"],
        })

    # Done tickets with PRs (recently completed work)
    for t in query(
        "SELECT linear_id, identifier, title, target_repo, complexity, "
        "branch_name, worktree_path, pr_url, pr_number, error, "
        "updated_at, executed_at, status, review_status "
        "FROM tickets WHERE status = 'done' AND pr_number IS NOT NULL "
        "ORDER BY executed_at DESC LIMIT 10"
    ):
        work_items.append({
            "type": "completed",
            "icon": "✅",
            "identifier": t.get("identifier", ""),
            "linear_id": t.get("linear_id", ""),
            "title": t.get("title", ""),
            "repo": t.get("target_repo", ""),
            "complexity": t.get("complexity", "?"),
            "branch": t.get("branch_name", ""),
            "worktree": t.get("worktree_path", ""),
            "pr_url": t.get("pr_url", ""),
            "pr_number": t.get("pr_number", ""),
            "error": t.get("error", ""),
            "duration_min": 0,
            "last_update": t.get("executed_at", t.get("updated_at", "")),
            "status": "done",
            "review_status": t.get("review_status", ""),
        })

    # Explored tickets (findings posted, awaiting human review)
    for t in query(
        "SELECT linear_id, identifier, title, target_repo, complexity, "
        "branch_name, worktree_path, error, updated_at, status "
        "FROM tickets WHERE status = 'explored' "
        "ORDER BY updated_at DESC"
    ):
        work_items.append({
            "type": "explored",
            "icon": "📋",
            "identifier": t.get("identifier", ""),
            "linear_id": t.get("linear_id", ""),
            "title": t.get("title", ""),
            "repo": t.get("target_repo", ""),
            "complexity": t.get("complexity", "?"),
            "branch": t.get("branch_name", ""),
            "worktree": t.get("worktree_path", ""),
            "error": t.get("error", ""),
            "duration_min": 0,
            "last_update": t.get("updated_at", ""),
            "status": "explored",
        })

    # Failed tickets (recent failures)
    for t in query(
        "SELECT linear_id, identifier, title, target_repo, complexity, "
        "branch_name, worktree_path, error, updated_at, status "
        "FROM tickets WHERE status = 'failed' "
        "ORDER BY updated_at DESC LIMIT 5"
    ):
        work_items.append({
            "type": "failed",
            "icon": "❌",
            "identifier": t.get("identifier", ""),
            "linear_id": t.get("linear_id", ""),
            "title": t.get("title", ""),
            "repo": t.get("target_repo", ""),
            "complexity": t.get("complexity", "?"),
            "branch": t.get("branch_name", ""),
            "worktree": t.get("worktree_path", ""),
            "error": t.get("error", ""),
            "duration_min": 0,
            "last_update": t.get("updated_at", ""),
            "status": "failed",
        })

    return work_items


def get_active_teammates():
    """Query all sources of running work and return active teammate info."""
    teammates = []
    now = datetime.utcnow()

    # Executors: tickets with status='executing'
    try:
        for t in query(
            "SELECT linear_id, identifier, title, target_repo, complexity, updated_at, last_phase, last_phase_at "
            "FROM tickets WHERE status = 'executing'"
        ):
            started = t.get("updated_at", "")
            duration = _minutes_since(started, now)
            last_beat = t.get("last_phase_at") or started
            since_beat = _minutes_since(last_beat, now)
            phase_str = f"Phase: {t.get('last_phase', '?')}, " if t.get("last_phase") else ""
            teammates.append({
                "role": "executor",
                "icon": "🔨",
                "name": f"exec-{t['identifier']}",
                "target": f"{t.get('target_repo', '?')} (C{t.get('complexity', '?')})",
                "title": t.get("title", ""),
                "linear_id": t.get("linear_id", ""),
                "duration_min": duration,
                "stale_threshold": 120,
                "status": "stale" if since_beat > 120 else ("warning" if since_beat > 90 else "healthy"),
                "context": f"{phase_str}Complexity {t.get('complexity', '?')}/5, repo: {t.get('target_repo', '?')}",
                "last_update": last_beat,
            })
    except sqlite3.OperationalError:
        pass

    # Explorers: tickets with status='exploring'
    try:
        for t in query(
            "SELECT linear_id, identifier, title, target_repo, complexity, updated_at, last_phase, last_phase_at "
            "FROM tickets WHERE status = 'exploring'"
        ):
            started = t.get("updated_at", "")
            duration = _minutes_since(started, now)
            last_beat = t.get("last_phase_at") or started
            since_beat = _minutes_since(last_beat, now)
            phase_str = f"Phase: {t.get('last_phase', '?')}, " if t.get("last_phase") else ""
            teammates.append({
                "role": "explorer",
                "icon": "🔭",
                "name": f"explore-{t['identifier']}",
                "target": f"{t.get('target_repo', '?')} (C{t.get('complexity', '?')})",
                "title": t.get("title", ""),
                "linear_id": t.get("linear_id", ""),
                "duration_min": duration,
                "stale_threshold": 120,
                "status": "stale" if since_beat > 120 else ("warning" if since_beat > 90 else "healthy"),
                "context": f"{phase_str}Complexity {t.get('complexity', '?')}/5, repo: {t.get('target_repo', '?')}",
                "last_update": last_beat,
            })
    except sqlite3.OperationalError:
        pass

    # Reviewers: review_runs with status='running' or 'queued'
    try:
        for rr in query(
            "SELECT rr.ticket_linear_id, rr.pr_number, rr.started_at, rr.last_phase, rr.last_phase_at, "
            "rr.status as run_status, "
            "t.identifier, t.title, t.target_repo "
            "FROM review_runs rr "
            "LEFT JOIN tickets t ON t.linear_id = rr.ticket_linear_id "
            "WHERE rr.status IN ('running', 'queued')"
        ):
            started = rr.get("started_at", "")
            duration = _minutes_since(started, now)
            last_beat = rr.get("last_phase_at") or started
            since_beat = _minutes_since(last_beat, now)
            ident = rr.get("identifier", "?")
            pr_num = rr.get("pr_number", "?")
            repo = rr.get("target_repo", "?")
            # Count pending comments for this PR
            pending_count = 0
            try:
                pending_rows = query(
                    "SELECT COUNT(*) as cnt FROM review_comments "
                    "WHERE pr_number = ? AND status = 'pending'",
                    (pr_num,),
                )
                if pending_rows:
                    pending_count = pending_rows[0].get("cnt", 0)
            except sqlite3.OperationalError:
                pass
            phase_str = f"Phase: {rr.get('last_phase')}, " if rr.get("last_phase") else ""
            teammates.append({
                "role": "reviewer",
                "icon": "💬",
                "name": f"review-{ident}",
                "target": f"PR #{pr_num} ({repo})",
                "title": rr.get("title", ""),
                "linear_id": rr.get("ticket_linear_id", ""),
                "duration_min": duration,
                "stale_threshold": 60,
                "status": "stale" if since_beat > 60 else ("warning" if since_beat > 45 else "healthy"),
                "context": f"{phase_str}{pending_count} pending comment{'s' if pending_count != 1 else ''}",
                "last_update": last_beat,
            })
    except sqlite3.OperationalError:
        pass

    # CI fixers: ci_fix_runs with status='running' or 'queued'
    try:
        for cf in query(
            "SELECT cf.id, cf.pr_number, cf.repo, cf.started_at, cf.status as run_status, cf.failure_type, cf.last_phase, cf.last_phase_at, "
            "(SELECT COUNT(*) FROM ci_fix_runs c2 WHERE c2.pr_number = cf.pr_number AND c2.repo = cf.repo) as attempt_count "
            "FROM ci_fix_runs cf WHERE cf.status IN ('running', 'queued')"
        ):
            started = cf.get("started_at", "")
            duration = _minutes_since(started, now)
            last_beat = cf.get("last_phase_at") or started
            since_beat = _minutes_since(last_beat, now)
            attempt = cf.get("attempt_count", 1)
            failure_type = cf.get("failure_type", "unknown")
            phase_str = f"Phase: {cf.get('last_phase')}, " if cf.get("last_phase") else ""
            teammates.append({
                "role": "ci-fixer",
                "icon": "🔧",
                "name": f"ci-fix-{cf.get('repo', '?')}-{cf.get('pr_number', '?')}",
                "target": f"PR #{cf.get('pr_number', '?')} ({cf.get('repo', '?')})",
                "title": f"Attempt {attempt}/5 — {failure_type}",
                "linear_id": "",
                "duration_min": duration,
                "stale_threshold": 30,
                "status": "stale" if since_beat > 30 else ("warning" if since_beat > 20 else "healthy"),
                "context": f"{phase_str}Failure: {failure_type}, attempt {attempt}/5",
                "last_update": last_beat,
            })
    except sqlite3.OperationalError:
        pass

    # Auditors: audit_runs with status='running' or 'queued'
    try:
        for ar in query(
            "SELECT ar.pr_number, ar.repo, ar.started_at, ar.status as run_status, ar.last_phase, ar.last_phase_at, "
            "p.title as pr_title, p.author as pr_author "
            "FROM audit_runs ar "
            "LEFT JOIN pull_requests p ON p.pr_number = ar.pr_number AND p.repo = ar.repo "
            "WHERE ar.status IN ('running', 'queued')"
        ):
            started = ar.get("started_at", "")
            duration = _minutes_since(started, now)
            last_beat = ar.get("last_phase_at") or started
            since_beat = _minutes_since(last_beat, now)
            pr_title = ar.get("pr_title", "")
            pr_author = ar.get("pr_author", "")
            phase_str = f"Phase: {ar.get('last_phase')}" if ar.get("last_phase") else ""
            author_str = f"Author: {pr_author}" if pr_author else ""
            context_parts = [p for p in [phase_str, author_str] if p]
            teammates.append({
                "role": "auditor",
                "icon": "🔍",
                "name": f"audit-{ar.get('repo', '?')}-{ar.get('pr_number', '?')}",
                "target": f"PR #{ar.get('pr_number', '?')} ({ar.get('repo', '?')})",
                "title": pr_title,
                "linear_id": "",
                "duration_min": duration,
                "stale_threshold": 30,
                "status": "stale" if since_beat > 30 else ("warning" if since_beat > 20 else "healthy"),
                "context": ", ".join(context_parts),
                "last_update": last_beat,
            })
    except sqlite3.OperationalError:
        pass

    # Docs workers: doc_runs with status='running' or 'queued'
    try:
        for dr in query(
            "SELECT id, ticket_identifier, repo, started_at, status as run_status, last_phase, last_phase_at "
            "FROM doc_runs WHERE status IN ('running', 'queued')"
        ):
            started = dr.get("started_at", "")
            duration = _minutes_since(started, now)
            last_beat = dr.get("last_phase_at") or started
            since_beat = _minutes_since(last_beat, now)
            phase_str = f"Phase: {dr.get('last_phase')}" if dr.get("last_phase") else ""
            teammates.append({
                "role": "docs",
                "icon": "📝",
                "name": f"docs-{dr.get('ticket_identifier', '?')}",
                "target": dr.get("repo", "?"),
                "title": f"Docs for {dr.get('ticket_identifier', '?')}",
                "linear_id": "",
                "duration_min": duration,
                "stale_threshold": 30,
                "status": "stale" if since_beat > 30 else ("warning" if since_beat > 20 else "healthy"),
                "context": phase_str,
                "last_update": last_beat,
            })
    except sqlite3.OperationalError:
        pass

    return teammates


def get_teammate_history(role, repo=None, pr_number=None):
    """Get last 3 completed runs for a teammate type+target."""
    if role == "ci-fixer" and repo and pr_number:
        try:
            return query(
                "SELECT status, failure_type, error, files_changed, commits_pushed, finished_at "
                "FROM ci_fix_runs WHERE pr_number = ? AND repo = ? AND status != 'running' "
                "ORDER BY finished_at DESC LIMIT 3",
                (pr_number, repo),
            )
        except sqlite3.OperationalError:
            return []
    if role == "reviewer" and pr_number:
        try:
            return query(
                "SELECT status, comments_addressed, commits_pushed, error, finished_at "
                "FROM review_runs rr "
                "WHERE rr.pr_number = ? AND rr.status != 'running' "
                "ORDER BY rr.finished_at DESC LIMIT 3",
                (pr_number,),
            )
        except sqlite3.OperationalError:
            return []
    if role == "auditor" and repo and pr_number:
        try:
            return query(
                "SELECT status, risk_level, size_label, findings_count, approved, error, finished_at "
                "FROM audit_runs WHERE pr_number = ? AND repo = ? AND status != 'running' "
                "ORDER BY finished_at DESC LIMIT 3",
                (pr_number, repo),
            )
        except sqlite3.OperationalError:
            return []
    return []


def _minutes_since(iso_str, now):
    """Calculate minutes between an ISO timestamp and now."""
    if not iso_str:
        return 0
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00")).replace(tzinfo=None)
        delta = now - dt
        return max(0, int(delta.total_seconds() / 60))
    except (ValueError, AttributeError):
        return 0


def get_doc_runs():
    """Get documentation follow-up runs."""
    try:
        return query(
            "SELECT * FROM doc_runs ORDER BY started_at DESC LIMIT 20"
        )
    except sqlite3.OperationalError:
        return []


def _model_tables_exist():
    """Check whether the model feedback migration has been applied."""
    try:
        query("SELECT 1 FROM model_runs LIMIT 1")
        return True
    except sqlite3.OperationalError:
        return False


def get_unrated_model_runs():
    """Get model_runs where human_rating IS NULL."""
    try:
        return query(
            "SELECT id, skill, model, task_type, language, complexity, "
            "ticket_identifier, success, tests_passed, test_retries, "
            "ci_passed, tokens_used, duration_seconds, created_at "
            "FROM model_runs WHERE human_rating IS NULL "
            "ORDER BY created_at DESC LIMIT 20"
        )
    except sqlite3.OperationalError:
        return []


def get_recent_model_runs():
    """Get last 50 model_runs."""
    try:
        return query(
            "SELECT id, skill, model, task_type, language, complexity, "
            "ticket_identifier, success, tests_passed, test_retries, "
            "ci_passed, tokens_used, duration_seconds, created_at, human_rating "
            "FROM model_runs ORDER BY created_at DESC LIMIT 50"
        )
    except sqlite3.OperationalError:
        return []


def get_routing_weights():
    """Get all routing_weights rows."""
    try:
        return query(
            "SELECT task_type, language, model, score, sample_count, confidence, updated_at "
            "FROM routing_weights ORDER BY task_type, score DESC"
        )
    except sqlite3.OperationalError:
        return []


def get_routing_overrides():
    """Get all routing_overrides rows."""
    try:
        return query(
            "SELECT task_type, language, model, reason, created_at, expires_at "
            "FROM routing_overrides ORDER BY task_type"
        )
    except sqlite3.OperationalError:
        return []


def get_model_stats():
    """Get aggregate model stats for the last 7 days."""
    try:
        rows = query(
            "SELECT "
            "  COUNT(*) as total_runs, "
            "  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as total_successes, "
            "  AVG(CASE WHEN human_rating IS NOT NULL THEN human_rating END) as avg_human_rating "
            "FROM model_runs "
            "WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')"
        )
        overall = rows[0] if rows else {"total_runs": 0, "total_successes": 0, "avg_human_rating": None}

        by_model = query(
            "SELECT model, "
            "  COUNT(*) as runs, "
            "  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes, "
            "  AVG(CASE WHEN human_rating IS NOT NULL THEN human_rating END) as avg_rating, "
            "  AVG(tokens_used) as avg_tokens "
            "FROM model_runs "
            "WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days') "
            "GROUP BY model ORDER BY runs DESC"
        )

        return {"overall": overall, "by_model": by_model}
    except sqlite3.OperationalError:
        return {"overall": {"total_runs": 0, "total_successes": 0, "avg_human_rating": None}, "by_model": []}


def rate_model_run(run_id, rating_data):
    """Rate a model run and recalculate routing weights."""
    db = _shared_db()
    db.execute(
        "UPDATE model_runs SET "
        "human_rating = ?, human_notes = ?, code_quality = ?, "
        "correctness = ?, efficiency = ?, test_quality = ?, "
        "rated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') "
        "WHERE id = ?",
        (
            rating_data.get("humanRating"),
            rating_data.get("humanNotes"),
            rating_data.get("codeQuality"),
            rating_data.get("correctness"),
            rating_data.get("efficiency"),
            rating_data.get("testQuality"),
            run_id,
        ),
    )
    db.commit()

    # Recalculate routing weights for the affected task_type+language
    row = query("SELECT task_type, language FROM model_runs WHERE id = ?", (run_id,))
    if row:
        task_type = row[0]["task_type"]
        language = row[0].get("language")
        _recalculate_weights(task_type, language, db)


def _recalculate_weights(task_type, language, db):
    """Recalculate routing_weights for a given task_type+language combination.

    This is a Python port of the logic in runtime/src/router/weights.ts.
    """
    lang_clause = "AND language = ?" if language else ""
    params = [task_type, language] if language else [task_type]

    rows = db.execute(
        f"SELECT "
        f"  model, "
        f"  COUNT(*) as total_runs, "
        f"  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes, "
        f"  AVG(CASE WHEN human_rating IS NOT NULL THEN human_rating END) as avg_human_rating, "
        f"  SUM(CASE WHEN human_rating IS NOT NULL THEN 1 ELSE 0 END) as rated_count, "
        f"  SUM(CASE WHEN ci_passed IS NOT NULL AND ci_passed = 1 THEN 1 ELSE 0 END) as ci_passes, "
        f"  SUM(CASE WHEN ci_passed IS NOT NULL THEN 1 ELSE 0 END) as ci_total, "
        f"  SUM(CASE WHEN tests_passed IS NOT NULL AND test_retries = 0 THEN 1 ELSE 0 END) as test_first_passes, "
        f"  SUM(CASE WHEN tests_passed IS NOT NULL THEN 1 ELSE 0 END) as test_total, "
        f"  AVG(CASE WHEN pr_review_rounds IS NOT NULL AND pr_review_rounds > 0 THEN pr_review_rounds END) as avg_review_rounds, "
        f"  SUM(CASE WHEN pr_review_rounds IS NOT NULL AND pr_review_rounds > 0 THEN 1 ELSE 0 END) as review_total, "
        f"  AVG(tokens_used) as avg_tokens "
        f"FROM model_runs "
        f"WHERE task_type = ? {lang_clause} "
        f"GROUP BY model",
        params,
    ).fetchall()

    if not rows:
        return

    stats = [dict(r) for r in rows]
    max_tokens = max((s.get("avg_tokens") or 0) for s in stats) or 1

    # Signal weights matching weights.ts
    W = {
        "success_rate": 0.25,
        "human_rating": 0.30,
        "ci_pass_rate": 0.15,
        "test_first_pass": 0.10,
        "review_efficiency": 0.10,
        "token_efficiency": 0.10,
    }

    for s in stats:
        total_runs = s["total_runs"] or 1
        success_rate = s["successes"] / total_runs

        score = 0.0
        score += success_rate * W["success_rate"]

        # Human rating
        if s["rated_count"] and s["rated_count"] > 0 and s["avg_human_rating"] is not None:
            normalized = (s["avg_human_rating"] - 1) / 4
            score += normalized * W["human_rating"]
        else:
            score += success_rate * W["human_rating"]

        # CI pass rate
        if s["ci_total"] and s["ci_total"] > 0:
            score += (s["ci_passes"] / s["ci_total"]) * W["ci_pass_rate"]
        else:
            score += success_rate * W["ci_pass_rate"]

        # Test first-pass rate
        if s["test_total"] and s["test_total"] > 0:
            score += (s["test_first_passes"] / s["test_total"]) * W["test_first_pass"]
        else:
            score += success_rate * W["test_first_pass"]

        # Review efficiency
        if s["review_total"] and s["review_total"] > 0 and s["avg_review_rounds"] is not None:
            review_score = max(0, 1 - (s["avg_review_rounds"] - 1) / 4)
            score += review_score * W["review_efficiency"]
        else:
            score += success_rate * W["review_efficiency"]

        # Token efficiency
        if s["avg_tokens"] is not None and max_tokens > 0:
            token_score = 1 - (s["avg_tokens"] / max_tokens)
            score += max(0, token_score) * W["token_efficiency"]

        confidence = min(total_runs / 20, 1.0)
        lang_val = language if language else "__any__"

        db.execute(
            "INSERT INTO routing_weights (task_type, language, model, score, confidence, sample_count, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) "
            "ON CONFLICT(task_type, COALESCE(language, ''), model) DO UPDATE SET "
            "score = excluded.score, confidence = excluded.confidence, "
            "sample_count = excluded.sample_count, updated_at = excluded.updated_at",
            (task_type, lang_val, s["model"], score, confidence, total_runs),
        )

    db.commit()


def build_timeline(ticket, prs, comments, review_runs, ci_fix_runs, audit_runs, doc_runs):
    """Build a chronological list of events from all tables for one ticket."""
    events = []

    # Triage event
    if ticket.get("triaged_at"):
        triage = {}
        if ticket.get("triage_result"):
            try:
                triage = json.loads(ticket["triage_result"])
            except (json.JSONDecodeError, TypeError):
                pass
        route = ticket.get("route", "")
        confidence = triage.get("confidence", "")
        complexity = ticket.get("complexity", "")
        events.append({
            "time": ticket["triaged_at"],
            "type": "triage",
            "icon": "🔍",
            "summary": f"Triaged: route={route}, confidence={confidence}, complexity={complexity}",
            "detail": triage.get("route_reason", ""),
        })

    # Execution started
    if ticket.get("status") in ("executing", "done", "failed") and ticket.get("worktree_path"):
        # Use triaged_at as proxy for execution start if no better timestamp
        exec_start = ticket.get("triaged_at") or ticket.get("updated_at", "")
        branch = ticket.get("branch_name", "")
        events.append({
            "time": exec_start,
            "type": "execute_start",
            "icon": "🔨",
            "summary": f"Executor spawned, branch: {branch}",
            "detail": f"Worktree: {ticket.get('worktree_path', '')}",
        })

    # Execution complete
    if ticket.get("executed_at"):
        pr_url = ticket.get("pr_url", "")
        pr_num = ticket.get("pr_number", "")
        events.append({
            "time": ticket["executed_at"],
            "type": "execute_done",
            "icon": "✅",
            "summary": f"Execution complete{', PR #' + str(pr_num) if pr_num else ''}",
            "detail": pr_url or "No PR created",
        })

    # Execution failed
    if ticket.get("status") == "failed" and ticket.get("error"):
        events.append({
            "time": ticket.get("updated_at", ""),
            "type": "error",
            "icon": "❌",
            "summary": "Execution failed",
            "detail": ticket["error"],
        })

    # PR events
    for pr in prs:
        if pr.get("first_seen_at"):
            events.append({
                "time": pr["first_seen_at"],
                "type": "pr",
                "icon": "📋",
                "summary": f"PR #{pr.get('pr_number', '')} tracked: {pr.get('title', '')}",
                "detail": pr.get("url", ""),
            })

    # Review comments
    for rc in comments:
        path = rc.get("path", "") or ""
        line = rc.get("line", "")
        loc = f"{path}:{line}" if path and line else (path or "general")
        events.append({
            "time": rc.get("created_at", ""),
            "type": "review_comment",
            "icon": "💬",
            "summary": f"Review comment from @{rc.get('author', '?')} on {loc}",
            "detail": rc.get("body", ""),
        })

    # Review runs
    for rr in review_runs:
        if rr.get("started_at"):
            events.append({
                "time": rr["started_at"],
                "type": "review_start",
                "icon": "💬",
                "summary": "Review teammate spawned",
                "detail": "",
            })
        if rr.get("finished_at"):
            addressed = rr.get("comments_addressed", 0) or 0
            commits = rr.get("commits_pushed", 0) or 0
            status = rr.get("status", "")
            if status == "completed":
                events.append({
                    "time": rr["finished_at"],
                    "type": "review_done",
                    "icon": "✅",
                    "summary": f"Review completed: {addressed} comments addressed, {commits} commits pushed",
                    "detail": "",
                })
            else:
                events.append({
                    "time": rr["finished_at"],
                    "type": "review_error",
                    "icon": "⚠️",
                    "summary": f"Review failed",
                    "detail": rr.get("error", ""),
                })

    # CI fix runs
    for i, cf in enumerate(ci_fix_runs):
        attempt = i + 1
        if cf.get("started_at"):
            events.append({
                "time": cf["started_at"],
                "type": "ci_fix_start",
                "icon": "🔧",
                "summary": f"CI fix #{attempt} spawned ({cf.get('failure_type', 'unknown')})",
                "detail": "",
            })
        if cf.get("finished_at"):
            if cf.get("status") == "completed":
                events.append({
                    "time": cf["finished_at"],
                    "type": "ci_fix_done",
                    "icon": "✅",
                    "summary": f"CI fix #{attempt} succeeded: {cf.get('files_changed', 0)} files, {cf.get('commits_pushed', 0)} commits",
                    "detail": "",
                })
            else:
                events.append({
                    "time": cf["finished_at"],
                    "type": "ci_fix_error",
                    "icon": "⚠️",
                    "summary": f"CI fix #{attempt} failed",
                    "detail": cf.get("error", ""),
                })

    # Audit runs
    for ar in audit_runs:
        if ar.get("finished_at"):
            if ar.get("status") == "completed":
                risk = ar.get("risk_level", "?")
                size = ar.get("size_label", "?")
                findings = ar.get("findings_count", 0) or 0
                approved = ar.get("approved", 0)
                summary = f"Audited: risk={risk}, size={size}, {findings} findings"
                if approved:
                    summary += ", auto-approved"
                events.append({
                    "time": ar["finished_at"],
                    "type": "audit_done",
                    "icon": "🔍",
                    "summary": summary,
                    "detail": "",
                })
            else:
                events.append({
                    "time": ar["finished_at"],
                    "type": "audit_error",
                    "icon": "⚠️",
                    "summary": "Audit failed",
                    "detail": ar.get("error", ""),
                })

    # Doc runs
    for dr in doc_runs:
        if dr.get("finished_at"):
            if dr.get("status") == "completed" and dr.get("pr_url"):
                events.append({
                    "time": dr["finished_at"],
                    "type": "docs",
                    "icon": "📝",
                    "summary": f"Docs PR created: #{dr.get('pr_number', '')}",
                    "detail": dr.get("pr_url", ""),
                })
            elif dr.get("status") == "failed":
                events.append({
                    "time": dr["finished_at"],
                    "type": "docs_error",
                    "icon": "⚠️",
                    "summary": "Docs PR failed",
                    "detail": dr.get("error", ""),
                })

    # Sort chronologically (oldest first for timeline display)
    events.sort(key=lambda e: e.get("time", ""))
    return events


def get_ticket_detail(linear_id):
    """Return all data for a single ticket, joined across tables."""
    rows = query("SELECT * FROM tickets WHERE linear_id = ?", (linear_id,))
    if not rows:
        return None
    ticket = rows[0]

    # Parse triage_result JSON for display
    triage = {}
    if ticket.get("triage_result"):
        try:
            triage = json.loads(ticket["triage_result"])
        except (json.JSONDecodeError, TypeError):
            pass

    # Linked PR(s)
    prs = query(
        "SELECT * FROM pull_requests WHERE ticket_linear_id = ?", (linear_id,)
    )

    # Review comments on this ticket's PRs
    comments = query(
        "SELECT * FROM review_comments WHERE ticket_linear_id = ? ORDER BY created_at",
        (linear_id,),
    )

    # Review runs
    review_runs = query(
        "SELECT * FROM review_runs WHERE ticket_linear_id = ? ORDER BY started_at",
        (linear_id,),
    )

    # CI fix runs (via PR number)
    ci_fix_runs = []
    for pr in prs:
        ci_fix_runs.extend(query(
            "SELECT * FROM ci_fix_runs WHERE pr_number = ? AND repo = ? ORDER BY started_at",
            (pr["pr_number"], pr["repo"]),
        ))

    # Audit runs (via PR number)
    audit_runs = []
    for pr in prs:
        audit_runs.extend(query(
            "SELECT * FROM audit_runs WHERE pr_number = ? AND repo = ? ORDER BY started_at",
            (pr["pr_number"], pr["repo"]),
        ))

    # Doc runs
    doc_runs_list = []
    try:
        doc_runs_list = query(
            "SELECT * FROM doc_runs WHERE ticket_identifier = ?",
            (ticket.get("identifier"),),
        )
    except sqlite3.OperationalError:
        pass

    # Build unified timeline
    timeline = build_timeline(ticket, prs, comments, review_runs, ci_fix_runs, audit_runs, doc_runs_list)

    return {
        "ticket": ticket,
        "triage": triage,
        "prs": prs,
        "comments": comments,
        "review_runs": review_runs,
        "ci_fix_runs": ci_fix_runs,
        "audit_runs": audit_runs,
        "doc_runs": doc_runs_list,
        "timeline": timeline,
    }


def get_activity_feed():
    """Build a unified activity feed from all tables, sorted by time."""
    events = []

    # Ticket events
    for t in query(
        "SELECT identifier, title, status, route, triage_result, error, "
        "defer_status, defer_followup_count, pr_url, assigned_to_name, "
        "created_at, updated_at, triaged_at, executed_at "
        "FROM tickets ORDER BY updated_at DESC LIMIT 50"
    ):
        # Triage event
        if t.get("triaged_at"):
            route = t.get("route", "")
            reason = ""
            if t.get("triage_result"):
                try:
                    tr = json.loads(t["triage_result"])
                    reason = tr.get("route_reason", "")
                except (json.JSONDecodeError, TypeError):
                    pass
            events.append({
                "time": t["triaged_at"],
                "type": "triage",
                "icon": "🔍",
                "title": f"Triaged {t['identifier']}: {t['title']}",
                "detail": f"Route: {route}. {reason}" if reason else f"Route: {route}",
            })

        # Status-specific events
        if t["status"] == "failed" and t.get("updated_at"):
            events.append({
                "time": t["updated_at"],
                "type": "error",
                "icon": "❌",
                "title": f"Failed: {t['identifier']}",
                "detail": t.get("error", "") or "No error recorded",
            })
        elif t["status"] == "deferred" and t.get("updated_at"):
            ds = t.get("defer_status", "") or ""
            count = t.get("defer_followup_count", 0) or 0
            events.append({
                "time": t["updated_at"],
                "type": "defer",
                "icon": "⏸️",
                "title": f"Deferred: {t['identifier']}",
                "detail": f"Status: {ds.replace('_', ' ')}. Follow-ups: {count}/3",
            })
        elif t["status"] == "done" and t.get("executed_at"):
            pr = t.get("pr_url", "")
            events.append({
                "time": t["executed_at"],
                "type": "success",
                "icon": "✅",
                "title": f"Completed: {t['identifier']}",
                "detail": f"PR: {pr}" if pr else "No PR",
            })
        elif t["status"] == "reassigned" and t.get("updated_at"):
            events.append({
                "time": t["updated_at"],
                "type": "reassign",
                "icon": "👤",
                "title": f"Reassigned: {t['identifier']}",
                "detail": f"To: {t.get('assigned_to_name', 'unknown')}",
            })

    # CI fix events
    try:
        for cf in query(
            "SELECT pr_number, repo, status, failure_type, error, "
            "started_at, finished_at, files_changed, commits_pushed "
            "FROM ci_fix_runs ORDER BY started_at DESC LIMIT 20"
        ):
            if cf.get("finished_at"):
                icon = "🔧" if cf["status"] == "completed" else "⚠️"
                detail = ""
                if cf["status"] == "completed":
                    detail = f"Fixed {cf.get('files_changed', 0)} files, pushed {cf.get('commits_pushed', 0)} commits"
                else:
                    detail = cf.get("error", "") or f"Failure type: {cf.get('failure_type', 'unknown')}"
                events.append({
                    "time": cf["finished_at"],
                    "type": "ci_fix",
                    "icon": icon,
                    "title": f"CI fix {'succeeded' if cf['status'] == 'completed' else 'failed'}: #{cf['pr_number']} ({cf['repo']})",
                    "detail": detail,
                })
    except sqlite3.OperationalError:
        pass  # table may not exist yet

    # Review events
    try:
        for rr in query(
            "SELECT rr.ticket_linear_id, t.identifier, t.title, "
            "rr.comments_addressed, rr.commits_pushed, rr.status, "
            "rr.started_at, rr.finished_at "
            "FROM review_runs rr "
            "LEFT JOIN tickets t ON t.linear_id = rr.ticket_linear_id "
            "ORDER BY rr.started_at DESC LIMIT 20"
        ):
            if rr.get("finished_at"):
                ident = rr.get("identifier", "?")
                events.append({
                    "time": rr["finished_at"],
                    "type": "review",
                    "icon": "💬",
                    "title": f"Review addressed: {ident}",
                    "detail": f"Comments: {rr.get('comments_addressed', 0)}, Commits: {rr.get('commits_pushed', 0)}",
                })
    except sqlite3.OperationalError:
        pass  # table may not exist yet

    # Audit events
    try:
        for ar in query(
            "SELECT pr_number, repo, status, risk_level, size_label, "
            "findings_count, approved, error, started_at, finished_at "
            "FROM audit_runs ORDER BY started_at DESC LIMIT 20"
        ):
            if ar.get("finished_at"):
                risk = ar.get("risk_level", "?")
                size = ar.get("size_label", "?")
                findings = ar.get("findings_count", 0) or 0
                approved = ar.get("approved", 0)
                if ar["status"] == "completed":
                    icon = "✅" if approved else "🔍"
                    detail = f"Risk: {risk}, Size: {size}, Findings: {findings}"
                    if approved:
                        detail += " — auto-approved"
                    events.append({
                        "time": ar["finished_at"],
                        "type": "audit",
                        "icon": icon,
                        "title": f"Audited PR #{ar['pr_number']} ({ar['repo']})",
                        "detail": detail,
                    })
                else:
                    events.append({
                        "time": ar["finished_at"],
                        "type": "audit_error",
                        "icon": "⚠️",
                        "title": f"Audit failed: PR #{ar['pr_number']} ({ar['repo']})",
                        "detail": ar.get("error", "") or "Unknown error",
                    })
    except sqlite3.OperationalError:
        pass  # table may not exist yet

    # Doc runs
    try:
        for dr in query(
            "SELECT ticket_identifier, repo, pr_number, pr_url, status, error, "
            "started_at, finished_at "
            "FROM doc_runs ORDER BY started_at DESC LIMIT 20"
        ):
            if dr.get("finished_at"):
                if dr["status"] == "completed" and dr.get("pr_url"):
                    events.append({
                        "time": dr["finished_at"],
                        "type": "docs",
                        "icon": "📝",
                        "title": f"Docs PR created for {dr['ticket_identifier']}",
                        "detail": f"PR: {dr.get('pr_url', '')}",
                    })
                elif dr["status"] == "failed":
                    events.append({
                        "time": dr["finished_at"],
                        "type": "docs_error",
                        "icon": "⚠️",
                        "title": f"Docs failed for {dr['ticket_identifier']}",
                        "detail": dr.get("error", "") or "Unknown error",
                    })
    except sqlite3.OperationalError:
        pass  # table may not exist yet

    # Cycle runs
    for r in query("SELECT * FROM runs ORDER BY started_at DESC LIMIT 10"):
        ts = r.get("finished_at") or r.get("started_at", "")
        found = r.get("tickets_found", 0)
        triaged = r.get("tickets_triaged", 0)
        executed = r.get("tickets_executed", 0)
        failed = r.get("tickets_failed", 0)
        parts = []
        if found:
            parts.append(f"{found} found")
        if triaged:
            parts.append(f"{triaged} triaged")
        if executed:
            parts.append(f"{executed} executed")
        if failed:
            parts.append(f"{failed} failed")
        events.append({
            "time": ts,
            "type": "cycle",
            "icon": "🔄",
            "title": f"Cycle #{r.get('id', '?')} complete",
            "detail": ", ".join(parts) if parts else "No new tickets",
        })

    # Sort by time descending
    events.sort(key=lambda e: e.get("time", ""), reverse=True)
    return events[:50]


def get_last_activity():
    """Get the most recent meaningful activity as a one-liner."""
    events = get_activity_feed()
    # Skip cycle events — not interesting as status
    for e in events:
        if e["type"] != "cycle":
            time_str = e.get("time", "")
            return {
                "icon": e["icon"],
                "text": e["title"],
                "detail": e.get("detail", ""),
                "time": time_str,
            }
    return None


def render_page():
    tickets = get_tickets_by_status()
    digests = get_digests()
    stats = get_stats()
    total = sum(stats.values())
    work_items = get_active_work()
    teammates = get_active_teammates()
    teammate_count = len(teammates)
    stale_count = sum(1 for t in teammates if t["status"] == "stale")
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    last_activity = get_last_activity()
    heartbeat = get_heartbeat()

    # Health banner
    if heartbeat:
        health = heartbeat.get("health", "unknown")
        age = heartbeat.get("age_seconds", 0)
        step = heartbeat.get("current_step", "unknown")
        cycle_num = heartbeat.get("cycle_number", 0)
        cycle_dur = heartbeat.get("last_cycle_duration_seconds")

        if age < 60:
            age_str = "just now"
        elif age < 3600:
            age_str = f"{age // 60}m ago"
        else:
            age_str = f"{age // 3600}h {(age % 3600) // 60}m ago"

        dur_str = ""
        if cycle_dur is not None:
            if cycle_dur < 60:
                dur_str = f" &middot; last cycle: {cycle_dur}s"
            else:
                dur_str = f" &middot; last cycle: {cycle_dur // 60}m {cycle_dur % 60}s"

        step_display = step.replace("_", " ") if step else "unknown"

        health_colors = {"healthy": "#2ecc71", "warning": "#f39c12", "dead": "#e74c3c", "unknown": "#95a5a6"}
        health_bg = {"healthy": "#0d2818", "warning": "#2d2200", "dead": "#2d0a0a", "unknown": "#1c1c1c"}
        health_border = {"healthy": "#1a4d2e", "warning": "#4d3800", "dead": "#4d1414", "unknown": "#333"}
        health_labels = {"healthy": "Running", "warning": "Slow", "dead": "Not responding", "unknown": "Unknown"}

        hb_color = health_colors.get(health, "#95a5a6")
        hb_bg = health_bg.get(health, "#1c1c1c")
        hb_border_color = health_border.get(health, "#333")
        hb_label = health_labels.get(health, "Unknown")

        health_banner = f'''<div class="health-banner" data-health="{health}" data-teammates="{teammate_count}" style="background:{hb_bg};border:1px solid {hb_border_color};border-radius:8px;padding:10px 20px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">
            <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:{hb_color};{'animation:pulse 2s infinite;' if health == 'healthy' else ''}"></span>
            <span style="color:{hb_color};font-weight:600;">{hb_label}</span>
            <span style="color:#8b949e;">Cycle #{cycle_num} &middot; step: {step_display} &middot; heartbeat: {age_str}{dur_str}</span>
        </div>'''
    else:
        health_banner = '''<div class="health-banner" data-health="dead" data-teammates="0" style="background:#2d0a0a;border:1px solid #4d1414;border-radius:8px;padding:10px 20px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">
            <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#e74c3c;"></span>
            <span style="color:#e74c3c;font-weight:600;">No heartbeat</span>
            <span style="color:#8b949e;">Orchestrator has never run or heartbeat table missing</span>
        </div>'''

    # Activity feed HTML for the Log tab
    activity_events = get_activity_feed()
    if activity_events:
        # Collect unique event types for filter buttons
        event_types = sorted(set(e["type"] for e in activity_events))
        type_labels = {
            "triage": "Triage", "error": "Errors", "success": "Success",
            "defer": "Defer", "reassign": "Reassign", "ci_fix": "CI fix",
            "review": "Review", "audit": "Audit", "audit_error": "Audit",
            "docs": "Docs", "docs_error": "Docs", "cycle": "Cycle",
        }
        # Build filter buttons
        filter_buttons = '<button class="activity-filter active" data-filter="all" onclick="filterActivity(\'all\', this)">All</button>'
        seen_labels = set()
        for et in event_types:
            label = type_labels.get(et, et.replace("_", " ").title())
            if label in seen_labels:
                continue
            seen_labels.add(label)
            is_error = "error" in et
            btn_style = ' style="color:#e74c3c"' if is_error else ""
            filter_buttons += f'<button class="activity-filter" data-filter="{et}"{btn_style} onclick="filterActivity(\'{et}\', this)">{label}</button>'

        # Build event rows
        ae_rows = ""
        for ae in activity_events:
            is_error = "error" in ae["type"]
            row_bg = "background:rgba(231,76,60,0.06);" if is_error else ""
            detail_text = html_mod.escape(ae.get("detail", ""))
            detail_html = f'<div style="color:#8b949e;font-size:12px;margin-top:2px;white-space:pre-wrap;word-break:break-word">{detail_text}</div>' if detail_text else ""

            # Extract ticket identifier from title for drawer link
            title_html = html_mod.escape(ae.get("title", ""))

            ae_rows += f"""<tr class="activity-row" data-type="{ae['type']}" style="{row_bg}">
                <td style="text-align:center">{ae.get('icon', '')}</td>
                <td><span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#21262d;color:#8b949e">{ae['type'].replace('_',' ')}</span></td>
                <td><div>{title_html}</div>{detail_html}</td>
                <td><span class="ts">{ae.get('time', '')}</span></td>
            </tr>"""

        activity_feed_html = f"""
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">{filter_buttons}</div>
        <table>
            <thead><tr><th style="width:30px"></th><th style="width:80px">Type</th><th>Event</th><th style="width:120px">Time</th></tr></thead>
            <tbody>{ae_rows}</tbody>
        </table>"""
    else:
        activity_feed_html = '<div style="color:#8b949e;text-align:center;padding:40px 0;">No activity recorded yet.</div>'

    status_colors = {
        "failed": "#e74c3c",
        "executing": "#f39c12",
        "triaged": "#3498db",
        "deferred": "#95a5a6",
        "reassigned": "#9b59b6",
        "done": "#2ecc71",
    }

    # Build ticket rows HTML
    def ticket_rows(ticket_list, columns):
        if not ticket_list:
            return '<tr><td colspan="99" style="color:#666;text-align:center;">None</td></tr>'
        rows_html = ""
        for t in ticket_list:
            cells = ""
            for col in columns:
                val = t.get(col, "") or ""
                if col == "identifier":
                    linear_id = t.get("linear_id", "")
                    ident = val
                    val = f'<a href="https://linear.app/{LINEAR_WORKSPACE_SLUG}/issue/{val}" target="_blank">{val}</a>'
                    # Clickable to open drawer
                    val += f' <span class="ticket-link" onclick="openDrawer(\'{linear_id}\')" title="View details">🔎</span>'
                    # Add re-assess button for non-active tickets
                    status = t.get("status", "")
                    if status in ("done", "failed", "deferred", "triaged"):
                        val += f' <button id="reassess-{ident}" onclick="reassessTicket(\'{linear_id}\', \'{ident}\')" style="font-size:11px;padding:1px 6px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;cursor:pointer;margin-left:4px;" title="Queue for re-assessment">↻</button>'
                elif col == "pr_url" and val:
                    val = f'<a href="{val}" target="_blank">PR</a>'
                elif col == "triage_result" and val:
                    try:
                        parsed = json.loads(val)
                        confidence = parsed.get("confidence")
                        route_reason = parsed.get("route_reason", "")
                        risks = parsed.get("risks", [])
                        parts = []
                        if confidence is not None:
                            c_color = "#2ecc71" if confidence >= 0.8 else ("#f39c12" if confidence >= 0.6 else "#e74c3c")
                            parts.append(f'<span class="confidence-dot" style="background:{c_color}"></span>{confidence}')
                        if route_reason:
                            parts.append(html_mod.escape(route_reason))
                        if risks:
                            risk_count = len(risks)
                            risk_tooltip = html_mod.escape("; ".join(risks))
                            parts.append(f'<span style="color:#e74c3c;cursor:help" title="{risk_tooltip}">{risk_count} risk{"s" if risk_count != 1 else ""}</span>')
                        val = " &middot; ".join(parts) if parts else parsed.get("implementation_hint", str(val)[:80])
                    except (json.JSONDecodeError, TypeError):
                        val = str(val)[:80]
                elif col == "complexity" and val:
                    val = f"{val}/5"
                elif col == "defer_status" and val:
                    ds_colors = {"awaiting_response": "#f39c12", "exhausted": "#e74c3c"}
                    ds_color = ds_colors.get(val, "#95a5a6")
                    ds_label = val.replace("_", " ").title()
                    val = f'<span style="color:{ds_color};font-weight:600;">{ds_label}</span>'
                elif col == "defer_followup_count":
                    count = val if val else 0
                    val = f"{count}/3"
                elif col.endswith("_at") and val:
                    val = f'<span class="ts">{val}</span>'
                cells += f"<td>{val}</td>"
            rows_html += f"<tr>{cells}</tr>"
        return rows_html

    # Build sections
    sections_html = ""

    section_configs = [
        ("failed", "Failed", ["identifier", "title", "error", "updated_at"]),
        ("executing", "Executing", ["identifier", "title", "complexity", "target_repo", "branch_name"]),
        ("triaged", "Queued", ["identifier", "title", "complexity", "target_repo", "triage_result"]),
        ("deferred", "Deferred", ["identifier", "title", "defer_status", "defer_followup_count", "triage_result", "created_at"]),
        ("reassigned", "Reassigned", ["identifier", "title", "assigned_to_name", "updated_at"]),
        ("done", "Completed", ["identifier", "title", "complexity", "pr_url", "executed_at"]),
    ]

    for status, label, columns in section_configs:
        count = len(tickets.get(status, []))
        color = status_colors.get(status, "#666")
        col_headers = "".join(
            f"<th>{c.replace('_', ' ').title()}</th>" for c in columns
        )
        rows = ticket_rows(tickets.get(status, []), columns)
        sections_html += f"""
        <div class="section">
            <h2><span class="badge" style="background:{color}">{count}</span> {label}</h2>
            <table>
                <thead><tr>{col_headers}</tr></thead>
                <tbody>{rows}</tbody>
            </table>
        </div>
        """

    # Build doc runs HTML
    doc_runs = get_doc_runs()
    completed_docs = [d for d in doc_runs if d.get("status") == "completed" and d.get("pr_url")]
    running_docs = [d for d in doc_runs if d.get("status") in ("running", "queued")]
    if completed_docs or running_docs:
        doc_rows = ""
        for d in completed_docs:
            pr_link = f'<a href="{d["pr_url"]}" target="_blank">PR #{d.get("pr_number", "")}</a>' if d.get("pr_url") else "—"
            finished = f'<span class="ts">{d.get("finished_at", "")}</span>' if d.get("finished_at") else "—"
            doc_rows += f"<tr><td>{html_mod.escape(d.get('ticket_identifier', ''))}</td><td>{d.get('repo', '')}</td><td>{pr_link}</td><td style='color:#2ecc71'>completed</td><td>{finished}</td></tr>"
        for d in running_docs:
            started = f'<span class="ts">{d.get("started_at", "")}</span>' if d.get("started_at") else "—"
            doc_rows += f"<tr><td>{html_mod.escape(d.get('ticket_identifier', ''))}</td><td>{d.get('repo', '')}</td><td>—</td><td style='color:#f39c12'>running</td><td>{started}</td></tr>"
        sections_html += f"""
        <div class="section">
            <h2><span class="badge" style="background:#58a6ff">{len(completed_docs) + len(running_docs)}</span> Documentation PRs</h2>
            <table>
                <thead><tr><th>Ticket</th><th>Repo</th><th>PR</th><th>Status</th><th>Time</th></tr></thead>
                <tbody>{doc_rows}</tbody>
            </table>
        </div>
        """

    # Build teammate rows HTML
    def _duration_display(minutes):
        if minutes < 60:
            return f"{minutes}m"
        hours = minutes // 60
        mins = minutes % 60
        return f"{hours}h {mins}m" if mins else f"{hours}h"

    def _status_dot(status):
        colors = {"healthy": "#2ecc71", "warning": "#f39c12", "stale": "#e74c3c"}
        color = colors.get(status, "#666")
        return f'<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:{color};margin-right:6px;" title="{status}"></span>'

    if teammates:
        teammate_rows = ""
        for tm in teammates:
            dot = _status_dot(tm["status"])
            dur = _duration_display(tm["duration_min"])
            title_text = html_mod.escape(tm.get("title", "")) if tm.get("title") else ""
            target_text = html_mod.escape(tm.get("target", ""))
            context_text = html_mod.escape(tm.get("context", "")) if tm.get("context") else ""
            last_update = tm.get("last_update", "")
            last_update_html = f'<span class="ts">{last_update}</span>' if last_update else "—"

            # Drawer link for executors with linear_id
            linear_id = tm.get("linear_id", "")
            name_cell = f'<strong>{html_mod.escape(tm["name"])}</strong>'
            if linear_id:
                name_cell += f' <span class="ticket-link" onclick="openDrawer(\'{linear_id}\')" title="View ticket details">🔎</span>'

            teammate_rows += f"""<tr>
                <td>{tm['icon']}</td>
                <td>{html_mod.escape(tm['role'])}</td>
                <td>{name_cell}</td>
                <td>{target_text}</td>
                <td>{title_text}</td>
                <td style="color:#8b949e;font-size:12px">{context_text}</td>
                <td>{dur}</td>
                <td>{last_update_html}</td>
                <td>{dot}{tm['status']}</td>
            </tr>"""
        teammates_html = f"""
        <table>
            <thead><tr><th></th><th>Role</th><th>Name</th><th>Target</th><th>Title</th><th>Context</th><th>Duration</th><th>Last update</th><th>Status</th></tr></thead>
            <tbody>{teammate_rows}</tbody>
        </table>
        """
    else:
        teammates_html = '<div style="color:#8b949e;text-align:center;padding:40px 0;font-size:16px;">All quiet — no active teammates</div>'

    # Build work cards HTML
    active_work = [w for w in work_items if w["type"] in ("executor", "explorer")]
    explored_work = [w for w in work_items if w["type"] == "explored"]
    completed_work = [w for w in work_items if w["type"] == "completed"]
    failed_work = [w for w in work_items if w["type"] == "failed"]

    executing_count = sum(1 for w in work_items if w["status"] == "executing")
    exploring_count = sum(1 for w in work_items if w["status"] == "exploring")
    explored_count = len(explored_work)
    active_count = executing_count + exploring_count

    def _work_card(item):
        """Render a single work item as a card."""
        ident = html_mod.escape(item.get("identifier", ""))
        linear_id = item.get("linear_id", "")
        title_text = html_mod.escape(item.get("title", ""))
        repo = html_mod.escape(item.get("repo", ""))
        complexity = item.get("complexity", "?")
        branch = html_mod.escape(item.get("branch", ""))
        icon = item.get("icon", "")
        item_type = item.get("type", "")

        ident_link = f'<a href="https://linear.app/{LINEAR_WORKSPACE_SLUG}/issue/{ident}" target="_blank" style="font-weight:600;color:#58a6ff">{ident}</a>'
        if linear_id:
            ident_link += f' <span class="ticket-link" onclick="openDrawer(\'{linear_id}\')" title="View details">🔎</span>'

        card = f'<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:8px;">'
        # Header line: icon + identifier + repo + complexity
        card += f'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">'
        if item_type in ("executor", "explorer"):
            card += f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#2ecc71;animation:pulse 2s infinite;"></span>'
        card += f'<span style="font-size:16px;">{icon}</span> {ident_link}'
        if repo:
            card += f' <span style="color:#8b949e;">&middot;</span> <span style="color:#c9d1d9;">{repo}</span>'
        card += f' <span style="color:#8b949e;">(C{complexity})</span>'
        card += '</div>'

        # Title
        card += f'<div style="color:#c9d1d9;margin-bottom:6px;font-size:14px;">{title_text}</div>'

        # Type-specific details
        if item_type in ("executor", "explorer"):
            if branch:
                card += f'<div style="font-family:monospace;font-size:12px;color:#8b949e;margin-bottom:4px;">Branch: {branch}</div>'
            dur = item.get("duration_min", 0)
            dur_str = f"{dur // 60}h {dur % 60}m" if dur >= 60 else f"{dur}m"
            last = item.get("last_update", "")
            card += f'<div style="font-size:12px;color:#8b949e;">⏱ {dur_str} &middot; Last update: <span class="ts">{html_mod.escape(last)}</span></div>'
        elif item_type == "explored":
            card += f'<div style="font-size:12px;color:#f39c12;">Findings posted &middot; Awaiting human review</div>'
        elif item_type == "completed":
            pr_url = item.get("pr_url", "")
            pr_number = item.get("pr_number", "")
            review_status = item.get("review_status", "")
            pr_link = f'<a href="{html_mod.escape(pr_url)}" target="_blank">PR #{pr_number}</a>' if pr_url else f"PR #{pr_number}"
            review_text = f' &middot; review: {html_mod.escape(review_status)}' if review_status else ""
            last = item.get("last_update", "")
            card += f'<div style="font-size:12px;color:#8b949e;">{pr_link}{review_text}</div>'
            card += f'<div style="font-size:12px;color:#8b949e;">Completed: <span class="ts">{html_mod.escape(last)}</span></div>'
        elif item_type == "failed":
            error = html_mod.escape(item.get("error", ""))
            if error:
                card += f'<div style="font-size:12px;color:#e74c3c;">Error: {error}</div>'

        card += '</div>'
        return card

    work_html = ""

    # Active work section
    if active_work:
        work_html += '<div class="section"><h2><span class="badge" style="background:#2ecc71">{}</span> Active work</h2>'.format(len(active_work))
        for w in active_work:
            work_html += _work_card(w)
        work_html += '</div>'

    # Explored section
    if explored_work:
        work_html += '<div class="section"><h2><span class="badge" style="background:#f39c12">{}</span> Awaiting review</h2>'.format(len(explored_work))
        for w in explored_work:
            work_html += _work_card(w)
        work_html += '</div>'

    # Recently completed section
    if completed_work:
        work_html += '<div class="section"><h2><span class="badge" style="background:#58a6ff">{}</span> Recently completed</h2>'.format(len(completed_work))
        for w in completed_work:
            work_html += _work_card(w)
        work_html += '</div>'

    # Failed section
    if failed_work:
        work_html += '<div class="section"><h2><span class="badge" style="background:#e74c3c">{}</span> Failed</h2>'.format(len(failed_work))
        for w in failed_work:
            work_html += _work_card(w)
        work_html += '</div>'

    if not work_html:
        work_html = '<div style="color:#8b949e;text-align:center;padding:40px 0;font-size:16px;">No active work</div>'

    # Build models tab HTML
    if _model_tables_exist():
        unrated_runs = get_unrated_model_runs()
        routing_weights_data = get_routing_weights()
        routing_overrides_data = get_routing_overrides()
        model_stats_data = get_model_stats()
        models_unrated_count = len(unrated_runs)
        models_badge_display = "" if models_unrated_count > 0 else "display:none;"

        # Section 1: Unrated runs
        unrated_section = f'<div class="section"><h2 onclick="toggleModelsSection(\'unrated-section-body\')" style="cursor:pointer;"><span class="badge" style="background:#f39c12">{models_unrated_count}</span> Unrated runs <span id="unrated-section-toggle" style="font-size:12px;color:#8b949e;margin-left:4px;">{"▼" if models_unrated_count > 0 else "▶"}</span></h2>'
        unrated_section += f'<div id="unrated-section-body" style="{"" if models_unrated_count > 0 else "display:none;"}">'

        if unrated_runs:
            for run in unrated_runs:
                run_id = run.get("id", "")
                ticket_ident = html_mod.escape(run.get("ticket_identifier", "") or "—")
                skill = html_mod.escape(run.get("skill", ""))
                model = html_mod.escape(run.get("model", ""))
                lang = html_mod.escape(run.get("language", "") or "—")
                complexity = run.get("complexity", "?")
                success = run.get("success", 0)
                tests_passed = run.get("tests_passed")
                ci_passed = run.get("ci_passed")
                tokens = run.get("tokens_used", 0) or 0
                duration = run.get("duration_seconds", 0) or 0
                created = run.get("created_at", "")

                success_icon = "✅" if success else "❌"
                tests_icon = "✅" if tests_passed == 1 else ("❌" if tests_passed == 0 else "⏳")
                ci_icon = "✅" if ci_passed == 1 else ("❌" if ci_passed == 0 else "⏳")

                dur_str = f"{duration // 60}m {duration % 60}s" if duration >= 60 else f"{duration}s"
                tokens_str = f"{tokens:,}" if tokens else "—"

                unrated_section += f'''<div id="run-card-{run_id}" class="model-run-card" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:8px;">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                    <div>
                      <span style="font-weight:600;color:#58a6ff;">{ticket_ident}</span>
                      <span style="color:#8b949e;margin:0 6px;">&middot;</span>
                      <span style="color:#c9d1d9;">{skill}</span>
                      <span style="color:#8b949e;margin:0 6px;">&middot;</span>
                      <span style="color:#d2a8ff;font-family:monospace;font-size:13px;">{model}</span>
                      <span style="color:#8b949e;margin:0 6px;">&middot;</span>
                      <span style="color:#8b949e;">{lang} (C{complexity})</span>
                    </div>
                    <span class="ts" style="font-size:12px;color:#484f58;">{created}</span>
                  </div>
                  <div style="display:flex;gap:16px;align-items:center;margin-bottom:10px;font-size:13px;">
                    <span title="Success">{success_icon} success</span>
                    <span title="Tests">{tests_icon} tests</span>
                    <span title="CI">{ci_icon} CI</span>
                    <span style="color:#8b949e;">🔢 {tokens_str} tokens</span>
                    <span style="color:#8b949e;">⏱ {dur_str}</span>
                  </div>
                  <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
                    <div>
                      <div style="font-size:12px;color:#8b949e;margin-bottom:4px;">Overall rating</div>
                      <div class="star-rating" data-run-id="{run_id}" data-field="main" style="font-size:20px;cursor:pointer;">
                        <span class="star" data-value="1" onclick="setStarRating(this)">☆</span><span class="star" data-value="2" onclick="setStarRating(this)">☆</span><span class="star" data-value="3" onclick="setStarRating(this)">☆</span><span class="star" data-value="4" onclick="setStarRating(this)">☆</span><span class="star" data-value="5" onclick="setStarRating(this)">☆</span>
                      </div>
                    </div>
                    <div style="display:flex;gap:12px;flex-wrap:wrap;">
                      <div>
                        <div style="font-size:11px;color:#484f58;margin-bottom:2px;">Code quality</div>
                        <div class="star-rating" data-run-id="{run_id}" data-field="codeQuality" style="font-size:14px;cursor:pointer;">
                          <span class="star" data-value="1" onclick="setStarRating(this)">☆</span><span class="star" data-value="2" onclick="setStarRating(this)">☆</span><span class="star" data-value="3" onclick="setStarRating(this)">☆</span><span class="star" data-value="4" onclick="setStarRating(this)">☆</span><span class="star" data-value="5" onclick="setStarRating(this)">☆</span>
                        </div>
                      </div>
                      <div>
                        <div style="font-size:11px;color:#484f58;margin-bottom:2px;">Correctness</div>
                        <div class="star-rating" data-run-id="{run_id}" data-field="correctness" style="font-size:14px;cursor:pointer;">
                          <span class="star" data-value="1" onclick="setStarRating(this)">☆</span><span class="star" data-value="2" onclick="setStarRating(this)">☆</span><span class="star" data-value="3" onclick="setStarRating(this)">☆</span><span class="star" data-value="4" onclick="setStarRating(this)">☆</span><span class="star" data-value="5" onclick="setStarRating(this)">☆</span>
                        </div>
                      </div>
                      <div>
                        <div style="font-size:11px;color:#484f58;margin-bottom:2px;">Efficiency</div>
                        <div class="star-rating" data-run-id="{run_id}" data-field="efficiency" style="font-size:14px;cursor:pointer;">
                          <span class="star" data-value="1" onclick="setStarRating(this)">☆</span><span class="star" data-value="2" onclick="setStarRating(this)">☆</span><span class="star" data-value="3" onclick="setStarRating(this)">☆</span><span class="star" data-value="4" onclick="setStarRating(this)">☆</span><span class="star" data-value="5" onclick="setStarRating(this)">☆</span>
                        </div>
                      </div>
                      <div>
                        <div style="font-size:11px;color:#484f58;margin-bottom:2px;">Test quality</div>
                        <div class="star-rating" data-run-id="{run_id}" data-field="testQuality" style="font-size:14px;cursor:pointer;">
                          <span class="star" data-value="1" onclick="setStarRating(this)">☆</span><span class="star" data-value="2" onclick="setStarRating(this)">☆</span><span class="star" data-value="3" onclick="setStarRating(this)">☆</span><span class="star" data-value="4" onclick="setStarRating(this)">☆</span><span class="star" data-value="5" onclick="setStarRating(this)">☆</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center;margin-top:10px;">
                    <input type="text" id="notes-{run_id}" placeholder="Notes (optional)" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;" />
                    <button onclick="submitRating('{run_id}')" style="padding:6px 16px;background:#238636;color:#fff;border:1px solid #2ea043;border-radius:6px;cursor:pointer;font-size:13px;">Submit</button>
                  </div>
                </div>'''
        else:
            unrated_section += '<div style="color:#8b949e;text-align:center;padding:20px 0;">All runs have been rated!</div>'

        unrated_section += '</div></div>'

        # Section 2: Routing weights table
        weights_section = '<div class="section"><h2>Routing weights</h2>'

        if routing_weights_data:
            # Group by task_type+language, collect all models
            all_models = sorted(set(w["model"] for w in routing_weights_data))
            weight_groups = {}
            for w in routing_weights_data:
                lang = w.get("language", "") or ""
                key = f"{w['task_type']}" + (f" ({lang})" if lang and lang != "__any__" else "")
                if key not in weight_groups:
                    weight_groups[key] = {"models": {}, "task_type": w["task_type"], "language": lang}
                weight_groups[key]["models"][w["model"]] = w

            model_headers = "".join(f'<th style="text-align:center;">{html_mod.escape(m)}</th>' for m in all_models)
            weights_section += f'''<table>
              <thead><tr><th>Task type</th>{model_headers}<th style="text-align:center;">Runs</th></tr></thead>
              <tbody>'''

            for key in sorted(weight_groups.keys()):
                group = weight_groups[key]
                cells = f'<td style="font-family:monospace;font-size:13px;">{html_mod.escape(key)}</td>'
                total_runs = 0
                # Find winner for this group
                best_score = -1
                best_model = None
                for m in all_models:
                    if m in group["models"]:
                        s = group["models"][m]["score"]
                        if s > best_score:
                            best_score = s
                            best_model = m

                for m in all_models:
                    if m in group["models"]:
                        w = group["models"][m]
                        score = w["score"]
                        count = w.get("sample_count", 0)
                        total_runs += count
                        if score > 0.8:
                            color = "#2ecc71"
                        elif score >= 0.5:
                            color = "#f39c12"
                        else:
                            color = "#e74c3c"
                        star = " ★" if m == best_model and len(all_models) > 1 else ""
                        cells += f'<td style="text-align:center;color:{color};font-weight:600;">{score:.2f}{star}</td>'
                    else:
                        cells += '<td style="text-align:center;color:#484f58;">—</td>'

                cells += f'<td style="text-align:center;color:#8b949e;">{total_runs}</td>'
                weights_section += f'<tr>{cells}</tr>'

            weights_section += '</tbody></table>'
        else:
            weights_section += '<div style="color:#8b949e;text-align:center;padding:20px 0;">No routing weights recorded yet.</div>'

        # Override form
        override_rows = ""
        for o in routing_overrides_data:
            o_task = html_mod.escape(o.get("task_type", ""))
            o_lang = html_mod.escape(o.get("language", "") or "—")
            o_model = html_mod.escape(o.get("model", ""))
            o_reason = html_mod.escape(o.get("reason", "") or "—")
            o_expires = o.get("expires_at", "")
            o_expires_html = f'<span class="ts">{o_expires}</span>' if o_expires else "Never"
            o_lang_param = f"&language={o.get('language', '')}" if o.get("language") else ""
            override_rows += f'''<tr>
              <td style="font-family:monospace;font-size:13px;">{o_task}</td>
              <td>{o_lang}</td>
              <td style="color:#d2a8ff;font-family:monospace;font-size:13px;">{o_model}</td>
              <td style="color:#8b949e;">{o_reason}</td>
              <td>{o_expires_html}</td>
              <td><button onclick="deleteOverride('{o.get("task_type", "")}', '{o.get("language", "")}')" style="font-size:11px;padding:2px 8px;background:#21262d;color:#e74c3c;border:1px solid #30363d;border-radius:4px;cursor:pointer;">✕</button></td>
            </tr>'''

        weights_section += f'''
        <div style="margin-top:20px;">
          <h3 style="font-size:14px;color:#f0f6fc;margin-bottom:12px;">Routing overrides</h3>
          <table>
            <thead><tr><th>Task type</th><th>Language</th><th>Model</th><th>Reason</th><th>Expires</th><th></th></tr></thead>
            <tbody>{override_rows or '<tr><td colspan="6" style="color:#666;text-align:center;">No overrides set</td></tr>'}</tbody>
          </table>
          <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap;">
            <input type="text" id="override-task-type" placeholder="Task type" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;width:140px;" />
            <input type="text" id="override-language" placeholder="Language (optional)" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;width:140px;" />
            <input type="text" id="override-model" placeholder="Model" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;width:180px;" />
            <input type="text" id="override-reason" placeholder="Reason (optional)" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;width:180px;" />
            <input type="date" id="override-expires" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;width:140px;" title="Expires at (optional)" />
            <button onclick="addOverride()" style="padding:6px 16px;background:#238636;color:#fff;border:1px solid #2ea043;border-radius:6px;cursor:pointer;font-size:13px;">Add override</button>
          </div>
        </div>'''
        weights_section += '</div>'

        # Section 3: Recent performance summary
        stats_section = '<div class="section"><h2>Recent performance (7 days)</h2>'

        overall = model_stats_data.get("overall", {})
        total_runs_7d = overall.get("total_runs", 0) or 0
        total_successes_7d = overall.get("total_successes", 0) or 0
        success_rate_7d = (total_successes_7d / total_runs_7d * 100) if total_runs_7d > 0 else 0
        avg_rating_7d = overall.get("avg_human_rating")
        avg_rating_str = f"{avg_rating_7d:.1f}/5" if avg_rating_7d is not None else "—"

        stats_section += f'''<div style="display:flex;gap:24px;margin-bottom:20px;flex-wrap:wrap;">
          <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px 24px;text-align:center;">
            <div style="font-size:28px;font-weight:700;color:#f0f6fc;">{total_runs_7d}</div>
            <div style="font-size:12px;color:#8b949e;">Total runs</div>
          </div>
          <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px 24px;text-align:center;">
            <div style="font-size:28px;font-weight:700;color:{"#2ecc71" if success_rate_7d >= 80 else ("#f39c12" if success_rate_7d >= 50 else "#e74c3c")};">{success_rate_7d:.0f}%</div>
            <div style="font-size:12px;color:#8b949e;">Success rate</div>
          </div>
          <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px 24px;text-align:center;">
            <div style="font-size:28px;font-weight:700;color:#f0f6fc;">{avg_rating_str}</div>
            <div style="font-size:12px;color:#8b949e;">Avg human rating</div>
          </div>
        </div>'''

        by_model = model_stats_data.get("by_model", [])
        if by_model:
            max_runs_model = max(m.get("runs", 0) or 0 for m in by_model) or 1

            stats_section += '''<table>
              <thead><tr><th>Model</th><th>Runs</th><th>Success rate</th><th>Avg rating</th><th>Avg tokens</th><th style="width:200px;">Success rate</th></tr></thead>
              <tbody>'''

            for m in by_model:
                m_name = html_mod.escape(m.get("model", ""))
                m_runs = m.get("runs", 0) or 0
                m_successes = m.get("successes", 0) or 0
                m_rate = (m_successes / m_runs * 100) if m_runs > 0 else 0
                m_rating = m.get("avg_rating")
                m_rating_str = f"{m_rating:.1f}" if m_rating is not None else "—"
                m_tokens = m.get("avg_tokens")
                m_tokens_str = f"{int(m_tokens):,}" if m_tokens is not None else "—"
                bar_width = int(m_rate * 2)  # max 200px
                bar_color = "#2ecc71" if m_rate >= 80 else ("#f39c12" if m_rate >= 50 else "#e74c3c")
                rate_color = bar_color

                stats_section += f'''<tr>
                  <td style="color:#d2a8ff;font-family:monospace;font-size:13px;">{m_name}</td>
                  <td>{m_runs}</td>
                  <td style="color:{rate_color};font-weight:600;">{m_rate:.0f}%</td>
                  <td>{m_rating_str}</td>
                  <td style="color:#8b949e;">{m_tokens_str}</td>
                  <td><div style="background:#21262d;border-radius:4px;height:16px;width:200px;overflow:hidden;"><div style="background:{bar_color};height:100%;width:{bar_width}px;border-radius:4px;transition:width 0.3s;"></div></div></td>
                </tr>'''

            stats_section += '</tbody></table>'
        else:
            stats_section += '<div style="color:#8b949e;text-align:center;padding:20px 0;">No model run data in the last 7 days.</div>'

        stats_section += '</div>'

        models_html = unrated_section + weights_section + stats_section
    else:
        models_unrated_count = 0
        models_badge_display = "display:none;"
        models_html = '<div style="color:#8b949e;text-align:center;padding:40px 0;font-size:16px;">Migration required — run <span style="font-family:monospace;background:#21262d;padding:2px 8px;border-radius:4px;">scripts/migrate.sh</span> to create model_runs tables.</div>'

    # Digests: expandable rows with rendered markdown and coverage period
    digests_rows = ""
    for i, d in enumerate(digests):
        content = d.get("content") or ""
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        sent = d.get('sent_at', '')
        digest_id = d.get('id', '')

        # Calculate coverage period by comparing to previous digest
        coverage = ""
        if i + 1 < len(digests):
            prev_sent = digests[i + 1].get('sent_at', '')
            if sent and prev_sent:
                try:
                    t1 = datetime.fromisoformat(prev_sent.replace('Z', '+00:00'))
                    t2 = datetime.fromisoformat(sent.replace('Z', '+00:00'))
                    diff_seconds = (t2 - t1).total_seconds()
                    coverage = format_coverage_period(diff_seconds)
                except (ValueError, TypeError):
                    coverage = ""

        # One-line summary: first content line after the title (skip lines starting with #)
        summary_line = ""
        for line in content.split("\n"):
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and not stripped.startswith("<!--"):
                summary_line = stripped[:120]
                if len(stripped) > 120:
                    summary_line += "…"
                break

        coverage_badge = f'<span style="background:#21262d;color:#8b949e;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:8px;">covers {html_mod.escape(coverage)}</span>' if coverage else ''

        rendered_content = render_digest_markdown(content)

        digests_rows += f"""<tr class="digest-row" data-digest-id="{digest_id}" onclick="toggleDigest({digest_id})" style="cursor:pointer;">
            <td style="white-space:nowrap;"><span class="ts">{sent}</span>{coverage_badge}</td>
            <td style="font-size:13px;color:#c9d1d9;">{html_mod.escape(summary_line)}</td>
            <td style="width:30px;text-align:center;"><span class="digest-toggle" id="digest-toggle-{digest_id}" style="font-size:12px;color:#8b949e;">▶</span></td>
        </tr>
        <tr class="digest-detail-row" id="digest-detail-{digest_id}" style="display:none;">
            <td colspan="3" style="padding:0 !important;border-top:none !important;">
                <div style="background:#1c2129;padding:16px 20px;border-top:1px dashed #30363d;">
                    {rendered_content}
                </div>
            </td>
        </tr>"""

    # Stats badges
    stats_html = " ".join(
        f'<span class="stat"><span class="badge" style="background:{status_colors.get(s,"#666")}">{c}</span> {s}</span>'
        for s, c in stats.items()
    )

    last_act_html = ""
    if last_activity:
        la_detail = html_mod.escape(last_activity['detail'])
        if len(la_detail) > 120:
            la_detail = la_detail[:120] + "…"
        last_act_html = f'{last_activity["icon"]} {html_mod.escape(last_activity["text"])} <span style="color:#484f58">(<span class="ts">{html_mod.escape(last_activity["time"])}</span>)</span>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Marvin Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link id="favicon" rel="icon" type="image/png" href="{FAVICON_DATA_URI}">
<style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }}
    .header {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 24px; overflow: hidden; }}
    .header-top {{ display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; }}
    .header-title-group .header-title {{ font-size: 20px; font-weight: 700; color: #f0f6fc; line-height: 1.2; }}
    .header-title-group .header-subtitle {{ font-size: 13px; color: #8b949e; margin-top: 2px; }}
    .header-activity {{ font-size: 13px; color: #8b949e; text-align: right; max-width: 50%; }}
    .header-stats {{ display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 20px; border-top: 1px solid #21262d; }}
    .stat {{ display: flex; align-items: center; gap: 6px; font-size: 14px; }}
    .badge {{ display: inline-block; min-width: 24px; padding: 2px 8px; border-radius: 12px; color: #fff; font-weight: 600; font-size: 13px; text-align: center; }}
    .section {{ margin-bottom: 32px; }}
    .section h2 {{ font-size: 18px; margin-bottom: 12px; color: #f0f6fc; display: flex; align-items: center; gap: 8px; }}
    table {{ width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; }}
    th {{ background: #1c2129; text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.5px; }}
    td {{ padding: 10px 12px; border-top: 1px solid #21262d; font-size: 14px; max-width: 400px; overflow: hidden; text-overflow: ellipsis; }}
    tr:hover td {{ background: #1c2129; }}
    a {{ color: #58a6ff; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .tabs {{ display: flex; gap: 0; margin-bottom: 24px; border-bottom: 1px solid #30363d; }}
    .tab {{ padding: 10px 20px; cursor: pointer; color: #8b949e; border-bottom: 2px solid transparent; font-size: 14px; }}
    .tab:hover {{ color: #c9d1d9; }}
    .tab.active {{ color: #f0f6fc; border-bottom-color: #f78166; }}
    .tab-content {{ display: none; }}
    .tab-content.active {{ display: block; }}
    @keyframes pulse {{ 0%, 100% {{ opacity: 1; }} 50% {{ opacity: 0.4; }} }}
    /* Ticket detail drawer */
    .drawer-overlay {{ position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999; display: none; }}
    .drawer-overlay.open {{ display: block; }}
    .drawer {{ position: fixed; top: 0; right: 0; width: 600px; max-width: 90vw; height: 100vh; background: #161b22; border-left: 1px solid #30363d; z-index: 1000; transform: translateX(100%); transition: transform 0.2s ease; overflow-y: auto; display: flex; flex-direction: column; }}
    .drawer.open {{ transform: translateX(0); }}
    .drawer-header {{ display: flex; justify-content: space-between; align-items: flex-start; padding: 20px; border-bottom: 1px solid #30363d; flex-shrink: 0; }}
    .drawer-header h2 {{ font-size: 16px; color: #f0f6fc; margin: 0; line-height: 1.4; }}
    .drawer-close {{ background: none; border: none; color: #8b949e; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }}
    .drawer-close:hover {{ background: #21262d; color: #f0f6fc; }}
    .drawer-body {{ padding: 20px; flex: 1; overflow-y: auto; }}
    .drawer-card {{ background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }}
    .drawer-card h3 {{ font-size: 13px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.5px; margin-bottom: 12px; }}
    .drawer-field {{ display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px; }}
    .drawer-field-label {{ color: #8b949e; min-width: 100px; flex-shrink: 0; }}
    .drawer-field-value {{ color: #c9d1d9; word-break: break-word; }}
    .drawer-badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }}
    .drawer-risk {{ display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-right: 4px; }}
    .confidence-dot {{ display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }}
    .timeline-item {{ display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #21262d; font-size: 13px; }}
    .timeline-item:last-child {{ border-bottom: none; }}
    .timeline-icon {{ flex-shrink: 0; width: 24px; text-align: center; }}
    .timeline-time {{ color: #484f58; min-width: 60px; flex-shrink: 0; }}
    .timeline-content {{ flex: 1; }}
    .timeline-summary {{ color: #c9d1d9; }}
    .timeline-detail {{ color: #8b949e; margin-top: 4px; font-size: 12px; word-break: break-word; white-space: pre-wrap; }}
    .drawer-comment {{ background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 8px; }}
    .drawer-comment-header {{ display: flex; gap: 8px; align-items: center; font-size: 12px; color: #8b949e; margin-bottom: 6px; }}
    .drawer-comment-body {{ font-size: 13px; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }}
    .drawer-comment-status {{ font-size: 11px; padding: 1px 6px; border-radius: 3px; font-weight: 600; }}
    .drawer-loading {{ text-align: center; color: #8b949e; padding: 40px 0; }}
    .ticket-link {{ cursor: pointer; }}
    .ticket-link:hover {{ text-decoration: underline; }}
    /* Activity filter buttons */
    .activity-filter {{ font-size: 12px; padding: 4px 12px; background: #21262d; color: #8b949e; border: 1px solid #30363d; border-radius: 16px; cursor: pointer; }}
    .activity-filter:hover {{ color: #c9d1d9; border-color: #484f58; }}
    .activity-filter.active {{ background: #30363d; color: #f0f6fc; border-color: #484f58; }}
    /* Star rating */
    .star-rating .star {{ color: #484f58; transition: color 0.1s; user-select: none; }}
    .star-rating .star:hover, .star-rating .star.hovered {{ color: #f39c12; }}
    .star-rating .star.filled {{ color: #f39c12; }}
    .model-run-card.rated {{ opacity: 0.5; border-color: #2ecc71; }}
    /* Assist tab styles */
    .assist-connection-status {{ position: absolute; top: 12px; right: 16px; font-size: 12px; display: flex; align-items: center; gap: 6px; }}
    .assist-connection-dot {{ display: inline-block; width: 8px; height: 8px; border-radius: 50%; }}
    .assist-section {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }}
    .assist-section h3 {{ font-size: 14px; color: #f0f6fc; margin-bottom: 12px; }}
    .assist-form-row {{ display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }}
    .assist-select {{ background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; color: #c9d1d9; font-size: 13px; min-width: 140px; }}
    .assist-textarea {{ width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; color: #c9d1d9; font-size: 13px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; resize: vertical; min-height: 80px; }}
    .assist-btn {{ padding: 6px 16px; background: #238636; color: #fff; border: 1px solid #2ea043; border-radius: 6px; cursor: pointer; font-size: 13px; }}
    .assist-btn:hover {{ background: #2ea043; }}
    .assist-btn:disabled {{ opacity: 0.5; cursor: not-allowed; }}
    .assist-btn-danger {{ background: #b60205; border-color: #da3633; }}
    .assist-btn-danger:hover {{ background: #da3633; }}
    .assist-btn-secondary {{ background: #21262d; border-color: #30363d; color: #c9d1d9; }}
    .assist-btn-secondary:hover {{ background: #30363d; }}
    .assist-agent-card {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }}
    .assist-agent-header {{ display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #21262d; }}
    .assist-agent-header-left {{ display: flex; align-items: center; gap: 8px; }}
    .assist-agent-status {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }}
    .assist-agent-status.running {{ background: #0d2818; color: #2ecc71; border: 1px solid #1a4d2e; }}
    .assist-agent-status.completed {{ background: #21262d; color: #8b949e; }}
    .assist-agent-status.failed {{ background: #2d0a0a; color: #e74c3c; border: 1px solid #4d1414; }}
    .assist-output-stream {{ background: #0d1117; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 12px; max-height: 400px; overflow-y: auto; padding: 12px; line-height: 1.6; }}
    .assist-output-entry {{ margin-bottom: 4px; word-break: break-word; white-space: pre-wrap; }}
    .assist-output-time {{ color: #484f58; }}
    .assist-output-tool-call {{ color: #58a6ff; }}
    .assist-output-tool-result {{ color: #2ecc71; }}
    .assist-output-thinking {{ color: #d2a8ff; }}
    .assist-output-text {{ color: #c9d1d9; }}
    .assist-output-error {{ color: #e74c3c; }}
    .assist-output-expandable {{ cursor: pointer; }}
    .assist-output-expandable:hover {{ text-decoration: underline; }}
    .assist-message-row {{ display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #21262d; }}
    .assist-message-input {{ flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; color: #c9d1d9; font-size: 13px; }}
    .assist-agent-actions {{ display: flex; gap: 8px; padding: 8px 16px; border-top: 1px solid #21262d; }}
    .assist-completed-section {{ margin-top: 16px; }}
    .assist-completed-toggle {{ cursor: pointer; display: flex; align-items: center; gap: 8px; color: #8b949e; font-size: 13px; margin-bottom: 8px; }}
    .assist-completed-toggle:hover {{ color: #c9d1d9; }}
    .assist-no-server {{ text-align: center; padding: 40px 20px; color: #8b949e; }}
    .assist-no-server code {{ background: #21262d; padding: 2px 8px; border-radius: 4px; font-family: monospace; color: #c9d1d9; }}
</style>
</head>
<body>
    <div class="header">
      <div class="header-top">
        <div style="display:flex;align-items:center;gap:12px">
          <img src="{MASCOT_DATA_URI}" height="36" style="border-radius:6px;object-fit:contain;" alt="Marvin" />
          <div class="header-title-group">
            <div class="header-title">Marvin</div>
            <div class="header-subtitle"><span class="ts">{now}</span> &middot; refreshes every 60s</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div class="header-activity">{last_act_html}</div>
          <button id="run-cycle-btn" onclick="runCycle()" style="font-size:12px;padding:4px 12px;background:#238636;color:#fff;border:1px solid #2ea043;border-radius:6px;cursor:pointer;white-space:nowrap;" title="Start a Marvin cycle now">▶ Run cycle</button>
        </div>
      </div>
      <div class="header-stats">
        <span class="stat"><strong>{total}</strong>&nbsp;tickets</span>
        {stats_html}
        <span style="border-left:1px solid #30363d;margin:0 4px;">&nbsp;</span>
        <span class="stat"><strong>{active_count}</strong>&nbsp;active</span>
        <span class="stat"><span class="badge" style="background:#2ecc71">{executing_count}</span> executing</span>
        <span class="stat"><span class="badge" style="background:#58a6ff">{exploring_count}</span> exploring</span>
        <span class="stat"><span class="badge" style="background:#f39c12">{explored_count}</span> awaiting review</span>
        <span style="border-left:1px solid #30363d;margin:0 4px;">&nbsp;</span>
        <span class="stat"><span class="badge" style="background:#9b59b6">{teammate_count}</span> teammates</span>
        {'<span class="stat"><span class="badge" style="background:#e74c3c">' + str(stale_count) + '</span> stale</span>' if stale_count > 0 else ''}
      </div>
    </div>

    {health_banner}

    <div class="tabs">
        <div class="tab active" data-tab="tickets" onclick="switchTab('tickets')">Tickets</div>
        <div class="tab" data-tab="teammates" onclick="switchTab('teammates')">Teammates ({teammate_count})</div>
        <div class="tab" data-tab="models" onclick="switchTab('models')">Models <span id="models-unrated-badge" class="badge" style="background:#f39c12;font-size:11px;vertical-align:middle;margin-left:4px;{models_badge_display}">{models_unrated_count}</span></div>
        <div class="tab" data-tab="work" onclick="switchTab('work')">Work ({active_count})</div>
        <div class="tab" data-tab="digests" onclick="switchTab('digests')">Digests</div>
        <div class="tab" data-tab="log" onclick="switchTab('log')">Log</div>
        <div class="tab" data-tab="assist" onclick="switchTab('assist')">Assist</div>
    </div>

    <div id="tickets" class="tab-content active">
        {sections_html}
    </div>

    <div id="teammates" class="tab-content">
        {teammates_html}
    </div>

    <div id="models" class="tab-content">
        {models_html}
    </div>

    <div id="work" class="tab-content">
        {work_html}
    </div>

    <div id="digests" class="tab-content">
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
            <button onclick="toggleAllDigests()" id="digest-expand-all-btn" style="font-size:12px;padding:4px 12px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:16px;cursor:pointer;">Expand all</button>
        </div>
        <table>
            <thead><tr><th>Sent</th><th>Summary</th><th></th></tr></thead>
            <tbody>{digests_rows or '<tr><td colspan="3" style="color:#666;text-align:center;">No digests yet</td></tr>'}</tbody>
        </table>
    </div>

    <div id="log" class="tab-content">
        {activity_feed_html}
    </div>

    <div id="assist" class="tab-content" style="position:relative;">
        <div class="assist-connection-status">
            <span id="assist-conn-dot" class="assist-connection-dot" style="background:#e74c3c;"></span>
            <span id="assist-conn-label" style="color:#8b949e;">Disconnected</span>
        </div>

        <div id="assist-no-server" class="assist-no-server">
            <div style="font-size:32px;margin-bottom:16px;">🔌</div>
            <div style="font-size:16px;color:#f0f6fc;margin-bottom:8px;">Realtime server not connected</div>
            <div>Start the realtime server to use Assist:</div>
            <div style="margin-top:12px;"><code>npx tsx runtime/src/realtime/server.ts</code></div>
        </div>

        <div id="assist-content" style="display:none;">
            <div class="assist-section">
                <h3>Spawn agent</h3>
                <div class="assist-form-row">
                    <div>
                        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px;">Skill</label>
                        <select id="assist-skill" class="assist-select" onchange="assistUpdateArgTemplate()">
                            <option value="execute">execute</option>
                            <option value="explore">explore</option>
                            <option value="review">review</option>
                            <option value="ci_fix">ci_fix</option>
                            <option value="audit">audit</option>
                            <option value="docs">docs</option>
                            <option value="triage">triage</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px;">Model</label>
                        <select id="assist-model" class="assist-select">
                            <option value="auto">auto</option>
                            <option value="claude-opus">claude-opus</option>
                            <option value="gpt5-codex">gpt5-codex</option>
                            <option value="gemini-pro">gemini-pro</option>
                        </select>
                    </div>
                </div>
                <div style="margin-bottom:12px;">
                    <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:4px;">Arguments (JSON)</label>
                    <textarea id="assist-args" class="assist-textarea">{{
  "linear_id": "",
  "identifier": ""
}}</textarea>
                </div>
                <button id="assist-launch-btn" class="assist-btn" onclick="assistLaunchAgent()" disabled>Launch agent</button>
            </div>

            <div id="assist-running-section">
                <div class="section" style="margin-bottom:12px;">
                    <h2>Running agents</h2>
                </div>
                <div id="assist-running-agents">
                    <div style="color:#8b949e;text-align:center;padding:20px 0;">No running agents</div>
                </div>
            </div>

            <div id="assist-completed-section" class="assist-completed-section" style="display:none;">
                <div class="assist-completed-toggle" onclick="assistToggleCompleted()">
                    <span id="assist-completed-toggle-icon">▶</span>
                    <span>Completed agents (<span id="assist-completed-count">0</span>)</span>
                </div>
                <div id="assist-completed-agents" style="display:none;"></div>
            </div>
        </div>
    </div>

    <div id="drawer-overlay" class="drawer-overlay" onclick="closeDrawer()"></div>
    <div id="ticket-drawer" class="drawer">
        <div class="drawer-header">
            <div id="drawer-header-content"></div>
            <button class="drawer-close" onclick="closeDrawer()">&times;</button>
        </div>
        <div class="drawer-body" id="drawer-body">
            <div class="drawer-loading">Loading...</div>
        </div>
    </div>

    <script>
    function switchTab(name) {{
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
        document.getElementById(name).classList.add('active');
        document.querySelector('.tab[data-tab="' + name + '"]').classList.add('active');
        if (name === 'assist') {{ assistConnect(); }}
    }}
    // Ticket detail drawer
    var _drawerLinearId = null;
    function openDrawer(linearId) {{
        _drawerLinearId = linearId;
        document.getElementById('drawer-overlay').classList.add('open');
        document.getElementById('ticket-drawer').classList.add('open');
        document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Loading...</div>';
        document.getElementById('drawer-header-content').innerHTML = '';
        fetch('/api/ticket/' + linearId).then(r => r.json()).then(function(data) {{
            if (data.error) {{
                document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Ticket not found</div>';
                return;
            }}
            renderDrawer(data);
        }}).catch(function() {{
            document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Failed to load</div>';
        }});
    }}
    function closeDrawer() {{
        _drawerLinearId = null;
        document.getElementById('drawer-overlay').classList.remove('open');
        document.getElementById('ticket-drawer').classList.remove('open');
    }}
    function escapeHtml(s) {{
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }}
    function confidenceColor(c) {{
        if (c >= 0.8) return '#2ecc71';
        if (c >= 0.6) return '#f39c12';
        return '#e74c3c';
    }}
    function renderDrawer(data) {{
        var t = data.ticket;
        var tr = data.triage || {{}};
        var statusColors = {{'failed':'#e74c3c','executing':'#f39c12','triaged':'#3498db','deferred':'#95a5a6','reassigned':'#9b59b6','done':'#2ecc71'}};
        var statusColor = statusColors[t.status] || '#666';

        // Header
        var headerHtml = '<h2>' + escapeHtml(t.identifier) + ' — ' + escapeHtml(t.title) + '</h2>';
        headerHtml += '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">';
        headerHtml += '<span class="drawer-badge" style="background:' + statusColor + ';color:#fff">' + escapeHtml(t.status) + '</span>';
        if (t.complexity) headerHtml += '<span class="drawer-badge" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d">C' + t.complexity + '/5</span>';
        headerHtml += '<a href="https://linear.app/{LINEAR_WORKSPACE_SLUG}/issue/' + escapeHtml(t.identifier) + '" target="_blank" style="font-size:12px">Open in Linear ↗</a>';
        headerHtml += '</div>';
        document.getElementById('drawer-header-content').innerHTML = headerHtml;

        var body = '';

        // Triage card
        if (tr.route || tr.route_reason) {{
            body += '<div class="drawer-card"><h3>Triage reasoning</h3>';
            if (tr.route) {{
                body += '<div class="drawer-field"><span class="drawer-field-label">Route</span><span class="drawer-field-value"><strong>' + escapeHtml(tr.route) + '</strong></span></div>';
            }}
            if (tr.route_reason) {{
                body += '<div class="drawer-field"><span class="drawer-field-label">Reason</span><span class="drawer-field-value">' + escapeHtml(tr.route_reason) + '</span></div>';
            }}
            if (tr.confidence !== undefined && tr.confidence !== null) {{
                var cc = confidenceColor(tr.confidence);
                body += '<div class="drawer-field"><span class="drawer-field-label">Confidence</span><span class="drawer-field-value"><span class="confidence-dot" style="background:' + cc + '"></span>' + tr.confidence + '</span></div>';
            }}
            if (tr.target_repo || t.target_repo) {{
                body += '<div class="drawer-field"><span class="drawer-field-label">Target repo</span><span class="drawer-field-value">' + escapeHtml(tr.target_repo || t.target_repo) + '</span></div>';
            }}
            if (tr.affected_paths && tr.affected_paths.length) {{
                body += '<div class="drawer-field"><span class="drawer-field-label">Affected paths</span><span class="drawer-field-value">' + tr.affected_paths.map(function(p) {{ return escapeHtml(p); }}).join('<br>') + '</span></div>';
            }}
            if (tr.risks && tr.risks.length) {{
                body += '<div class="drawer-field"><span class="drawer-field-label">Risks</span><span class="drawer-field-value">';
                tr.risks.forEach(function(r) {{ body += '• ' + escapeHtml(r) + '<br>'; }});
                body += '</span></div>';
            }}
            if (tr.implementation_hint) {{
                body += '<div class="drawer-field"><span class="drawer-field-label">Hint</span><span class="drawer-field-value" style="color:#58a6ff">' + escapeHtml(tr.implementation_hint) + '</span></div>';
            }}
            body += '</div>';
        }}

        // PR card(s)
        if (data.prs && data.prs.length) {{
            data.prs.forEach(function(pr) {{
                body += '<div class="drawer-card"><h3>PR #' + pr.pr_number + '</h3>';
                body += '<div class="drawer-field"><span class="drawer-field-label">Title</span><span class="drawer-field-value"><a href="' + escapeHtml(pr.url) + '" target="_blank">' + escapeHtml(pr.title) + ' ↗</a></span></div>';
                body += '<div class="drawer-field"><span class="drawer-field-label">Branch</span><span class="drawer-field-value" style="font-family:monospace;font-size:12px">' + escapeHtml(pr.head_branch) + '</span></div>';
                var ciColors = {{'success':'#2ecc71','failure':'#e74c3c','pending':'#f39c12'}};
                var ciColor = ciColors[pr.ci_status] || '#666';
                body += '<div class="drawer-field"><span class="drawer-field-label">CI</span><span class="drawer-field-value" style="color:' + ciColor + '">' + escapeHtml(pr.ci_status || '—') + '</span></div>';
                var reviewDisplay = (pr.review_decision || '—').replace(/_/g, ' ').toLowerCase();
                body += '<div class="drawer-field"><span class="drawer-field-label">Review</span><span class="drawer-field-value">' + escapeHtml(reviewDisplay) + '</span></div>';
                body += '<div class="drawer-field"><span class="drawer-field-label">Threads</span><span class="drawer-field-value">' + (pr.unresolved_threads || 0) + ' unresolved</span></div>';
                if (pr.audit_risk) {{
                    var riskColors = {{'low':'#0e8a16','medium':'#fbca04','high':'#b60205'}};
                    var riskColor = riskColors[pr.audit_risk] || '#95a5a6';
                    body += '<div class="drawer-field"><span class="drawer-field-label">Audit</span><span class="drawer-field-value"><span class="drawer-risk" style="background:' + riskColor + '22;color:' + riskColor + '">' + escapeHtml(pr.audit_risk) + '</span> <span class="drawer-risk" style="background:#21262d;color:#c9d1d9">' + escapeHtml(pr.audit_size || '') + '</span></span></div>';
                }}
                if (pr.ci_fix_count > 0) {{
                    body += '<div class="drawer-field"><span class="drawer-field-label">CI fixes</span><span class="drawer-field-value">' + pr.ci_fix_count + '/5 attempts, status: ' + escapeHtml(pr.ci_fix_status || '—') + '</span></div>';
                }}
                var mergeColors = {{'MERGEABLE':'#2ecc71','CONFLICTING':'#e74c3c','UNKNOWN':'#95a5a6'}};
                var mergeColor = mergeColors[pr.mergeable] || '#666';
                body += '<div class="drawer-field"><span class="drawer-field-label">Merge</span><span class="drawer-field-value" style="color:' + mergeColor + '">' + escapeHtml(pr.mergeable || '—') + '</span></div>';
                if (pr.behind_by > 0) {{
                    body += '<div class="drawer-field"><span class="drawer-field-label">Behind main</span><span class="drawer-field-value">' + pr.behind_by + ' commits</span></div>';
                }}
                if (pr.rebase_count > 0) {{
                    body += '<div class="drawer-field"><span class="drawer-field-label">Rebase</span><span class="drawer-field-value">' + pr.rebase_count + '/3 attempts, status: ' + escapeHtml(pr.rebase_status || '—') + '</span></div>';
                }}
                body += '</div>';
            }});
        }}

        // Timeline
        if (data.timeline && data.timeline.length) {{
            body += '<div class="drawer-card"><h3>Timeline</h3>';
            data.timeline.forEach(function(ev) {{
                var timeStr = ev.time ? '<span class="ts">' + escapeHtml(ev.time) + '</span>' : '';
                var detailHtml = ev.detail ? '<div class="timeline-detail">' + escapeHtml(ev.detail) + '</div>' : '';
                var evTypeClass = '';
                if (ev.type && (ev.type.indexOf('error') >= 0 || ev.type === 'ci_fix_error' || ev.type === 'review_error')) {{
                    evTypeClass = ' style="background:rgba(231,76,60,0.08);border-radius:4px;padding:10px 8px;"';
                }}
                body += '<div class="timeline-item"' + evTypeClass + '>';
                body += '<span class="timeline-icon">' + (ev.icon || '') + '</span>';
                body += '<span class="timeline-time">' + timeStr + '</span>';
                body += '<div class="timeline-content"><div class="timeline-summary">' + escapeHtml(ev.summary) + '</div>' + detailHtml + '</div>';
                body += '</div>';
            }});
            body += '</div>';
        }}

        // Review comments
        if (data.comments && data.comments.length) {{
            body += '<div class="drawer-card"><h3>Review comments (' + data.comments.length + ')</h3>';
            data.comments.forEach(function(rc) {{
                var path = rc.path || '';
                var line = rc.line || '';
                var loc = path && line ? path + ':' + line : (path || 'general');
                var statusColor = rc.status === 'addressed' ? '#2ecc71' : '#f39c12';
                var statusLabel = rc.status || 'pending';
                body += '<div class="drawer-comment">';
                body += '<div class="drawer-comment-header">';
                body += '<strong>@' + escapeHtml(rc.author || '?') + '</strong>';
                body += '<span style="color:#484f58">' + escapeHtml(loc) + '</span>';
                body += '<span class="drawer-comment-status" style="background:' + statusColor + '22;color:' + statusColor + '">' + escapeHtml(statusLabel) + '</span>';
                body += '</div>';
                body += '<div class="drawer-comment-body">' + escapeHtml(rc.body) + '</div>';
                if (rc.response_body) {{
                    body += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #21262d;">';
                    body += '<div style="font-size:11px;color:#8b949e;margin-bottom:4px;">Marvin\\\'s response:</div>';
                    body += '<div class="drawer-comment-body" style="color:#58a6ff">' + escapeHtml(rc.response_body) + '</div>';
                    body += '</div>';
                }}
                body += '</div>';
            }});
            body += '</div>';
        }}

        document.getElementById('drawer-body').innerHTML = body;
        localizeTimestamps();
    }}
    function toggleDigest(id) {{
        var row = document.getElementById('digest-detail-' + id);
        var toggle = document.getElementById('digest-toggle-' + id);
        if (row) {{
            var isHidden = row.style.display === 'none';
            row.style.display = isHidden ? '' : 'none';
            if (toggle) toggle.textContent = isHidden ? '▼' : '▶';
        }}
    }}
    function toggleAllDigests() {{
        var rows = document.querySelectorAll('.digest-detail-row');
        var btn = document.getElementById('digest-expand-all-btn');
        var anyHidden = false;
        rows.forEach(function(r) {{ if (r.style.display === 'none') anyHidden = true; }});
        rows.forEach(function(r) {{
            r.style.display = anyHidden ? '' : 'none';
        }});
        document.querySelectorAll('.digest-toggle').forEach(function(t) {{
            t.textContent = anyHidden ? '▼' : '▶';
        }});
        if (btn) btn.textContent = anyHidden ? 'Collapse all' : 'Expand all';
    }}
    function reassessTicket(linearId, identifier) {{
        if (!confirm('Re-assess ' + identifier + '?')) return;
        fetch('/api/reassess', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{linear_id: linearId, identifier: identifier}})
        }}).then(function(r) {{
            if (r.ok) {{
                var btn = document.getElementById('reassess-' + identifier);
                if (btn) {{ btn.textContent = '✓ Queued'; btn.disabled = true; btn.style.opacity = '0.5'; }}
            }}
        }});
    }}
    function runCycle() {{
        var btn = document.getElementById('run-cycle-btn');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '⏳ Starting…';
        btn.style.background = '#21262d';
        btn.style.borderColor = '#30363d';
        fetch('/api/run-cycle', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}}
        }}).then(function(r) {{
            if (r.ok) {{
                btn.textContent = '✓ Started';
                btn.style.background = '#1a7f37';
                setTimeout(function() {{
                    btn.disabled = false;
                    btn.textContent = '▶ Run cycle';
                    btn.style.background = '#238636';
                    btn.style.borderColor = '#2ea043';
                }}, 10000);
            }} else {{
                btn.textContent = '✗ Failed';
                btn.style.background = '#b60205';
                setTimeout(function() {{
                    btn.disabled = false;
                    btn.textContent = '▶ Run cycle';
                    btn.style.background = '#238636';
                    btn.style.borderColor = '#2ea043';
                }}, 5000);
            }}
        }}).catch(function() {{
            btn.disabled = false;
            btn.textContent = '▶ Run cycle';
            btn.style.background = '#238636';
            btn.style.borderColor = '#2ea043';
        }});
    }}
    function filterActivity(type, btn) {{
        document.querySelectorAll('.activity-filter').forEach(function(b) {{ b.classList.remove('active'); }});
        btn.classList.add('active');
        document.querySelectorAll('.activity-row').forEach(function(row) {{
            if (type === 'all') {{
                row.style.display = '';
            }} else {{
                // Match exact type or type family (e.g. 'audit' matches 'audit' and 'audit_error')
                var rowType = row.dataset.type || '';
                row.style.display = (rowType === type || rowType.startsWith(type + '_') || rowType === type + '_error') ? '' : 'none';
            }}
        }});
    }}
    function localizeTimestamps() {{
        document.querySelectorAll('.ts').forEach(function(el) {{
            var raw = el.textContent.trim();
            if (!raw || el.dataset.done) return;
            var d = new Date(raw.replace(' ', 'T').replace(/Z?$/, 'Z'));
            if (isNaN(d.getTime())) return;
            var now = new Date();
            var diff = now - d;
            var mins = Math.floor(diff / 60000);
            // Relative for recent, absolute for older
            if (mins < 1) {{
                el.textContent = 'just now';
            }} else if (mins < 60) {{
                el.textContent = mins + 'm ago';
            }} else if (mins < 1440) {{
                var hrs = Math.floor(mins / 60);
                el.textContent = hrs + 'h ' + (mins % 60) + 'm ago';
            }} else {{
                el.textContent = d.toLocaleDateString(undefined, {{month:'short', day:'numeric'}}) + ' ' + d.toLocaleTimeString(undefined, {{hour:'2-digit', minute:'2-digit'}});
            }}
            el.title = d.toLocaleString();
            el.dataset.done = '1';
        }});
    }}
    // Dynamic favicon with status dot
    var _faviconBase = '{FAVICON_DATA_URI}';
    var _faviconCanvas = document.createElement('canvas');
    _faviconCanvas.width = 32;
    _faviconCanvas.height = 32;
    var _faviconCtx = _faviconCanvas.getContext('2d');
    var _faviconImg = new Image();
    var _faviconReady = false;
    _faviconImg.onload = function() {{ _faviconReady = true; updateFavicon(); }};
    _faviconImg.src = _faviconBase;
    function updateFavicon() {{
        if (!_faviconReady) return;
        var banner = document.querySelector('.health-banner');
        var health = banner ? banner.dataset.health : 'dead';
        var teammates = banner ? parseInt(banner.dataset.teammates || '0') : 0;
        var dotColor;
        if (health === 'dead' || health === 'unknown') {{
            dotColor = '#e74c3c';
        }} else if (teammates > 0) {{
            dotColor = '#3498db';
        }} else {{
            dotColor = '#2ecc71';
        }}
        _faviconCtx.clearRect(0, 0, 32, 32);
        _faviconCtx.drawImage(_faviconImg, 0, 0, 32, 32);
        _faviconCtx.beginPath();
        _faviconCtx.arc(25, 25, 6, 0, Math.PI * 2);
        _faviconCtx.fillStyle = dotColor;
        _faviconCtx.fill();
        _faviconCtx.strokeStyle = '#0d1117';
        _faviconCtx.lineWidth = 2;
        _faviconCtx.stroke();
        var link = document.getElementById('favicon');
        if (link) link.href = _faviconCanvas.toDataURL('image/png');
        var prefix = teammates > 0 ? '⚡ ' : (health === 'dead' ? '❌ ' : '');
        document.title = prefix + 'Marvin Dashboard';
    }}
    localizeTimestamps();
    updateFavicon();
    // Model rating state — tracks star selections per run before submit
    var _modelRatings = {{}};
    function setStarRating(starEl) {{
        var container = starEl.parentElement;
        var runId = container.dataset.runId;
        var field = container.dataset.field;
        var value = parseInt(starEl.dataset.value);
        if (!_modelRatings[runId]) _modelRatings[runId] = {{}};
        _modelRatings[runId][field] = value;
        // Update star display
        container.querySelectorAll('.star').forEach(function(s) {{
            var sv = parseInt(s.dataset.value);
            s.textContent = sv <= value ? '★' : '☆';
            s.classList.toggle('filled', sv <= value);
        }});
    }}
    function submitRating(runId) {{
        var ratings = _modelRatings[runId] || {{}};
        if (!ratings.main) {{
            alert('Please select an overall rating (1-5 stars)');
            return;
        }}
        var notesEl = document.getElementById('notes-' + runId);
        var body = {{
            humanRating: ratings.main,
            humanNotes: notesEl ? notesEl.value : null,
            codeQuality: ratings.codeQuality || null,
            correctness: ratings.correctness || null,
            efficiency: ratings.efficiency || null,
            testQuality: ratings.testQuality || null
        }};
        fetch('/api/model-runs/' + runId + '/rate', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify(body)
        }}).then(function(r) {{
            if (r.ok) {{
                var card = document.getElementById('run-card-' + runId);
                if (card) {{
                    card.classList.add('rated');
                    card.innerHTML = '<div style="text-align:center;padding:12px;color:#2ecc71;font-size:14px;">✓ Rated ' + ratings.main + '/5</div>';
                }}
                // Update unrated badge count
                var badgeEl = document.getElementById('models-unrated-badge');
                if (badgeEl) {{
                    var count = parseInt(badgeEl.textContent) - 1;
                    badgeEl.textContent = count;
                    if (count <= 0) badgeEl.style.display = 'none';
                }}
                delete _modelRatings[runId];
            }} else {{
                alert('Failed to submit rating');
            }}
        }}).catch(function() {{
            alert('Network error submitting rating');
        }});
    }}
    function toggleModelsSection(sectionId) {{
        var body = document.getElementById(sectionId);
        if (body) {{
            var isHidden = body.style.display === 'none';
            body.style.display = isHidden ? '' : 'none';
            var toggle = document.getElementById('unrated-section-toggle');
            if (toggle) toggle.textContent = isHidden ? '▼' : '▶';
        }}
    }}
    function addOverride() {{
        var taskType = document.getElementById('override-task-type').value.trim();
        var language = document.getElementById('override-language').value.trim() || null;
        var model = document.getElementById('override-model').value.trim();
        var reason = document.getElementById('override-reason').value.trim() || null;
        var expires = document.getElementById('override-expires').value || null;
        if (!taskType || !model) {{
            alert('Task type and model are required');
            return;
        }}
        var body = {{taskType: taskType, model: model}};
        if (language) body.language = language;
        if (reason) body.reason = reason;
        if (expires) body.expiresAt = expires + 'T00:00:00Z';
        fetch('/api/routing-overrides', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify(body)
        }}).then(function(r) {{
            if (r.ok) location.reload();
            else alert('Failed to add override');
        }});
    }}
    function deleteOverride(taskType, language) {{
        if (!confirm('Delete override for ' + taskType + '?')) return;
        var url = '/api/routing-overrides/' + encodeURIComponent(taskType);
        if (language) url += '?language=' + encodeURIComponent(language);
        fetch(url, {{method: 'DELETE'}}).then(function(r) {{
            if (r.ok) location.reload();
            else alert('Failed to delete override');
        }});
    }}
    // Smart auto-refresh: preserve active tab, expanded detail rows, expanded digests, and open drawer
    // For the models tab, only refresh the unrated badge to avoid losing form state
    setInterval(function() {{
        var activeTab = document.querySelector('.tab-content.active');
        var activeTabId = activeTab ? activeTab.id : 'tickets';
        var expanded = [];
        var expandedDigests = [];
        document.querySelectorAll('.digest-detail-row').forEach(function(r) {{
            if (r.style.display !== 'none') expandedDigests.push(r.id);
        }});
        var drawerOpen = _drawerLinearId;
        var activeFilter = document.querySelector('.activity-filter.active');
        var activeFilterType = activeFilter ? activeFilter.dataset.filter : 'all';
        fetch('/').then(r => r.text()).then(function(html) {{
            var parser = new DOMParser();
            var doc = parser.parseFromString(html, 'text/html');
            // Update header subtitle (timestamp)
            var newSub = doc.querySelector('.header-subtitle');
            var oldSub = document.querySelector('.header-subtitle');
            if (newSub && oldSub) oldSub.innerHTML = newSub.innerHTML;
            // Update header activity
            var newAct = doc.querySelector('.header-activity');
            var oldAct = document.querySelector('.header-activity');
            if (newAct && oldAct) oldAct.innerHTML = newAct.innerHTML;
            // Update header stats
            var newStats = doc.querySelector('.header-stats');
            var oldStats = document.querySelector('.header-stats');
            if (newStats && oldStats) oldStats.innerHTML = newStats.innerHTML;
            // Update health banner
            var newHb = doc.querySelector('.health-banner');
            var oldHb = document.querySelector('.health-banner');
            if (newHb && oldHb) oldHb.outerHTML = newHb.outerHTML;
            // Update favicon status dot
            updateFavicon();
            // Update each tab content (skip models and assist to preserve form/ws state)
            ['tickets','teammates','work','digests','log'].forEach(function(id) {{
                var newEl = doc.getElementById(id);
                var oldEl = document.getElementById(id);
                if (newEl && oldEl) oldEl.innerHTML = newEl.innerHTML;
            }});
            // Update models unrated badge without replacing tab content
            var newBadge = doc.getElementById('models-unrated-badge');
            var oldBadge = document.getElementById('models-unrated-badge');
            if (newBadge && oldBadge) {{
                oldBadge.textContent = newBadge.textContent;
                oldBadge.style.display = newBadge.style.display;
            }}
            // Restore active tab
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
            var tab = document.getElementById(activeTabId);
            if (tab) tab.classList.add('active');
            document.querySelectorAll('.tab').forEach(function(el) {{
                if (el.dataset.tab === activeTabId) el.classList.add('active');
            }});
            // Restore expanded detail rows
            expanded.forEach(function(id) {{
                var row = document.getElementById(id);
                if (row) row.style.display = '';
            }});
            // Restore expanded digest rows
            expandedDigests.forEach(function(id) {{
                var row = document.getElementById(id);
                if (row) row.style.display = '';
                var digestId = id.replace('digest-detail-', '');
                var toggle = document.getElementById('digest-toggle-' + digestId);
                if (toggle) toggle.textContent = '▼';
            }});
            if (expandedDigests.length > 0) {{
                var btn = document.getElementById('digest-expand-all-btn');
                if (btn) {{
                    var allExpanded = document.querySelectorAll('.digest-detail-row').length === expandedDigests.length;
                    btn.textContent = allExpanded ? 'Collapse all' : 'Expand all';
                }}
            }}
            // Convert timestamps to local time
            localizeTimestamps();
            // Restore activity filter
            if (activeFilterType && activeFilterType !== 'all') {{
                var filterBtn = document.querySelector('.activity-filter[data-filter="' + activeFilterType + '"]');
                if (filterBtn) filterActivity(activeFilterType, filterBtn);
            }}
            // Refresh drawer if open
            if (drawerOpen) {{
                fetch('/api/ticket/' + drawerOpen).then(r => r.json()).then(function(d) {{
                    if (!d.error) renderDrawer(d);
                }}).catch(function() {{}});
            }}
        }}).catch(function() {{}});
    }}, 60000);

    // ===== Assist tab: WebSocket-based agent interaction =====
    var _assistWs = null;
    var _assistReconnectTimer = null;
    var _assistReconnectDelay = 1000;
    var _assistMaxReconnectDelay = 30000;
    var _assistConnected = false;
    var _assistAgents = {{}};  // agentId -> {{ skill, model, status, startedAt, entries[], turns, tokens }}
    var _assistCompletedAgents = {{}};
    var _assistTabActive = false;

    var _assistArgTemplates = {{
        execute: '{{\\n  "linear_id": "",\\n  "identifier": ""\\n}}',
        explore: '{{\\n  "linear_id": "",\\n  "identifier": ""\\n}}',
        review: '{{\\n  "linear_id": "",\\n  "identifier": "",\\n  "pr_number": ""\\n}}',
        ci_fix: '{{\\n  "pr_number": "",\\n  "repo": ""\\n}}',
        audit: '{{\\n  "pr_number": "",\\n  "repo": ""\\n}}',
        docs: '{{\\n  "ticket_identifier": "",\\n  "repo": ""\\n}}',
        triage: '{{\\n  "linear_id": "",\\n  "identifier": ""\\n}}'
    }};

    function assistUpdateArgTemplate() {{
        var skill = document.getElementById('assist-skill').value;
        var template = _assistArgTemplates[skill] || '{{}}';
        document.getElementById('assist-args').value = template;
    }}

    function assistConnect() {{
        if (_assistWs && (_assistWs.readyState === WebSocket.CONNECTING || _assistWs.readyState === WebSocket.OPEN)) {{
            return;
        }}
        assistSetConnectionStatus('connecting');
        try {{
            _assistWs = new WebSocket('ws://localhost:7780');
        }} catch (e) {{
            assistSetConnectionStatus('disconnected');
            assistScheduleReconnect();
            return;
        }}

        _assistWs.onopen = function() {{
            _assistConnected = true;
            _assistReconnectDelay = 1000;
            assistSetConnectionStatus('connected');
            document.getElementById('assist-no-server').style.display = 'none';
            document.getElementById('assist-content').style.display = '';
            document.getElementById('assist-launch-btn').disabled = false;
        }};

        _assistWs.onclose = function() {{
            _assistConnected = false;
            assistSetConnectionStatus('disconnected');
            document.getElementById('assist-launch-btn').disabled = true;
            if (_assistTabActive) {{
                assistScheduleReconnect();
            }}
        }};

        _assistWs.onerror = function() {{
            // onclose will fire after this
        }};

        _assistWs.onmessage = function(event) {{
            try {{
                var msg = JSON.parse(event.data);
                assistHandleMessage(msg);
            }} catch (e) {{
                // ignore malformed messages
            }}
        }};
    }}

    function assistDisconnect() {{
        if (_assistReconnectTimer) {{
            clearTimeout(_assistReconnectTimer);
            _assistReconnectTimer = null;
        }}
        if (_assistWs) {{
            _assistWs.onclose = null;
            _assistWs.close();
            _assistWs = null;
        }}
        _assistConnected = false;
    }}

    function assistScheduleReconnect() {{
        if (_assistReconnectTimer) return;
        _assistReconnectTimer = setTimeout(function() {{
            _assistReconnectTimer = null;
            if (_assistTabActive) {{
                assistConnect();
            }}
        }}, _assistReconnectDelay);
        _assistReconnectDelay = Math.min(_assistReconnectDelay * 2, _assistMaxReconnectDelay);
    }}

    function assistSetConnectionStatus(status) {{
        var dot = document.getElementById('assist-conn-dot');
        var label = document.getElementById('assist-conn-label');
        var noServer = document.getElementById('assist-no-server');
        var content = document.getElementById('assist-content');
        if (!dot || !label) return;
        if (status === 'connected') {{
            dot.style.background = '#2ecc71';
            label.textContent = 'Connected';
            label.style.color = '#2ecc71';
        }} else if (status === 'connecting') {{
            dot.style.background = '#f39c12';
            label.textContent = 'Connecting…';
            label.style.color = '#f39c12';
        }} else {{
            dot.style.background = '#e74c3c';
            label.textContent = 'Disconnected';
            label.style.color = '#8b949e';
            if (noServer && content) {{
                // Only show no-server if we have no running agents
                if (Object.keys(_assistAgents).length === 0) {{
                    noServer.style.display = '';
                    content.style.display = 'none';
                }}
            }}
        }}
    }}

    function assistHandleMessage(msg) {{
        var agentId = msg.agentId;
        if (!agentId) return;

        if (msg.type === 'agent_started') {{
            _assistAgents[agentId] = {{
                skill: msg.skill || '?',
                model: msg.model || 'auto',
                status: 'running',
                startedAt: new Date(),
                entries: [],
                turns: 0,
                tokens: 0
            }};
            assistRenderAgents();
            return;
        }}

        if (msg.type === 'agent_completed' || msg.type === 'agent_failed') {{
            var agent = _assistAgents[agentId];
            if (agent) {{
                agent.status = msg.type === 'agent_completed' ? 'completed' : 'failed';
                agent.turns = msg.turns || agent.turns;
                agent.tokens = msg.tokens || agent.tokens;
                _assistCompletedAgents[agentId] = agent;
                delete _assistAgents[agentId];
                assistRenderAgents();
                assistRenderCompleted();
            }}
            return;
        }}

        // Stream entries: tool_call, tool_result, thinking, text, error
        var agent = _assistAgents[agentId];
        if (!agent) return;

        var entry = {{
            time: new Date(),
            type: msg.type || 'text',
            content: ''
        }};

        if (msg.type === 'tool_call') {{
            var argsPreview = (msg.args || '').substring(0, 100);
            if ((msg.args || '').length > 100) argsPreview += '…';
            entry.content = msg.tool + (argsPreview ? '\\n  ' + argsPreview : '');
            if (msg.turns) agent.turns = msg.turns;
        }} else if (msg.type === 'tool_result') {{
            var size = msg.size || '?';
            entry.content = '(' + size + ')';
        }} else if (msg.type === 'thinking') {{
            var preview = (msg.content || '').substring(0, 200);
            var full = msg.content || '';
            entry.content = preview;
            if (full.length > 200) {{
                entry.content += '…';
                entry.fullContent = full;
            }}
        }} else if (msg.type === 'text') {{
            var preview = (msg.content || '').substring(0, 200);
            var full = msg.content || '';
            entry.content = preview;
            if (full.length > 200) {{
                entry.content += '…';
                entry.fullContent = full;
            }}
        }} else if (msg.type === 'error') {{
            entry.content = msg.content || 'Unknown error';
        }}

        if (msg.tokens) agent.tokens = msg.tokens;
        agent.entries.push(entry);
        assistRenderStreamEntry(agentId, entry);
    }}

    function assistFormatTime(d) {{
        return d.toLocaleTimeString(undefined, {{hour: '2-digit', minute: '2-digit', second: '2-digit'}});
    }}

    function assistTimeSince(d) {{
        var diff = Math.floor((new Date() - d) / 1000);
        if (diff < 60) return diff + 's ago';
        var mins = Math.floor(diff / 60);
        if (mins < 60) return mins + 'm ago';
        var hrs = Math.floor(mins / 60);
        return hrs + 'h ' + (mins % 60) + 'm ago';
    }}

    function assistEntryIcon(type) {{
        var icons = {{tool_call: '🔧', tool_result: '✅', thinking: '💭', text: '📝', error: '❌'}};
        return icons[type] || '•';
    }}

    function assistEntryClass(type) {{
        var classes = {{tool_call: 'assist-output-tool-call', tool_result: 'assist-output-tool-result', thinking: 'assist-output-thinking', text: 'assist-output-text', error: 'assist-output-error'}};
        return classes[type] || 'assist-output-text';
    }}

    function assistRenderAgents() {{
        var container = document.getElementById('assist-running-agents');
        if (!container) return;
        var ids = Object.keys(_assistAgents);
        if (ids.length === 0) {{
            container.innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px 0;">No running agents</div>';
            return;
        }}
        var html = '';
        ids.forEach(function(id) {{
            var a = _assistAgents[id];
            var shortId = id.length > 10 ? id.substring(0, 10) : id;
            var since = assistTimeSince(a.startedAt);
            html += '<div class="assist-agent-card" id="assist-card-' + escapeHtml(id) + '">';
            html += '<div class="assist-agent-header">';
            html += '<div class="assist-agent-header-left">';
            html += '<span style="font-weight:600;color:#58a6ff;font-family:monospace;font-size:13px;">' + escapeHtml(shortId) + '</span>';
            html += '<span style="color:#8b949e;">(' + escapeHtml(a.skill) + ', ' + escapeHtml(a.model) + ')</span>';
            html += '</div>';
            html += '<div style="display:flex;align-items:center;gap:8px;">';
            html += '<span class="assist-agent-status running">running</span>';
            html += '<span style="color:#484f58;font-size:12px;">Started: ' + escapeHtml(since) + '</span>';
            html += '</div>';
            html += '</div>';
            html += '<div class="assist-output-stream" id="assist-stream-' + escapeHtml(id) + '">';
            a.entries.forEach(function(entry) {{
                html += assistRenderEntryHtml(entry);
            }});
            html += '</div>';
            html += '<div class="assist-message-row">';
            html += '<input type="text" class="assist-message-input" id="assist-msg-' + escapeHtml(id) + '" placeholder="Send message…" onkeydown="if(event.key===\'Enter\')assistSendMessage(\'' + escapeHtml(id) + '\')" />';
            html += '<button class="assist-btn assist-btn-secondary" onclick="assistSendMessage(\'' + escapeHtml(id) + '\')">Send</button>';
            html += '</div>';
            html += '<div class="assist-agent-actions">';
            html += '<button class="assist-btn assist-btn-danger" onclick="assistInterrupt(\'' + escapeHtml(id) + '\')">Interrupt</button>';
            html += '</div>';
            html += '</div>';
        }});
        container.innerHTML = html;
        // Auto-scroll all streams to bottom
        ids.forEach(function(id) {{
            var stream = document.getElementById('assist-stream-' + id);
            if (stream) stream.scrollTop = stream.scrollHeight;
        }});
    }}

    function assistRenderEntryHtml(entry) {{
        var icon = assistEntryIcon(entry.type);
        var cls = assistEntryClass(entry.type);
        var timeStr = assistFormatTime(entry.time);
        var content = escapeHtml(entry.content);
        var expandAttr = '';
        if (entry.fullContent) {{
            expandAttr = ' class="assist-output-entry assist-output-expandable" onclick="this.textContent=this.dataset.full;this.classList.remove(\'assist-output-expandable\')" data-full="' + escapeHtml('[' + timeStr + '] ' + icon + ' ' + entry.type + ': ' + entry.fullContent).replace(/"/g, '&quot;') + '"';
        }} else {{
            expandAttr = ' class="assist-output-entry"';
        }}
        return '<div' + expandAttr + '><span class="assist-output-time">[' + escapeHtml(timeStr) + ']</span> ' + icon + ' <span class="' + cls + '">' + content + '</span></div>';
    }}

    function assistRenderStreamEntry(agentId, entry) {{
        var stream = document.getElementById('assist-stream-' + agentId);
        if (!stream) {{
            assistRenderAgents();
            return;
        }}
        var div = document.createElement('div');
        div.innerHTML = assistRenderEntryHtml(entry);
        var entryEl = div.firstChild;
        stream.appendChild(entryEl);
        // Auto-scroll if near bottom
        var atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
        if (atBottom) stream.scrollTop = stream.scrollHeight;
    }}

    function assistRenderCompleted() {{
        var ids = Object.keys(_assistCompletedAgents);
        var section = document.getElementById('assist-completed-section');
        var container = document.getElementById('assist-completed-agents');
        var countEl = document.getElementById('assist-completed-count');
        if (!section || !container || !countEl) return;
        countEl.textContent = ids.length;
        if (ids.length === 0) {{
            section.style.display = 'none';
            return;
        }}
        section.style.display = '';
        var html = '';
        ids.reverse().forEach(function(id) {{
            var a = _assistCompletedAgents[id];
            var shortId = id.length > 10 ? id.substring(0, 10) : id;
            var statusClass = a.status === 'completed' ? 'completed' : 'failed';
            var statusIcon = a.status === 'completed' ? '✅' : '❌';
            var tokensStr = a.tokens ? a.tokens.toLocaleString() : '—';
            html += '<div class="assist-agent-card" style="opacity:0.7;">';
            html += '<div class="assist-agent-header">';
            html += '<div class="assist-agent-header-left">';
            html += '<span style="font-weight:600;color:#8b949e;font-family:monospace;font-size:13px;">' + escapeHtml(shortId) + '</span>';
            html += '<span style="color:#484f58;">(' + escapeHtml(a.skill) + ', ' + escapeHtml(a.model) + ')</span>';
            html += '</div>';
            html += '<div style="display:flex;align-items:center;gap:8px;">';
            html += '<span class="assist-agent-status ' + statusClass + '">' + statusIcon + ' ' + escapeHtml(a.status) + '</span>';
            html += '<span style="color:#484f58;font-size:12px;">' + (a.turns || 0) + ' turns · ' + tokensStr + ' tokens</span>';
            html += '</div>';
            html += '</div>';
            html += '</div>';
        }});
        container.innerHTML = html;
    }}

    function assistToggleCompleted() {{
        var container = document.getElementById('assist-completed-agents');
        var icon = document.getElementById('assist-completed-toggle-icon');
        if (!container || !icon) return;
        var hidden = container.style.display === 'none';
        container.style.display = hidden ? '' : 'none';
        icon.textContent = hidden ? '▼' : '▶';
    }}

    function assistLaunchAgent() {{
        if (!_assistConnected || !_assistWs) return;
        var skill = document.getElementById('assist-skill').value;
        var model = document.getElementById('assist-model').value;
        var argsStr = document.getElementById('assist-args').value.trim();
        var args;
        try {{
            args = JSON.parse(argsStr);
        }} catch (e) {{
            alert('Invalid JSON in arguments');
            return;
        }}
        _assistWs.send(JSON.stringify({{
            type: 'spawn',
            skill: skill,
            args: args,
            model: model
        }}));
    }}

    function assistSendMessage(agentId) {{
        if (!_assistConnected || !_assistWs) return;
        var input = document.getElementById('assist-msg-' + agentId);
        if (!input) return;
        var content = input.value.trim();
        if (!content) return;
        _assistWs.send(JSON.stringify({{
            type: 'message',
            agentId: agentId,
            content: content
        }}));
        input.value = '';
    }}

    function assistInterrupt(agentId) {{
        if (!confirm('Interrupt agent ' + agentId.substring(0, 10) + '?')) return;
        if (!_assistConnected || !_assistWs) return;
        _assistWs.send(JSON.stringify({{
            type: 'interrupt',
            agentId: agentId
        }}));
    }}

    // Watch for tab switches to manage WebSocket lifecycle
    var _origSwitchTab = switchTab;
    switchTab = function(name) {{
        _origSwitchTab(name);
        _assistTabActive = (name === 'assist');
        if (_assistTabActive) {{
            if (!_assistConnected) {{
                assistConnect();
            }}
        }}
    }};

    // Update assist agent "started X ago" timestamps periodically
    setInterval(function() {{
        if (!_assistTabActive) return;
        Object.keys(_assistAgents).forEach(function(id) {{
            var card = document.getElementById('assist-card-' + id);
            if (!card) return;
            var a = _assistAgents[id];
            var since = assistTimeSince(a.startedAt);
            var startedSpans = card.querySelectorAll('.assist-agent-header span[style*="color:#484f58"]');
            if (startedSpans.length > 0) {{
                startedSpans[startedSpans.length - 1].textContent = 'Started: ' + since;
            }}
        }});
    }}, 10000);

    </script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            self._handle_get()
        finally:
            _close_shared_db()

    def _handle_get(self):
        if self.path == "/" or self.path == "":
            html = render_page()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())
        elif self.path == "/api/tickets":
            data = get_tickets_by_status()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/stats":
            data = get_stats()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/work":
            data = get_active_work()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/activity":
            data = get_activity_feed()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/teammates":
            data = get_active_teammates()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/heartbeat":
            data = get_heartbeat()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path.startswith("/api/ticket/"):
            linear_id = self.path[len("/api/ticket/"):]
            data = get_ticket_detail(linear_id)
            if data is None:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Ticket not found"}).encode())
            else:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/model-runs/unrated":
            data = get_unrated_model_runs()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/model-runs/recent":
            data = get_recent_model_runs()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/routing-weights":
            data = get_routing_weights()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/routing-overrides":
            data = get_routing_overrides()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/api/model-stats":
            data = get_model_stats()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # quiet

    def do_POST(self):
        try:
            self._handle_post()
        finally:
            _close_shared_db()

    def _handle_post(self):
        if self.path == "/api/run-cycle":
            try:
                cycle_script = SCRIPT_DIR / "run-cycle.sh"
                if not cycle_script.exists():
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "run-cycle.sh not found"}).encode())
                    return
                subprocess.Popen(
                    [str(cycle_script)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == "/api/reassess":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                linear_id = data.get("linear_id", "")
                identifier = data.get("identifier", "")
                if not linear_id or not identifier:
                    self.send_response(400)
                    self.end_headers()
                    return
                db = _shared_db()
                db.execute(
                    "CREATE TABLE IF NOT EXISTS reassess_requests "
                    "(id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "linear_id TEXT NOT NULL, identifier TEXT NOT NULL, "
                    "requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), "
                    "processed_at TEXT)"
                )
                db.execute(
                    "INSERT INTO reassess_requests (linear_id, identifier) VALUES (?, ?)",
                    (linear_id, identifier),
                )
                db.commit()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except (json.JSONDecodeError, Exception):
                self.send_response(500)
                self.end_headers()
        elif self.path.startswith("/api/model-runs/") and self.path.endswith("/rate"):
            # POST /api/model-runs/{id}/rate
            run_id = self.path[len("/api/model-runs/"):-len("/rate")]
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                human_rating = data.get("humanRating")
                if not human_rating or not isinstance(human_rating, int) or human_rating < 1 or human_rating > 5:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "humanRating must be 1-5"}).encode())
                    return
                rate_model_run(run_id, data)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except (json.JSONDecodeError, Exception) as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == "/api/routing-overrides":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                task_type = data.get("taskType", "").strip()
                model = data.get("model", "").strip()
                if not task_type or not model:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "taskType and model are required"}).encode())
                    return
                language = data.get("language", "").strip() or None
                reason = data.get("reason", "").strip() or None
                expires_at = data.get("expiresAt", "").strip() or None
                db = _shared_db()
                db.execute(
                    "INSERT OR REPLACE INTO routing_overrides "
                    "(task_type, language, model, reason, created_at, expires_at) "
                    "VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)",
                    (task_type, language, model, reason, expires_at),
                )
                db.commit()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except (json.JSONDecodeError, Exception) as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_DELETE(self):
        try:
            self._handle_delete()
        finally:
            _close_shared_db()

    def _handle_delete(self):
        if self.path.startswith("/api/routing-overrides/"):
            # DELETE /api/routing-overrides/{task_type}?language=...
            path_and_query = self.path[len("/api/routing-overrides/"):]
            # Parse query params
            if "?" in path_and_query:
                task_type_raw, qs = path_and_query.split("?", 1)
                params = parse_qs(qs)
                language = params.get("language", [None])[0]
            else:
                task_type_raw = path_and_query
                language = None
            task_type = unquote(task_type_raw)
            try:
                db = _shared_db()
                if language:
                    db.execute(
                        "DELETE FROM routing_overrides WHERE task_type = ? AND language = ?",
                        (task_type, language),
                    )
                else:
                    db.execute(
                        "DELETE FROM routing_overrides WHERE task_type = ? AND language IS NULL",
                        (task_type,),
                    )
                db.commit()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()


def main():
    if not DB_PATH.exists():
        print(f"Error: database not found at {DB_PATH}")
        print("Run setup.sh first.")
        return

    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True
        allow_reuse_port = True

    server = ReusableHTTPServer((BIND_HOST, PORT), Handler)
    print(f"Marvin dashboard running at http://{BIND_HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
