import fs from 'node:fs'
import path from 'node:path'
import type { SkillMeta } from './types.js'
import { SKILL_META } from './types.js'

const GENERATED_HEADER = (skillName: string) =>
  `<!-- Generated from skills/${skillName}.md by harness/claude-code.ts — DO NOT EDIT DIRECTLY -->\n`

// Phase checkpoint reference with metadata: "> See helpers/phase-checkpoint.md — table: `tickets`, role: `executor`"
const CHECKPOINT_REF = /^>\s*See helpers\/phase-checkpoint\.md\s*—\s*table:\s*`(\w+)`\s*,\s*role:\s*`([\w-]+)`\s*$/gm

// Branch safety reference: "> See helpers/branch-safety.md" or with description
const BRANCH_SAFETY_REF = /^>\s*See helpers\/branch-safety\.md(?:\s*—\s*(.+))?\s*$/gm

// Error handling reference
const ERROR_HANDLING_REF = /^>\s*See helpers\/error-handling\.md(?:\s*—\s*(.+))?\s*$/gm

// Generic helper reference (catch-all) — matches both "> See helpers/..." and "> Context: See helpers/..."
const GENERIC_HELPER_REF = /^>\s*(?:Context:\s*)?See helpers\/([\w-]+)\.md(?:\s*—\s*(.+))?\s*$/gm

export function compileClaudeCode(
  skillName: string,
  skillsDir: string,
  outputDir: string,
): string {
  const meta = SKILL_META[skillName]
  if (!meta) {
    throw new Error(`Unknown skill: ${skillName}. Known skills: ${Object.keys(SKILL_META).join(', ')}`)
  }

  const helpersDir = path.join(skillsDir, 'helpers')
  const skillPath = path.join(skillsDir, `${meta.fileName}.md`)

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill file not found: ${skillPath}`)
  }

  let content = fs.readFileSync(skillPath, 'utf-8')

  // Step 1: Transform the title line
  content = transformTitle(content, meta)

  // Step 2: Replace the skill's one-liner description with the preamble
  content = addPreamble(content, meta)

  // Step 3: Transform "## Inputs" to "## Input" with command-file style intro
  content = transformInputSection(content)

  // Step 4: Remove all helper references (we'll inject content separately)
  // First, extract whether checkpoint is needed (from the reference)
  const needsCheckpoint = meta.needsCheckpoint && CHECKPOINT_REF.test(content)
  CHECKPOINT_REF.lastIndex = 0

  // Remove all helper references
  content = content.replace(CHECKPOINT_REF, '')
  content = content.replace(BRANCH_SAFETY_REF, '')
  content = content.replace(ERROR_HANDLING_REF, '')
  content = content.replace(GENERIC_HELPER_REF, (match, helperName) => {
    if (['phase-checkpoint', 'branch-safety', 'error-handling'].includes(helperName)) {
      return ''
    }
    // For other helpers, inline their content
    const helperPath = path.join(helpersDir, `${helperName}.md`)
    if (fs.existsSync(helperPath)) {
      let helperContent = fs.readFileSync(helperPath, 'utf-8')
      // Strip the helper's top-level heading
      helperContent = helperContent.replace(/^# .+\n+/, '')
      return helperContent.trim()
    }
    return match
  })

  // Step 5: If checkpoint is needed, inject the checkpoint helper section
  // Place it right before "## Workflow" or the first "### " section
  if (needsCheckpoint && meta.checkpointTable) {
    const checkpointSection = buildCheckpointSection(meta)
    content = injectBeforeWorkflow(content, checkpointSection)
  }

  // Step 6: Clean up extra blank lines (3+ consecutive blank lines → 2)
  content = content.replace(/\n{4,}/g, '\n\n\n')

  // Step 7: Ensure the file ends with a single newline
  content = content.trimEnd() + '\n'

  // Prepend generated header
  content = GENERATED_HEADER(meta.fileName) + content

  // Write output
  const outputPath = path.join(outputDir, `${meta.commandName}.md`)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, content, 'utf-8')

  return outputPath
}

function transformTitle(content: string, meta: SkillMeta): string {
  // Replace first heading: "# Execute — ..." → "# /marvin-execute — ..."
  return content.replace(
    /^# .+?(?=\s—\s|$)/m,
    `# /${meta.commandName}`,
  )
}

function addPreamble(content: string, meta: SkillMeta): string {
  const lines = content.split('\n')
  let titleIdx = -1

  // Find the title line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('# /')) {
      titleIdx = i
      break
    }
  }
  if (titleIdx === -1) return content

  // Find where the description starts (first non-blank after title) and ends (first ## heading)
  let descStart = titleIdx + 1
  while (descStart < lines.length && lines[descStart].trim() === '') descStart++

  let descEnd = descStart
  while (descEnd < lines.length && !lines[descEnd].startsWith('## ')) descEnd++

  // Preserve helper references ("> See helpers/..." or "> Context: See helpers/...")
  // that live in the description zone — they need to survive for later inlining
  const preservedLines: string[] = []
  for (let i = descStart; i < descEnd; i++) {
    if (/^>\s*(?:Context:\s*)?See helpers\//.test(lines[i])) {
      preservedLines.push(lines[i])
    }
  }

  // Replace lines [descStart, descEnd) with the preamble + preserved references
  const newLines = [`\n${meta.preamble}\n`]
  if (preservedLines.length > 0) {
    newLines.push(...preservedLines, '')
  }
  lines.splice(descStart, descEnd - descStart, ...newLines)

  return lines.join('\n')
}

function transformInputSection(content: string): string {
  content = content.replace(
    /^## Inputs$/m,
    '## Input\n\nYou will receive these arguments from the orchestrator:',
  )
  return content
}

function injectBeforeWorkflow(content: string, section: string): string {
  // Place checkpoint section right before "## Workflow"
  const workflowIdx = content.indexOf('## Workflow')
  if (workflowIdx !== -1) {
    return content.slice(0, workflowIdx) + section + '\n\n' + content.slice(workflowIdx)
  }

  // Fallback: place before the first "### " heading
  const firstH3 = content.search(/^### /m)
  if (firstH3 !== -1) {
    return content.slice(0, firstH3) + section + '\n\n' + content.slice(firstH3)
  }

  // Last resort: append after the input section
  return content + '\n\n' + section
}

function buildCheckpointSection(meta: SkillMeta): string {
  const defaultDbPath = meta.system === 'deep-thought'
    ? '~/.deep-thought/state/deep-thought.db'
    : '~/.marvin/state/marvin.db'
  const dbPath = meta.usesDbPathEnv ? '"$DB_PATH"' : defaultDbPath
  const idValue = getIdPlaceholder(meta)
  const identifierField = meta.identifierField
  const workerType = meta.workerType

  return `## Phase checkpoint helper

At the start of each phase, run BOTH of these statements — update \`last_phase\` for liveness tracking AND log to \`cycle_events\` so the dashboard shows real-time progress:

\`\`\`bash
sqlite3 ${dbPath} "
  UPDATE ${meta.checkpointTable} SET last_phase = '<PHASE_NAME>', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')${meta.checkpointExtraColumns} WHERE ${meta.checkpointIdColumn} = ${idValue}${meta.checkpointWhereExtra};
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '${identifierField} ${workerType}: entering phase <PHASE_NAME>');
"
\`\`\`

**Periodic heartbeat**: During long-running phases${getLongRunningPhaseExamples(meta)}, re-run the UPDATE (not the INSERT) every ~10 minutes to signal liveness. You don't need to change \`last_phase\` — just re-run it to refresh \`last_phase_at\`.

**CRITICAL**: You MUST run this checkpoint SQL at the start of EVERY phase below. The ops phase uses \`last_phase\` to detect stuck workers. If you don't update these, your run will be reaped as stale after ${meta.staleMinutes} minutes even if you're still working.`
}

function getIdPlaceholder(meta: SkillMeta): string {
  switch (meta.checkpointIdColumn) {
    case 'linear_id': return "'<linear_id>'"
    case 'ticket_linear_id': return "'<linear_id>'"
    case 'id': {
      if (meta.system === 'deep-thought' && meta.checkpointTable === 'scanner_runs') return '$SCANNER_RUN_ID'
      if (meta.usesDbPathEnv) return '$AUDIT_RUN_ID'
      if (meta.name === 'ci_fix') return '<ci_fix_run_id>'
      if (meta.name === 'docs') return '$DOC_RUN_ID'
      return '<run_id>'
    }
    default: return "'<id>'"
  }
}

function getLongRunningPhaseExamples(meta: SkillMeta): string {
  switch (meta.name) {
    case 'execute': return ' (especially `explore`, `implement`, and `test`)'
    case 'explore': return ''
    case 'review': return ' (especially `address-comments`)'
    case 'audit': return ' (especially `architectural-review`)'
    case 'ci_fix': return ' (especially `investigate` and `fix`)'
    case 'dt_scan_todos': return ' (especially `scanning`)'
    case 'dt_scan_deps': return ' (especially `scanning`)'
    case 'dt_scan_patterns': return ' (especially `scanning`)'
    default: return ''
  }
}
