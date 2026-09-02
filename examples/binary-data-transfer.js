// Two files are shown in one for readability: split at the section markers into worker.js and main.js to run.

// ============================== worker.js ===================================

import { expose } from 'osra'

const api = {
  echo: (view) => view,

  sum: (view) => view.reduce((total, byte) => total + byte, 0),

  describe: (view) => ({
    constructorName: view.constructor.name,
    byteLength: view.byteLength,
    values: [...view],
  }),

  byteLength: (buffer) => buffer.byteLength,

  double: (buffer) => {
    const input = new Uint8Array(buffer)
    const out = new Uint8Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = input[i] * 2
    return out.buffer
  },

  // a Blob is structured-clonable, so it revives as a Blob on the other side, nothing to await
  makeReport: () => ({
    name: 'report.csv',
    blob: new Blob(['id,value\n1,255\n'], { type: 'text/csv' }),
  }),

  // both ends queue with the default highWaterMark of 1, so up to ~2 chunks are produced eagerly before the consumer's first read
  randomBytes: (chunkCount, chunkSize) => {
    let sent = 0
    return new ReadableStream({
      pull: controller => {
        if (sent === chunkCount) {
          controller.close()
          return
        }
        const chunk = new Uint8Array(chunkSize)
        crypto.getRandomValues(chunk)
        sent++
        controller.enqueue(chunk)
      },
    })
  },
}

expose(api, { transport: self })

// ============================== main.js =====================================

import { expose, transfer } from 'osra'

const main = async () => {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  const api = await expose({}, { transport: worker })

  const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
  console.log(await api.sum(backing)) // 28

  // a subarray view sends exactly the view's window, not the 8-byte backing buffer
  console.log(await api.describe(backing.subarray(2, 5)))
  // { constructorName: 'Uint8Array', byteLength: 3, values: [2, 3, 4] }

  const floats = new Float64Array([0.5, 1.5])
  console.log((await api.echo(floats)) instanceof Float64Array) // true

  const buffer = new Uint8Array([10, 20, 30]).buffer
  const doubled = await api.double(buffer)
  console.log(doubled instanceof ArrayBuffer, [...new Uint8Array(doubled)]) // true [20, 40, 60]
  // the default is COPY semantics - the local buffer is untouched after a send
  console.log(buffer.byteLength) // 3

  const report = await api.makeReport()
  console.log(report.blob instanceof Blob, report.blob.type) // true 'text/csv'
  console.log(await report.blob.text()) // 'id,value\n1,255\n'

  const big = new ArrayBuffer(16 * 1024 * 1024)
  console.log(await api.byteLength(transfer(big))) // 16777216
  // on JSON transports (WebSocket, web extension messaging) transfer() silently degrades to a copy and the source stays usable
  console.log(big.byteLength) // 0 - detached

  const stream = await api.randomBytes(4, 1024)
  const reader = stream.getReader()
  let received = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    received += value.byteLength
  }
  console.log(received) // 4096

  worker.terminate()
}

main().catch(console.error)
