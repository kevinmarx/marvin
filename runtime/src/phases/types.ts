export interface SpawnRequest {
  id: string
  skill: string
  args: Record<string, string>
  ticketId?: string
  identifier?: string
}

export interface PhaseResult {
  summary: string
  spawnRequests: SpawnRequest[]
}
