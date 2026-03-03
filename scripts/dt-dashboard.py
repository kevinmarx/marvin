#!/usr/bin/env python3
"""Deep Thought dashboard — local web UI for viewing findings, alerts, and scan results."""

import html as html_mod
import json
import os
import sqlite3
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from string import Template

DB_PATH = Path.home() / ".deep-thought" / "state" / "deep-thought.db"
PORT = 7778
BIND_HOST = "0.0.0.0" if os.environ.get("DEEP_THOUGHT_REMOTE") == "1" else "127.0.0.1"

# Read Linear workspace slug from config
_CONFIG_PATH = Path(os.environ.get("DEEP_THOUGHT_CONFIG", str(Path(__file__).parent.parent / "config" / "deep-thought.json")))
try:
    _config = json.load(open(_CONFIG_PATH))
    LINEAR_WORKSPACE_SLUG = _config.get("linear_workspace_slug", "your-workspace")
except (FileNotFoundError, json.JSONDecodeError):
    LINEAR_WORKSPACE_SLUG = "your-workspace"


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


def esc(s):
    return html_mod.escape(str(s)) if s else ""


def time_ago(ts_str):
    if not ts_str:
        return "never"
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        delta = now - ts
        secs = int(delta.total_seconds())
        if secs < 60:
            return f"{secs}s ago"
        elif secs < 3600:
            return f"{secs // 60}m ago"
        elif secs < 86400:
            return f"{secs // 3600}h ago"
        else:
            return f"{secs // 86400}d ago"
    except Exception:
        return ts_str


# ── Severity / status badge helpers ──────────────────────────

SEVERITY_COLORS = {
    "critical": "#dc2626",
    "high": "#ea580c",
    "medium": "#ca8a04",
    "low": "#2563eb",
}

STATUS_COLORS = {
    "new": "#7c3aed",
    "ticket_created": "#16a34a",
    "resolved": "#6b7280",
    "deduped": "#9ca3af",
    "skipped": "#d1d5db",
    "running": "#f59e0b",
    "completed": "#16a34a",
    "failed": "#dc2626",
}

SOURCE_LABELS = {
    "alert": "🔔 Alert",
    "apm": "📊 APM",
    "logs": "📝 Logs",
    "codebase_todo": "📋 TODO",
    "codebase_deps": "📦 Deps",
    "codebase_pattern": "🔍 Pattern",
}

PRIORITY_MAP = {1: "Urgent", 2: "High", 3: "Normal", 4: "Low"}


def badge(text, color):
    return f'<span style="background:{color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500">{esc(text)}</span>'


# ── Data queries ─────────────────────────────────────────────

def get_heartbeat():
    """Get orchestrator heartbeat with health assessment."""
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
                if age_seconds < 25200:  # 7 hours (cycle is 6h + buffer)
                    hb["health"] = "healthy"
                elif age_seconds < 43200:  # 12 hours
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


def get_finding_detail(finding_id):
    """Return full finding details for the drawer."""
    rows = query("SELECT * FROM findings WHERE id = ?", (finding_id,))
    if not rows:
        return None
    finding = rows[0]

    # Parse JSON fields
    if finding.get("affected_paths"):
        try:
            finding["affected_paths_list"] = json.loads(finding["affected_paths"])
        except (json.JSONDecodeError, TypeError):
            finding["affected_paths_list"] = []
    else:
        finding["affected_paths_list"] = []

    if finding.get("datadog_context"):
        try:
            finding["datadog_context_parsed"] = json.loads(finding["datadog_context"])
        except (json.JSONDecodeError, TypeError):
            finding["datadog_context_parsed"] = {}
    else:
        finding["datadog_context_parsed"] = {}

    return finding


def get_stats():
    """Get summary statistics."""
    try:
        stats = query("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
                SUM(CASE WHEN status = 'ticket_created' THEN 1 ELSE 0 END) as ticketed,
                SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
                SUM(CASE WHEN status = 'deduped' THEN 1 ELSE 0 END) as deduped,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
            FROM findings;
        """)
        return stats[0] if stats else {}
    except sqlite3.OperationalError:
        return {}


def get_stats_by_source():
    """Get finding counts grouped by source."""
    try:
        return query("""
            SELECT source,
                   COUNT(*) as count,
                   SUM(CASE WHEN status = 'ticket_created' THEN 1 ELSE 0 END) as ticketed
            FROM findings
            GROUP BY source
            ORDER BY count DESC;
        """)
    except sqlite3.OperationalError:
        return []


def get_activity_feed():
    """Build a unified activity feed from findings and cycle events."""
    events = []

    # Ticket creation events
    for f in query("""
        SELECT id, source, title, severity, ticket_identifier, ticket_url, created_at
        FROM findings
        WHERE status = 'ticket_created'
        ORDER BY created_at DESC LIMIT 20
    """):
        source_label = SOURCE_LABELS.get(f["source"], f["source"])
        events.append({
            "time": f["created_at"],
            "type": "ticket_created",
            "icon": "🎫",
            "title": f"Created {f['ticket_identifier'] or 'ticket'}: {f['title']}",
            "detail": f"Source: {source_label}, Severity: {f['severity']}",
        })

    # Cycle events
    try:
        for ce in query("""
            SELECT cycle_number, step, message, created_at
            FROM cycle_events
            ORDER BY created_at DESC LIMIT 50
        """):
            icon = "🔄"
            if "ALERTS" in ce["message"]:
                icon = "🔔"
            elif "TELEMETRY" in ce["message"]:
                icon = "📊"
            elif "CODEBASE" in ce["message"]:
                icon = "📋"
            elif "OPS" in ce["message"]:
                icon = "🧹"
            events.append({
                "time": ce["created_at"],
                "type": ce["step"],
                "icon": icon,
                "title": f"Cycle {ce['cycle_number']}: {ce['step']}",
                "detail": ce["message"],
            })
    except sqlite3.OperationalError:
        pass

    # Scanner events
    try:
        for sr in query("""
            SELECT scanner_type, repo, status, findings_count, error, finished_at
            FROM scanner_runs
            WHERE status != 'running'
            ORDER BY finished_at DESC LIMIT 20
        """):
            if sr["finished_at"]:
                icon = "✅" if sr["status"] == "completed" else "❌"
                events.append({
                    "time": sr["finished_at"],
                    "type": "scanner",
                    "icon": icon,
                    "title": f"Scanner {sr['scanner_type']} ({sr['repo']}): {sr['status']}",
                    "detail": f"Findings: {sr['findings_count'] or 0}" + (f", Error: {sr['error']}" if sr.get("error") else ""),
                })
    except sqlite3.OperationalError:
        pass

    events.sort(key=lambda e: e.get("time", ""), reverse=True)
    return events[:50]


# ── HTML Template ────────────────────────────────────────────

PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Deep Thought Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 0; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header { background: #1e293b; border-bottom: 1px solid #334155; overflow: hidden; }
  .header-top { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; }
  .header-title-group h1 { font-size: 20px; font-weight: 700; color: #f0f6fc; }
  .header-subtitle { font-size: 13px; color: #94a3b8; margin-top: 2px; }
  .header-stats { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 24px; border-top: 1px solid #334155; }
  .stat { display: flex; align-items: center; gap: 6px; font-size: 14px; }
  .badge-inline { display: inline-block; min-width: 24px; padding: 2px 8px; border-radius: 12px; color: #fff; font-weight: 600; font-size: 13px; text-align: center; }

  /* Health banner */
  .health-banner { border-radius: 8px; padding: 10px 20px; margin: 16px 24px; display: flex; align-items: center; gap: 12px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  /* Tabs */
  .tabs { display: flex; gap: 0; background: #1e293b; border-bottom: 1px solid #334155; padding: 0 24px; }
  .tab { padding: 10px 20px; cursor: pointer; color: #94a3b8; font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; transition: all 0.2s; }
  .tab:hover { color: #e2e8f0; }
  .tab.active { color: #60a5fa; border-bottom-color: #60a5fa; }

  /* Content */
  .content { padding: 24px; max-width: 1400px; margin: 0 auto; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 20px; border: 1px solid #334155; }
  th { background: #334155; padding: 10px 14px; text-align: left; font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 14px; border-top: 1px solid #334155; font-size: 13px; }
  tr:hover td { background: #1e3a5f; }

  /* Stat grid */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; }
  .stat-card .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }

  /* Source breakdown mini-cards */
  .source-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 24px; }
  .source-card { background: #1e293b; border-radius: 6px; padding: 10px 14px; border: 1px solid #334155; text-align: center; }
  .source-card .source-icon { font-size: 20px; }
  .source-card .source-count { font-size: 22px; font-weight: 700; color: #e2e8f0; }
  .source-card .source-label { font-size: 11px; color: #94a3b8; }
  .source-card .source-ticketed { font-size: 11px; color: #16a34a; }

  /* Misc */
  .empty { padding: 40px; text-align: center; color: #64748b; font-size: 14px; }
  .desc-preview { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clickable { cursor: pointer; }
  .ts { /* timestamps — client JS will localize these */ }

  /* Activity filter buttons */
  .activity-filter { font-size: 12px; padding: 4px 12px; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 16px; cursor: pointer; }
  .activity-filter:hover { color: #e2e8f0; border-color: #475569; }
  .activity-filter.active { background: #334155; color: #f0f6fc; border-color: #475569; }

  /* Drawer */
  .drawer-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999; display: none; }
  .drawer-overlay.open { display: block; }
  .drawer { position: fixed; top: 0; right: 0; width: 620px; max-width: 90vw; height: 100vh; background: #1e293b; border-left: 1px solid #334155; z-index: 1000; transform: translateX(100%); transition: transform 0.2s ease; overflow-y: auto; display: flex; flex-direction: column; }
  .drawer.open { transform: translateX(0); }
  .drawer-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 20px; border-bottom: 1px solid #334155; flex-shrink: 0; }
  .drawer-header h2 { font-size: 16px; color: #f0f6fc; margin: 0; line-height: 1.4; }
  .drawer-close { background: none; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
  .drawer-close:hover { background: #334155; color: #f0f6fc; }
  .drawer-body { padding: 20px; flex: 1; overflow-y: auto; }
  .drawer-card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .drawer-card h3 { font-size: 13px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 12px; }
  .drawer-field { display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px; }
  .drawer-field-label { color: #94a3b8; min-width: 110px; flex-shrink: 0; }
  .drawer-field-value { color: #e2e8f0; word-break: break-word; }
  .drawer-loading { text-align: center; color: #94a3b8; padding: 40px 0; }
  .confidence-bar { display: inline-block; height: 6px; border-radius: 3px; margin-right: 8px; vertical-align: middle; }
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:28px">🧠</span>
      <div class="header-title-group">
        <h1>Deep Thought</h1>
        <div class="header-subtitle">Autonomous observability & codebase analysis · <span class="ts">$now</span></div>
      </div>
    </div>
  </div>
  <div class="header-stats">$stats_html</div>
</div>

$health_banner

<div class="tabs">
  <div class="tab active" data-tab="findings" onclick="switchTab('findings')">Findings</div>
  <div class="tab" data-tab="alerts" onclick="switchTab('alerts')">Alerts</div>
  <div class="tab" data-tab="telemetry" onclick="switchTab('telemetry')">Telemetry</div>
  <div class="tab" data-tab="codebase" onclick="switchTab('codebase')">Codebase</div>
  <div class="tab" data-tab="runs" onclick="switchTab('runs')">Runs</div>
  <div class="tab" data-tab="log" onclick="switchTab('log')">Log</div>
</div>
<div class="content">
  <div id="findings" class="panel active">$findings_panel</div>
  <div id="alerts" class="panel">$alerts_panel</div>
  <div id="telemetry" class="panel">$telemetry_panel</div>
  <div id="codebase" class="panel">$codebase_panel</div>
  <div id="runs" class="panel">$runs_panel</div>
  <div id="log" class="panel">$log_panel</div>
</div>

<div id="drawer-overlay" class="drawer-overlay" onclick="closeDrawer()"></div>
<div id="finding-drawer" class="drawer">
  <div class="drawer-header">
    <div id="drawer-header-content"></div>
    <button class="drawer-close" onclick="closeDrawer()">&times;</button>
  </div>
  <div class="drawer-body" id="drawer-body">
    <div class="drawer-loading">Loading...</div>
  </div>
</div>

<script>
function switchTab(name) {
  document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById(name).classList.add('active');
  document.querySelectorAll('.tab').forEach(el => {
    if (el.dataset.tab === name) el.classList.add('active');
  });
}

// Finding detail drawer
var _drawerFindingId = null;
function openDrawer(findingId) {
  _drawerFindingId = findingId;
  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('finding-drawer').classList.add('open');
  document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Loading...</div>';
  document.getElementById('drawer-header-content').innerHTML = '';
  fetch('/api/finding/' + findingId).then(r => r.json()).then(function(data) {
    if (data.error) {
      document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Finding not found</div>';
      return;
    }
    renderDrawer(data);
  }).catch(function() {
    document.getElementById('drawer-body').innerHTML = '<div class="drawer-loading">Failed to load</div>';
  });
}
function closeDrawer() {
  _drawerFindingId = null;
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('finding-drawer').classList.remove('open');
}
function escapeHtml(s) {
  if (!s) return '';
  var div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
function confidenceColor(c) {
  if (c >= 0.8) return '#16a34a';
  if (c >= 0.6) return '#ca8a04';
  return '#dc2626';
}
function severityColor(s) {
  var m = {critical:'#dc2626', high:'#ea580c', medium:'#ca8a04', low:'#2563eb'};
  return m[s] || '#6b7280';
}
function renderDrawer(f) {
  // Header
  var sourceLabels = {alert:'🔔 Alert', apm:'📊 APM', logs:'📝 Logs', codebase_todo:'📋 TODO', codebase_deps:'📦 Deps', codebase_pattern:'🔍 Pattern'};
  var sourceLabel = sourceLabels[f.source] || f.source;
  var sevColor = severityColor(f.severity);
  var confColor = confidenceColor(f.confidence);

  var headerHtml = '<h2>' + escapeHtml(f.title) + '</h2>';
  headerHtml += '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">';
  headerHtml += '<span style="background:' + sevColor + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500">' + escapeHtml(f.severity) + '</span>';
  headerHtml += '<span style="background:#334155;color:#e2e8f0;padding:2px 8px;border-radius:4px;font-size:12px">' + sourceLabel + '</span>';
  headerHtml += '<span style="background:#334155;color:#e2e8f0;padding:2px 8px;border-radius:4px;font-size:12px">' + escapeHtml(f.status) + '</span>';
  if (f.ticket_identifier) {
    headerHtml += '<a href="https://linear.app/$linear_slug/issue/' + escapeHtml(f.ticket_identifier) + '" target="_blank" style="font-size:12px">' + escapeHtml(f.ticket_identifier) + ' ↗</a>';
  }
  headerHtml += '</div>';
  document.getElementById('drawer-header-content').innerHTML = headerHtml;

  var body = '';

  // Overview card
  body += '<div class="drawer-card"><h3>Overview</h3>';
  body += '<div class="drawer-field"><span class="drawer-field-label">Source</span><span class="drawer-field-value">' + sourceLabel + '</span></div>';
  body += '<div class="drawer-field"><span class="drawer-field-label">Type</span><span class="drawer-field-value">' + escapeHtml(f.type) + '</span></div>';
  body += '<div class="drawer-field"><span class="drawer-field-label">Severity</span><span class="drawer-field-value"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + sevColor + ';margin-right:6px"></span>' + escapeHtml(f.severity) + '</span></div>';
  var confPct = Math.round(f.confidence * 100);
  body += '<div class="drawer-field"><span class="drawer-field-label">Confidence</span><span class="drawer-field-value"><span class="confidence-bar" style="width:' + confPct + 'px;background:' + confColor + '"></span>' + confPct + '%</span></div>';
  if (f.target_repo) body += '<div class="drawer-field"><span class="drawer-field-label">Repo</span><span class="drawer-field-value">' + escapeHtml(f.target_repo) + '</span></div>';
  if (f.affected_service) body += '<div class="drawer-field"><span class="drawer-field-label">Service</span><span class="drawer-field-value">' + escapeHtml(f.affected_service) + '</span></div>';
  body += '<div class="drawer-field"><span class="drawer-field-label">Created</span><span class="drawer-field-value"><span class="ts">' + escapeHtml(f.created_at) + '</span></span></div>';
  if (f.cooldown_until) body += '<div class="drawer-field"><span class="drawer-field-label">Cooldown until</span><span class="drawer-field-value"><span class="ts">' + escapeHtml(f.cooldown_until) + '</span></span></div>';
  body += '</div>';

  // Description card
  if (f.description) {
    body += '<div class="drawer-card"><h3>Description</h3>';
    body += '<div style="font-size:13px;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;line-height:1.6">' + escapeHtml(f.description) + '</div>';
    body += '</div>';
  }

  // Affected paths
  var paths = f.affected_paths_list || [];
  if (paths.length > 0) {
    body += '<div class="drawer-card"><h3>Affected paths</h3>';
    paths.forEach(function(p) {
      body += '<div style="font-family:monospace;font-size:12px;color:#94a3b8;padding:2px 0">' + escapeHtml(p) + '</div>';
    });
    body += '</div>';
  }

  // Datadog context
  var ddCtx = f.datadog_context_parsed || {};
  if (Object.keys(ddCtx).length > 0) {
    body += '<div class="drawer-card"><h3>Datadog context</h3>';
    Object.keys(ddCtx).forEach(function(k) {
      var v = typeof ddCtx[k] === 'object' ? JSON.stringify(ddCtx[k], null, 2) : String(ddCtx[k]);
      body += '<div class="drawer-field"><span class="drawer-field-label">' + escapeHtml(k) + '</span><span class="drawer-field-value" style="font-family:monospace;font-size:12px">' + escapeHtml(v) + '</span></div>';
    });
    body += '</div>';
  }

  // Ticket card
  if (f.ticket_linear_id) {
    body += '<div class="drawer-card"><h3>Linear ticket</h3>';
    body += '<div class="drawer-field"><span class="drawer-field-label">Identifier</span><span class="drawer-field-value"><a href="https://linear.app/$linear_slug/issue/' + escapeHtml(f.ticket_identifier) + '" target="_blank">' + escapeHtml(f.ticket_identifier) + ' ↗</a></span></div>';
    body += '<div class="drawer-field"><span class="drawer-field-label">ID</span><span class="drawer-field-value" style="font-family:monospace;font-size:12px">' + escapeHtml(f.ticket_linear_id) + '</span></div>';
    body += '</div>';
  }

  // Skip reason
  if (f.skip_reason) {
    body += '<div class="drawer-card"><h3>Skip reason</h3>';
    body += '<div style="font-size:13px;color:#94a3b8">' + escapeHtml(f.skip_reason) + '</div>';
    body += '</div>';
  }

  // Dedup hash (collapsed)
  body += '<div class="drawer-card"><h3>Metadata</h3>';
  body += '<div class="drawer-field"><span class="drawer-field-label">Dedup hash</span><span class="drawer-field-value" style="font-family:monospace;font-size:11px;color:#64748b">' + escapeHtml(f.dedup_hash) + '</span></div>';
  body += '<div class="drawer-field"><span class="drawer-field-label">Finding ID</span><span class="drawer-field-value">' + f.id + '</span></div>';
  if (f.datadog_monitor_id) body += '<div class="drawer-field"><span class="drawer-field-label">Monitor ID</span><span class="drawer-field-value" style="font-family:monospace;font-size:12px">' + escapeHtml(f.datadog_monitor_id) + '</span></div>';
  body += '</div>';

  document.getElementById('drawer-body').innerHTML = body;
  localizeTimestamps();
}

function filterActivity(type, btn) {
  document.querySelectorAll('.activity-filter').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.activity-row').forEach(function(row) {
    if (type === 'all') {
      row.style.display = '';
    } else {
      var rowType = row.dataset.type || '';
      row.style.display = (rowType === type || rowType.startsWith(type + '_')) ? '' : 'none';
    }
  });
}

function localizeTimestamps() {
  document.querySelectorAll('.ts').forEach(function(el) {
    var raw = el.textContent.trim();
    if (!raw || el.dataset.done) return;
    var d = new Date(raw.replace(' ', 'T').replace(/Z?$/, 'Z'));
    if (isNaN(d.getTime())) return;
    var now = new Date();
    var diff = now - d;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) {
      el.textContent = 'just now';
    } else if (mins < 60) {
      el.textContent = mins + 'm ago';
    } else if (mins < 1440) {
      var hrs = Math.floor(mins / 60);
      el.textContent = hrs + 'h ' + (mins % 60) + 'm ago';
    } else {
      el.textContent = d.toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'});
    }
    el.title = d.toLocaleString();
    el.dataset.done = '1';
  });
}

localizeTimestamps();

// Smart auto-refresh: preserve tab, open drawer
setInterval(function() {
  var activeTab = document.querySelector('.panel.active');
  var activeTabId = activeTab ? activeTab.id : 'findings';
  var drawerOpen = _drawerFindingId;
  var activeFilter = document.querySelector('.activity-filter.active');
  var activeFilterType = activeFilter ? activeFilter.dataset.filter : 'all';

  fetch('/').then(r => r.text()).then(function(html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');

    // Update header stats
    var newStats = doc.querySelector('.header-stats');
    var oldStats = document.querySelector('.header-stats');
    if (newStats && oldStats) oldStats.innerHTML = newStats.innerHTML;

    // Update health banner
    var newHb = doc.querySelector('.health-banner');
    var oldHb = document.querySelector('.health-banner');
    if (newHb && oldHb) oldHb.outerHTML = newHb.outerHTML;

    // Update each tab content
    ['findings','alerts','telemetry','codebase','runs','log'].forEach(function(id) {
      var newEl = doc.getElementById(id);
      var oldEl = document.getElementById(id);
      if (newEl && oldEl) oldEl.innerHTML = newEl.innerHTML;
    });

    // Restore active tab
    document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    var tab = document.getElementById(activeTabId);
    if (tab) tab.classList.add('active');
    document.querySelectorAll('.tab').forEach(function(el) {
      if (el.dataset.tab === activeTabId) el.classList.add('active');
    });

    // Localize new timestamps
    localizeTimestamps();

    // Restore activity filter
    if (activeFilterType && activeFilterType !== 'all') {
      var filterBtn = document.querySelector('.activity-filter[data-filter="' + activeFilterType + '"]');
      if (filterBtn) filterActivity(activeFilterType, filterBtn);
    }

    // Refresh drawer if open
    if (drawerOpen) {
      fetch('/api/finding/' + drawerOpen).then(r => r.json()).then(function(d) {
        if (!d.error) renderDrawer(d);
      }).catch(function() {});
    }
  }).catch(function() {});
}, 60000);
</script>
</body>
</html>"""


# ── Panel builders ───────────────────────────────────────────

def build_health_banner():
    hb = get_heartbeat()
    if not hb:
        return '<div class="health-banner" data-health="dead" style="background:#450a0a;border:1px solid #7f1d1d;"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#dc2626;"></span><span style="color:#fca5a5;font-weight:600;">No heartbeat</span><span style="color:#94a3b8;">Orchestrator has never run or DB missing</span></div>'

    health = hb.get("health", "unknown")
    age = hb.get("age_seconds", 0)
    step = hb.get("current_step", "unknown")
    cycle_num = hb.get("cycle_number", 0)
    cycle_dur = hb.get("last_cycle_duration_seconds")

    if age < 60:
        age_str = "just now"
    elif age < 3600:
        age_str = f"{age // 60}m ago"
    else:
        age_str = f"{age // 3600}h {(age % 3600) // 60}m ago"

    dur_str = ""
    if cycle_dur is not None:
        if cycle_dur < 60:
            dur_str = f" · last cycle: {cycle_dur}s"
        else:
            dur_str = f" · last cycle: {cycle_dur // 60}m {cycle_dur % 60}s"

    step_display = step.replace("_", " ") if step else "unknown"

    colors = {"healthy": ("#166534", "#86efac", "#14532d"), "warning": ("#854d0e", "#fde047", "#713f12"), "dead": ("#7f1d1d", "#fca5a5", "#450a0a"), "unknown": ("#334155", "#94a3b8", "#1e293b")}
    fg, text_color, bg = colors.get(health, colors["unknown"])
    pulse = "animation:pulse 2s infinite;" if health == "healthy" else ""

    return f'<div class="health-banner" data-health="{health}" style="background:{bg};border:1px solid {fg};"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:{text_color};{pulse}"></span><span style="color:{text_color};font-weight:600;">{"Running" if health == "healthy" else ("Slow" if health == "warning" else "Not responding")}</span><span style="color:#94a3b8;">Cycle #{cycle_num} · step: {step_display} · heartbeat: {age_str}{dur_str}</span></div>'


def build_stats_html():
    s = get_stats()
    by_source = get_stats_by_source()
    total = s.get("total", 0)
    new_count = s.get("new_count", 0)
    ticketed = s.get("ticketed", 0)
    resolved = s.get("resolved", 0)

    parts = []
    parts.append(f'<span class="stat"><strong>{total}</strong>&nbsp;findings</span>')
    if new_count:
        parts.append(f'<span class="stat"><span class="badge-inline" style="background:#7c3aed">{new_count}</span> new</span>')
    if ticketed:
        parts.append(f'<span class="stat"><span class="badge-inline" style="background:#16a34a">{ticketed}</span> ticketed</span>')
    if resolved:
        parts.append(f'<span class="stat"><span class="badge-inline" style="background:#6b7280">{resolved}</span> resolved</span>')

    if by_source:
        parts.append('<span style="border-left:1px solid #334155;margin:0 4px;">&nbsp;</span>')
        for row in by_source:
            source_label = SOURCE_LABELS.get(row["source"], row["source"])
            parts.append(f'<span class="stat">{source_label} <strong>{row["count"]}</strong></span>')

    return " ".join(parts)


def build_stat_cards():
    s = get_stats()
    by_source = get_stats_by_source()

    # Main stat cards
    cards = [
        ("Total findings", s.get("total", 0), "#60a5fa"),
        ("New", s.get("new_count", 0), "#7c3aed"),
        ("Tickets created", s.get("ticketed", 0), "#16a34a"),
        ("Resolved", s.get("resolved", 0), "#6b7280"),
        ("Deduped", s.get("deduped", 0), "#9ca3af"),
        ("Skipped", s.get("skipped", 0), "#475569"),
    ]
    html_parts = []
    for label, value, color in cards:
        html_parts.append(f'''<div class="stat-card">
            <div class="label">{label}</div>
            <div class="value" style="color:{color}">{value}</div>
        </div>''')
    html = '<div class="stat-grid">' + ''.join(html_parts) + '</div>'

    # Source breakdown
    if by_source:
        source_parts = []
        for row in by_source:
            icon = SOURCE_LABELS.get(row["source"], "").split(" ")[0] if row["source"] in SOURCE_LABELS else "📊"
            label = row["source"].replace("codebase_", "").replace("_", " ").title()
            ticketed = row.get("ticketed", 0)
            ticketed_html = f'<div class="source-ticketed">{ticketed} ticketed</div>' if ticketed else ""
            source_parts.append(f'''<div class="source-card">
                <div class="source-icon">{icon}</div>
                <div class="source-count">{row["count"]}</div>
                <div class="source-label">{label}</div>
                {ticketed_html}
            </div>''')
        html += '<div class="source-grid">' + ''.join(source_parts) + '</div>'

    return html


def build_findings_panel():
    html = build_stat_cards()

    rows = query("""
        SELECT id, source, type, title, severity, confidence, status, target_repo,
               affected_service, ticket_identifier, created_at
        FROM findings
        ORDER BY
            CASE status WHEN 'new' THEN 1 WHEN 'ticket_created' THEN 2 ELSE 3 END,
            CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
            created_at DESC
        LIMIT 100;
    """)

    if not rows:
        return html + '<div class="empty">No findings yet. Deep Thought hasn\'t run a cycle.</div>'

    html += """<table>
        <tr><th>Source</th><th>Title</th><th>Severity</th><th>Confidence</th><th>Status</th><th>Repo</th><th>Ticket</th><th>Age</th></tr>"""

    for r in rows:
        source_label = SOURCE_LABELS.get(r["source"], r["source"])
        sev_color = SEVERITY_COLORS.get(r["severity"], "#6b7280")
        status_color = STATUS_COLORS.get(r["status"], "#6b7280")
        ticket = ""
        if r["ticket_identifier"]:
            ticket = f'<a href="https://linear.app/{LINEAR_WORKSPACE_SLUG}/issue/{esc(r["ticket_identifier"])}" target="_blank">{esc(r["ticket_identifier"])}</a>'
        else:
            ticket = "—"
        conf_color = "#16a34a" if r["confidence"] >= 0.8 else ("#ca8a04" if r["confidence"] >= 0.6 else "#dc2626")
        conf_bar = f'<span style="display:inline-block;width:{int(r["confidence"]*40)}px;height:4px;border-radius:2px;background:{conf_color};margin-right:6px;vertical-align:middle"></span>'
        html += f"""<tr class="clickable" onclick="openDrawer({r['id']})">
            <td>{source_label}</td>
            <td class="desc-preview">{esc(r['title'])}</td>
            <td>{badge(r['severity'], sev_color)}</td>
            <td>{conf_bar}{r['confidence']:.0%}</td>
            <td>{badge(r['status'], status_color)}</td>
            <td>{esc(r['target_repo'] or '—')}</td>
            <td>{ticket}</td>
            <td><span class="ts">{r['created_at']}</span></td>
        </tr>"""

    html += "</table>"
    return html


def build_source_panel(source_filter, source_name):
    """Build a panel filtered to a specific source type."""
    if isinstance(source_filter, list):
        placeholders = ",".join("?" * len(source_filter))
        rows = query(f"""
            SELECT id, source, type, title, description, severity, confidence, status,
                   target_repo, affected_service, ticket_identifier, created_at
            FROM findings
            WHERE source IN ({placeholders})
            ORDER BY
                CASE status WHEN 'new' THEN 1 WHEN 'ticket_created' THEN 2 ELSE 3 END,
                created_at DESC
            LIMIT 50;
        """, source_filter)
    else:
        rows = query("""
            SELECT id, source, type, title, description, severity, confidence, status,
                   target_repo, affected_service, ticket_identifier, created_at
            FROM findings
            WHERE source = ?
            ORDER BY
                CASE status WHEN 'new' THEN 1 WHEN 'ticket_created' THEN 2 ELSE 3 END,
                created_at DESC
            LIMIT 50;
        """, (source_filter,))

    if not rows:
        return f'<div class="empty">No {source_name} findings yet.</div>'

    html = f"""<table>
        <tr><th>Type</th><th>Title</th><th>Service</th><th>Severity</th><th>Confidence</th><th>Status</th><th>Ticket</th><th>Age</th></tr>"""

    for r in rows:
        sev_color = SEVERITY_COLORS.get(r["severity"], "#6b7280")
        status_color = STATUS_COLORS.get(r["status"], "#6b7280")
        ticket = ""
        if r["ticket_identifier"]:
            ticket = f'<a href="https://linear.app/{LINEAR_WORKSPACE_SLUG}/issue/{esc(r["ticket_identifier"])}" target="_blank">{esc(r["ticket_identifier"])}</a>'
        else:
            ticket = "—"
        html += f"""<tr class="clickable" onclick="openDrawer({r['id']})">
            <td>{esc(r['type'])}</td>
            <td class="desc-preview">{esc(r['title'])}</td>
            <td>{esc(r['affected_service'] or '—')}</td>
            <td>{badge(r['severity'], sev_color)}</td>
            <td>{r['confidence']:.0%}</td>
            <td>{badge(r['status'], status_color)}</td>
            <td>{ticket}</td>
            <td><span class="ts">{r['created_at']}</span></td>
        </tr>"""

    html += "</table>"
    return html


def build_codebase_panel():
    # Show scanner runs first
    scanner_html = ""
    scanner_rows = query("""
        SELECT scanner_type, repo, status, findings_count, started_at, finished_at, error
        FROM scanner_runs
        ORDER BY started_at DESC
        LIMIT 30;
    """)

    if scanner_rows:
        scanner_html = """<h3 style="margin-bottom:12px;color:#94a3b8">Scanner runs</h3>
        <table><tr><th>Type</th><th>Repo</th><th>Status</th><th>Findings</th><th>Started</th><th>Duration</th><th>Error</th></tr>"""
        for r in scanner_rows:
            status_color = STATUS_COLORS.get(r["status"], "#6b7280")
            duration = "—"
            if r["started_at"] and r["finished_at"]:
                try:
                    s = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
                    f = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
                    secs = int((f - s).total_seconds())
                    duration = f"{secs}s" if secs < 60 else f"{secs // 60}m {secs % 60}s"
                except Exception:
                    pass
            scanner_html += f"""<tr>
                <td>{esc(r['scanner_type'])}</td>
                <td>{esc(r['repo'])}</td>
                <td>{badge(r['status'], status_color)}</td>
                <td>{r['findings_count'] or 0}</td>
                <td><span class="ts">{r['started_at']}</span></td>
                <td>{duration}</td>
                <td class="desc-preview">{esc(r['error'] or '—')}</td>
            </tr>"""
        scanner_html += "</table>"

    # Then show codebase findings
    findings_html = build_source_panel(
        ["codebase_todo", "codebase_deps", "codebase_pattern"],
        "codebase"
    )

    return scanner_html + "<br>" + findings_html


def build_runs_panel():
    rows = query("""
        SELECT cycle_number, phase, alerts_checked, traces_checked, log_patterns_checked,
               scanners_run, findings_created, tickets_created, started_at, finished_at
        FROM scan_runs
        ORDER BY started_at DESC
        LIMIT 30;
    """)

    if not rows:
        return '<div class="empty">No scan runs yet.</div>'

    html = """<table>
        <tr><th>Cycle</th><th>Phase</th><th>Alerts</th><th>Traces</th><th>Logs</th><th>Scanners</th><th>Findings</th><th>Tickets</th><th>Started</th><th>Duration</th></tr>"""

    for r in rows:
        duration = "—"
        if r["started_at"] and r["finished_at"]:
            try:
                s = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
                f = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
                secs = int((f - s).total_seconds())
                duration = f"{secs}s" if secs < 60 else f"{secs // 60}m {secs % 60}s"
            except Exception:
                pass

        # Highlight rows with findings/tickets
        findings = r["findings_created"] or 0
        tickets = r["tickets_created"] or 0
        findings_style = f' style="color:#16a34a;font-weight:600"' if findings > 0 else ""
        tickets_style = f' style="color:#60a5fa;font-weight:600"' if tickets > 0 else ""

        html += f"""<tr>
            <td>{r['cycle_number'] or '—'}</td>
            <td>{esc(r['phase'] or '—')}</td>
            <td>{r['alerts_checked'] or 0}</td>
            <td>{r['traces_checked'] or 0}</td>
            <td>{r['log_patterns_checked'] or 0}</td>
            <td>{r['scanners_run'] or 0}</td>
            <td{findings_style}>{findings}</td>
            <td{tickets_style}>{tickets}</td>
            <td><span class="ts">{r['started_at']}</span></td>
            <td>{duration}</td>
        </tr>"""

    html += "</table>"
    return html


def build_log_panel():
    events = get_activity_feed()

    if not events:
        return '<div class="empty">No activity yet.</div>'

    # Collect event types for filter buttons
    event_types = sorted(set(e["type"] for e in events))
    type_labels = {
        "ticket_created": "Tickets", "phase_alerts": "Alerts", "phase_telemetry": "Telemetry",
        "phase_codebase": "Codebase", "phase_ops": "Ops", "scanner": "Scanners",
    }
    filter_buttons = '<button class="activity-filter active" data-filter="all" onclick="filterActivity(\'all\', this)">All</button>'
    seen = set()
    for et in event_types:
        label = type_labels.get(et, et.replace("_", " ").title())
        if label in seen:
            continue
        seen.add(label)
        filter_buttons += f'<button class="activity-filter" data-filter="{et}" onclick="filterActivity(\'{et}\', this)">{label}</button>'

    # Build rows
    rows_html = ""
    for e in events:
        detail_text = esc(e.get("detail", ""))
        detail_html = f'<div style="color:#94a3b8;font-size:12px;margin-top:2px;white-space:pre-wrap;word-break:break-word">{detail_text}</div>' if detail_text else ""
        rows_html += f"""<tr class="activity-row" data-type="{e['type']}">
            <td style="text-align:center">{e.get('icon', '')}</td>
            <td><span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#334155;color:#94a3b8">{e['type'].replace('_',' ')}</span></td>
            <td><div>{esc(e.get('title', ''))}</div>{detail_html}</td>
            <td><span class="ts">{e.get('time', '')}</span></td>
        </tr>"""

    return f"""
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">{filter_buttons}</div>
    <table>
        <thead><tr><th style="width:30px"></th><th style="width:100px">Type</th><th>Event</th><th style="width:120px">Time</th></tr></thead>
        <tbody>{rows_html}</tbody>
    </table>"""


def build_page():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return Template(PAGE_HTML).safe_substitute(
        now=now,
        linear_slug=LINEAR_WORKSPACE_SLUG,
        stats_html=build_stats_html(),
        health_banner=build_health_banner(),
        findings_panel=build_findings_panel(),
        alerts_panel=build_source_panel("alert", "alert"),
        telemetry_panel=build_source_panel(["apm", "logs"], "telemetry"),
        codebase_panel=build_codebase_panel(),
        runs_panel=build_runs_panel(),
        log_panel=build_log_panel(),
    )


# ── HTTP Handler ─────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            self._handle_get()
        except Exception as e:
            error = f"Error: {e}".encode()
            self.send_response(500)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(error)))
            self.end_headers()
            self.wfile.write(error)
        finally:
            _close_shared_db()

    def _handle_get(self):
        if self.path == "/api/heartbeat":
            self._json(get_heartbeat() or {})
        elif self.path == "/api/findings":
            rows = query("SELECT * FROM findings ORDER BY created_at DESC LIMIT 100;")
            self._json(rows)
        elif self.path == "/api/runs":
            rows = query("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 30;")
            self._json(rows)
        elif self.path == "/api/activity":
            self._json(get_activity_feed())
        elif self.path == "/api/scanners":
            rows = query("SELECT * FROM scanner_runs ORDER BY started_at DESC LIMIT 30;")
            self._json(rows)
        elif self.path == "/api/stats":
            self._json(get_stats())
        elif self.path.startswith("/api/finding/"):
            try:
                finding_id = int(self.path[len("/api/finding/"):])
            except ValueError:
                self._json({"error": "Invalid finding ID"})
                return
            data = get_finding_detail(finding_id)
            if data is None:
                self.send_response(404)
                self._json({"error": "Finding not found"})
                return
            self._json(data)
        else:
            content = build_page().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    def _json(self, data):
        body = json.dumps(data, default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # Suppress access logs


# ── Main ─────────────────────────────────────────────────────

if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"DB not found at {DB_PATH}. Run dt-setup.sh first.")
        exit(1)

    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True
        allow_reuse_port = True

    server = ReusableHTTPServer((BIND_HOST, PORT), Handler)
    print(f"Deep Thought dashboard running on http://{BIND_HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard stopped.")
