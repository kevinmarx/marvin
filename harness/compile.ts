#!/usr/bin/env npx tsx
// Usage: npx tsx harness/compile.ts [--target claude-code|codex|all] [--skill name|all] [--out dir]
//
// Reads skills/ directory, applies harness-specific transformations, writes output.
// Skills are the portable source of truth; harnesses are compilation targets.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_META } from './types.js'
import { compileClaudeCode } from './claude-code.js'
import { compileCodex } from './codex.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SKILLS_DIR = path.join(REPO_ROOT, 'skills')
const DEFAULT_OUT_DIR = REPO_ROOT

function parseArgs(argv: string[]): { target: string; skill: string; outDir: string } {
  let target = 'all'
  let skill = 'all'
  let outDir = DEFAULT_OUT_DIR

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target':
        target = argv[++i]
        break
      case '--skill':
        skill = argv[++i]
        break
      case '--out':
        outDir = path.resolve(argv[++i])
        break
      default:
        console.error(`Unknown flag: ${argv[i]}`)
        console.error('Usage: npx tsx harness/compile.ts [--target claude-code|codex|all] [--skill name|all] [--out dir]')
        process.exit(1)
    }
  }

  if (!['claude-code', 'codex', 'all'].includes(target)) {
    console.error(`Invalid target: ${target}. Must be claude-code, codex, or all.`)
    process.exit(1)
  }

  return { target, skill, outDir }
}

function getSkillNames(skillFilter: string): string[] {
  if (skillFilter === 'all') {
    return Object.keys(SKILL_META)
  }

  // Normalize: accept both 'ci-fix' and 'ci_fix'
  const normalized = skillFilter.replace(/_/g, '-')
  if (!SKILL_META[normalized]) {
    console.error(`Unknown skill: ${skillFilter}. Available: ${Object.keys(SKILL_META).join(', ')}`)
    process.exit(1)
  }
  return [normalized]
}

function main() {
  const { target, skill, outDir } = parseArgs(process.argv)
  const skillNames = getSkillNames(skill)
  const results: string[] = []

  const targets: string[] = target === 'all' ? ['claude-code', 'codex'] : [target]

  for (const t of targets) {
    for (const name of skillNames) {
      try {
        let outputPath: string
        if (t === 'claude-code') {
          const claudeOutDir = path.join(outDir, '.claude', 'commands')
          outputPath = compileClaudeCode(name, SKILLS_DIR, claudeOutDir)
        } else {
          const codexOutDir = path.join(outDir, 'harness', 'output', 'codex')
          outputPath = compileCodex(name, SKILLS_DIR, codexOutDir)
        }
        const relPath = path.relative(REPO_ROOT, outputPath)
        results.push(`  ${t}: ${name} → ${relPath}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`Error compiling ${name} for ${t}: ${msg}`)
        process.exit(1)
      }
    }
  }

  console.log(`Compiled ${results.length} file(s):`)
  for (const r of results) {
    console.log(r)
  }
}

main()
