import { runOrchestrator } from './orchestrator.js'

runOrchestrator().catch((err) => {
  console.error('Orchestrator fatal:', err)
  process.exit(1)
})
