import { RealtimeServer } from './realtime.js'

const port = parseInt(process.env.REALTIME_PORT ?? '7780')
const server = new RealtimeServer(port)

server.start()
console.log(`[realtime] WebSocket server listening on ws://localhost:${port}`)

process.on('SIGTERM', () => {
  console.log('[realtime] Received SIGTERM, shutting down...')
  server.stop()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[realtime] Received SIGINT, shutting down...')
  server.stop()
  process.exit(0)
})
