import fs from 'node:fs'
import path from 'node:path'
import type { SkillName } from './types.js'

// Pattern to detect helper references in skill files
// Matches: "See helpers/foo.md", "> See helpers/foo.md", "See helpers/foo-bar.md — description"
const HELPER_REF_PATTERN = /See helpers\/([\w-]+)\.md/g

export function loadSkill(
  skillName: SkillName,
  args: Record<string, string>,
  marvinRepoPath: string,
): string {
  const skillsDir = path.join(marvinRepoPath, 'skills')
  const helpersDir = path.join(skillsDir, 'helpers')

  // Map skill names to file names (underscores → hyphens)
  const fileName = skillName.replace(/_/g, '-')
  const skillPath = path.join(skillsDir, `${fileName}.md`)

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill file not found: ${skillPath}`)
  }

  let content = fs.readFileSync(skillPath, 'utf-8')

  // Collect and inline helper references
  const inlinedHelpers = new Set<string>()
  const helperContents: string[] = []

  let match: RegExpExecArray | null
  // Reset regex state
  HELPER_REF_PATTERN.lastIndex = 0
  while ((match = HELPER_REF_PATTERN.exec(content)) !== null) {
    const helperName = match[1]
    if (inlinedHelpers.has(helperName)) continue
    inlinedHelpers.add(helperName)

    const helperPath = path.join(helpersDir, `${helperName}.md`)
    if (fs.existsSync(helperPath)) {
      let helperContent = fs.readFileSync(helperPath, 'utf-8')
      helperContent = substituteVars(helperContent, args)
      helperContents.push(helperContent)
    }
  }

  // Substitute template variables in the main content
  content = substituteVars(content, args)

  // Append helpers at the end
  if (helperContents.length > 0) {
    content += '\n\n---\n\n# Referenced Helpers\n\n' + helperContents.join('\n\n---\n\n')
  }

  return content
}

function substituteVars(template: string, vars: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    // Replace both {key} and <key> patterns
    result = result.replaceAll(`{${key}}`, value)
    result = result.replaceAll(`<${key}>`, value)
  }
  return result
}
