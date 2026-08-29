---
title: Transport modes
description: Osra's transport layers
---

Osra supports two different transport modes:

- JSON mode transporting [JSON](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON) only values.

- Structured mode for [structured](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) and [transferable](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) values.

These two different modes exists because depending on the [transport](/guides/transports) you want to use, the platform allows us to send the data more efficiently.

If you were to transfer an image from your web page to a web worker, calling [`postMessage()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) with the [transfer](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) option would allow us to transfer that data instead of copying it, like so:

```ts twoslash title="main.ts"
const worker = new Worker('/worker.ts', { type: 'module' })

const buffer = new ArrayBuffer(1024)
worker.postMessage(buffer, { transfer: [buffer] })
```

This is only possible when the two peers can share the same memory space(the browser's) and those transports are what we call "Structured" [transports](/guides/transports) like the [`Worker`](https://developer.mozilla.org/en-US/docs/Web/API/Worker), [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker), and [more](/guides/transports).

The other type of transport are called "JSON" [transports](/guides/transports), which includes [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) and WebExtension's [`Port`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port).

Osra will automatically choose the appropriate transport mode for you depending on your transport, so you generally don't have to worry about it.
For cases where you are out of osra's default scope, you can always specify the transport mode manually through osra's [Custom Transport](/guides/custom-transports-and-relays/).
