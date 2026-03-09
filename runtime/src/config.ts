import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MarvinConfigSchema } from './types.js'
import type { MarvinConfig } from './types.js'

function resolveTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return filePath
}

function resolveMarvinRepoRoot(): string {
  // Walk up from this file (runtime/src/config.ts) to find the marvin repo root
  let dir = path.dirname(new URL(import.meta.url).pathname)
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'config')) && fs.existsSync(path.join(dir, 'skills'))) {
      return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('Could not locate marvin repo root from runtime module')
}

export function loadConfig(configPath?: string): MarvinConfig {
  const resolved = configPath
    ?? process.env.MARVIN_CONFIG
    ?? path.join(resolveMarvinRepoRoot(), 'config', 'default.json')

  const absolutePath = resolveTilde(resolved)

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`)
  }

  const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'))
  const parsed = MarvinConfigSchema.parse(raw)

  // Resolve tilde in path fields
  parsed.state_db = resolveTilde(parsed.state_db)
  parsed.log_dir = resolveTilde(parsed.log_dir)
  parsed.backup_dir = resolveTilde(parsed.backup_dir)
  parsed.worktree_root = resolveTilde(parsed.worktree_root)
  parsed.marvin_repo_path = resolveTilde(parsed.marvin_repo_path)
  if (parsed.plugins_dir) {
    parsed.plugins_dir = resolveTilde(parsed.plugins_dir)
  }

  // Resolve repo paths
  for (const key of Object.keys(parsed.repos)) {
    parsed.repos[key] = resolveTilde(parsed.repos[key])
  }

  return parsed
}

export function resolveDbPath(config: MarvinConfig): string {
  return path.resolve(resolveTilde(config.state_db))
}
