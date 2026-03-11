import fs from 'node:fs'
import path from 'node:path'
import type { SkillMeta } from './types.js'
import { SKILL_META } from './types.js'

const GENERATED_HEADER = (skillName: string) =>
  `<!-- Generated from skills/${skillName}.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->\n`

// Specific helper references
const CHECKPOINT_REF = /^>\s*See helpers\/phase-checkpoint\.md(?:\s*—\s*(.+))?\s*$/gm
const BRANCH_SAFETY_REF = /^>\s*See helpers\/branch-safety\.md(?:\s*—\s*(.+))?\s*$/gm
const ERROR_HANDLING_REF = /^>\s*See helpers\/error-handling\.md(?:\s*—\s*(.+))?\s*$/gm
const GENERIC_HELPER_REF = /^>\s*See helpers\/([\w-]+)\.md(?:\s*—\s*(.+))?\s*$/gm

export function compileCodex(
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

  // Step 1: Replace phase-checkpoint references with a simple note
  content = content.replace(CHECKPOINT_REF, '> Track progress by logging phase transitions.')

  // Step 2: Replace branch-safety references with inline check
  let branchSafetyDone = false
  content = content.replace(BRANCH_SAFETY_REF, () => {
    if (!branchSafetyDone) {
      branchSafetyDone = true
      return `Verify you're on a feature branch (not main/master) before proceeding.`
    }
    return `Re-verify you're on a feature branch before committing.`
  })

  // Step 3: Replace error-handling references with inline note
  content = content.replace(ERROR_HANDLING_REF, 'On failure, report the error and stop.')

  // Step 4: Inline remaining helper references (non-infrastructure ones)
  content = content.replace(GENERIC_HELPER_REF, (match, helperName) => {
    // Skip already-handled helpers
    if (['phase-checkpoint', 'branch-safety', 'error-handling'].includes(helperName)) {
      return ''
    }

    const helperPath = path.join(helpersDir, `${helperName}.md`)
    if (fs.existsSync(helperPath)) {
      let helperContent = fs.readFileSync(helperPath, 'utf-8')
      // Strip the helper's title
      helperContent = helperContent.replace(/^# .+\n+/, '')
      // Strip any sqlite3 blocks from the helper
      helperContent = stripSqliteBlocks(helperContent)
      return helperContent.trim()
    }

    return match
  })

  // Step 5: Strip all sqlite3 blocks (Marvin DB operations)
  content = stripSqliteBlocks(content)

  // Step 6: Clean up extra blank lines
  content = content.replace(/\n{4,}/g, '\n\n\n')

  // Step 7: Build Codex document
  const title = extractTitle(content)
  const constraints = buildConstraints(meta)

  let output = `${GENERATED_HEADER(meta.fileName)}
# Task: ${title}

## Instructions

${content.trim()}

## Constraints

${constraints}

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
`

  if (!output.endsWith('\n')) {
    output += '\n'
  }

  // Write output
  const outputPath = path.join(outputDir, `${meta.fileName}.md`)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, output, 'utf-8')

  return outputPath
}

function stripSqliteBlocks(content: string): string {
  // Replace sqlite3 command blocks with intent-describing comments
  const sqliteBlock = /```bash\n(sqlite3\s+[^\n]*"[\s\S]*?)```/g
  content = content.replace(sqliteBlock, (_match, sqlBody: string) => {
    // Determine the intent from the SQL
    if (sqlBody.includes('last_phase')) {
      const phaseMatch = sqlBody.match(/last_phase\s*=\s*'([^']+)'/)
      const phase = phaseMatch ? phaseMatch[1] : 'current'
      return `\`\`\`\n# [CHECKPOINT: entering phase ${phase}]\n\`\`\``
    }
    if (sqlBody.includes("status = 'done'")) {
      return '```\n# [STATE: mark ticket as done]\n```'
    }
    if (sqlBody.includes("status = 'failed'")) {
      return '```\n# [STATE: mark as failed with error]\n```'
    }
    if (sqlBody.includes("status = 'completed'")) {
      return '```\n# [STATE: mark run as completed]\n```'
    }
    if (sqlBody.includes("status = 'explored'")) {
      return '```\n# [STATE: mark ticket as explored]\n```'
    }
    if (sqlBody.includes('review_comments')) {
      return '```\n# [STATE: update review comment status]\n```'
    }
    if (sqlBody.includes('review_runs')) {
      return '```\n# [STATE: update review run status]\n```'
    }
    if (sqlBody.includes('INSERT INTO digests')) {
      return '```\n# [STATE: record digest]\n```'
    }
    if (sqlBody.includes('INSERT INTO doc_runs')) {
      return '```\n# [STATE: create doc run record]\n```'
    }
    if (sqlBody.includes('digest_included_at')) {
      return '```\n# [STATE: mark tickets as digested]\n```'
    }
    if (sqlBody.includes('INSERT INTO reassess_requests') || sqlBody.includes('reassess_requests')) {
      return '```\n# [STATE: update reassess request]\n```'
    }
    return '```\n# [STATE: update state]\n```'
  })

  // Also handle sqlite3 blocks without the bash fence (inline sqlite3 calls)
  content = content.replace(/```sql\n[\s\S]*?```/g, (match) => {
    if (match.includes('last_phase')) return '```\n# [CHECKPOINT]\n```'
    if (match.includes('heartbeat')) return '```\n# [HEARTBEAT: update liveness]\n```'
    return '```\n# [STATE: update state]\n```'
  })

  // Handle bare sqlite3 command lines (not in code blocks)
  // e.g. "DOC_RUN_ID=$(sqlite3 ...)"
  content = content.replace(/^.*sqlite3\s+.*$/gm, (match) => {
    if (match.includes('last_insert_rowid')) return '# [STATE: capture inserted row ID]'
    return '# [STATE: database operation]'
  })

  return content
}

function extractTitle(content: string): string {
  const titleMatch = content.match(/^# (.+?)$/m)
  if (titleMatch) {
    return titleMatch[1].replace(/\s*—\s*.*$/, '').trim()
  }
  return 'Unknown'
}

function buildConstraints(meta: SkillMeta): string {
  // Deep Thought skills are read-only — different constraint set
  if (meta.system === 'deep-thought') {
    const constraints = [
      '- Read-only codebase access — never modify code, only read',
      '- Deduplicate findings by hash before creating tickets',
      '- Only create tickets for findings with sufficient confidence',
      '- All created tickets must be labeled appropriately',
    ]

    if (meta.workerType === 'scanner') {
      constraints.push('- Write results to the designated JSON file only')
      constraints.push('- Update scanner_runs DB entry on completion')
    }

    return constraints.join('\n')
  }

  const constraints = [
    '- Never commit to main/master — always verify branch before committing',
    '- Never force push',
    '- Always create draft PRs',
    '- Run tests before committing',
  ]

  if (meta.name === 'audit') {
    constraints.push('- Never merge PRs — only review, label, and conditionally approve')
    constraints.push('- Never push code — audit is read-only')
    constraints.push('- Never modify files')
  }

  if (meta.name === 'explore') {
    constraints.push('- Do NOT modify any files — read-only exploration')
    constraints.push('- Do NOT commit or push anything')
    constraints.push('- Do NOT create PRs')
  }

  if (meta.name === 'ci_fix') {
    constraints.push('- Maximum 5 files changed per fix attempt')
    constraints.push('- Never modify CI config files')
    constraints.push('- If tests pass locally but fail in CI, do not change code (likely flaky)')
  }

  if (meta.name === 'review') {
    constraints.push('- Never modify files outside the scope of review comments')
    constraints.push('- Never merge the PR')
    constraints.push('- Always resolve review threads after replying (except out-of-scope)')
  }

  if (meta.name === 'docs') {
    constraints.push('- Never modify source code — no code changes, no inline comments')
    constraints.push('- All substantive docs go in docs/ directory')
    constraints.push('- DO NOT REMOVE EXISTING COMMENTS')
  }

  return constraints.join('\n')
}
