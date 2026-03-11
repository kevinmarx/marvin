# Harness — Multi-target skill compiler

Skills (`skills/*.md`) are the portable, editable source of truth for Marvin's worker behaviors. Harnesses compile these skills into target-specific formats.

## Why harnesses exist

Different agent runtimes have different requirements:

| Target | Format | What it does |
|--------|--------|-------------|
| **Claude Code** | `.claude/commands/marvin-{name}.md` | Inlines helpers, adds checkpoint SQL, preamble, safety rules |
| **Codex** | `harness/output/codex/{name}.md` | Flattens skill + helpers, strips Marvin DB SQL, adds constraints/environment |
| **Raw API** | (runtime itself) | `runtime/src/skills.ts` loads skills + helpers at runtime with variable substitution |

The raw API harness is the runtime itself — `src/agent.ts` + `src/skills.ts` load skills dynamically and don't need a compilation step.

## How to compile

From the repo root:

```bash
# Compile all skills for all targets
npx tsx harness/compile.ts --target all

# Compile a single skill for Claude Code
npx tsx harness/compile.ts --target claude-code --skill execute

# Compile all skills for Codex
npx tsx harness/compile.ts --target codex

# Or via the package.json script (from runtime/)
cd runtime && npm run compile:harness
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--target` | `all` | `claude-code`, `codex`, or `all` |
| `--skill` | `all` | Skill file name (e.g. `execute`, `ci-fix`) or `all` |
| `--out` | repo root | Base output directory |

## How it works

```
skills/execute.md (source of truth)
  + skills/helpers/phase-checkpoint.md
  + skills/helpers/branch-safety.md
  + skills/helpers/error-handling.md
  ↓
harness/compile.ts
  ├─ claude-code.ts → .claude/commands/marvin-execute.md
  └─ codex.ts       → harness/output/codex/execute.md
```

### Claude Code harness

Transforms a skill into a `.claude/commands/marvin-{name}.md` file:

1. **Title**: `# Execute — ...` → `# /marvin-execute — ...`
2. **Preamble**: Adds "You are a teammate agent..." role description
3. **Input section**: Adds "You will receive these arguments from the orchestrator:"
4. **Phase checkpoint**: Inlines the full checkpoint SQL template with skill-specific table/column info
5. **Branch safety**: Resolves `> See helpers/branch-safety.md` references
6. **Error handling**: Resolves `> See helpers/error-handling.md` references
7. **Other helpers**: Inlines any remaining helper references

### Codex harness

Transforms a skill into a Codex-compatible task definition:

1. Flattens the skill + all helpers into a single document
2. Strips Marvin-specific SQLite SQL, replaces with `# [CHECKPOINT: entering phase ...]` comments
3. Adds a "Constraints" section from safety invariants
4. Adds an "Environment" section with variable placeholders

## Adding a new harness

1. Create `harness/{target}.ts` exporting a `compile{Target}(skillName, skillsDir, outputDir)` function
2. Add the target to `compile.ts`'s target list and dispatch logic
3. Add skill metadata to `harness/types.ts` `SKILL_META` if needed
4. Document the target in this README

## Key design principles

- **Skills are the source of truth** — never edit generated command files directly
- **Idempotent** — running the compiler twice produces the same output
- **Generated files have a header** — `<!-- Generated from skills/{name}.md by harness/{target}.ts — DO NOT EDIT DIRECTLY -->`
- **Text transformation, not AST parsing** — regex and string manipulation keep it simple
