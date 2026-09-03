/** Tests the node runner skips, with the reason. Keys are `Group` or `Group/name`. A missing key
 *  means the test runs, so an entry here is a deliberate claim that node cannot host it; everything
 *  the browser suite can express with node's own globals stays in. */
export const browserOnly: Readonly<Record<string, string>> = {
  'PlatformTransports/sharedWorkerRpc': 'SharedWorker is a browser API',
  'PlatformTransports/windowTransportObservesThePeerOrigin': 'iframes and window.postMessage are browser APIs',
  WorkerHandshake: 'blob-URL module Worker; node workers are covered by WorkerThreads',
  WorkerChannels: 'real Worker, and the Gecko port queue behaviour it pins; node workers are covered by WorkerThreads',
  GettingStarted: 'the examples use a browser Worker; the same examples run over worker_threads in WorkerThreads',
  'IdentityChain/identityRoundTripsThroughAWorker': 'blob-URL module Worker; see WorkerThreads',
  'Transfer/offscreenCanvasTransfersAsCanvas': 'OffscreenCanvas is a browser API; node has no canvas or 2d raster context',
}
