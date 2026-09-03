import { after, before } from 'node:test'

import { WebSocketServer } from 'ws'

/** The relay the websocket tests dial: tests/ws-relay.mjs on port 3001, which playwright starts as
 *  a webServer. The node runner hosts the same forwarding in-process for the group that needs it,
 *  so `ws://localhost:3001` reaches a peer here too. A busy port fails the group with the reason,
 *  since a test dialing a foreign server could only time out. */
export const RELAY_PORT = 3001

export const useWebSocketRelay = (port = RELAY_PORT) => {
  let server: WebSocketServer | undefined
  before(async () => {
    const relay = new WebSocketServer({ port })
    relay.on('connection', socket => {
      socket.on('message', data => {
        for (const client of relay.clients) {
          if (client !== socket && client.readyState === 1) client.send(data.toString())
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      relay.once('listening', resolve)
      // naming the likely holder saves a diagnosis: the playwright suite serves tests/ws-relay.mjs on
      // this same port for its own run, so the two suites cannot share a machine at the same moment
      relay.once('error', error => reject(new Error(
        `ws relay could not listen on :${port}: ${error.message}`
        + '; the playwright suite serves that port for its own relay, so let one run finish first',
      )))
    })
    server = relay
  })
  after(() => new Promise<void>(resolve => {
    if (!server) return resolve()
    for (const client of server.clients) client.terminate()
    server.close(() => resolve())
  }))
}
