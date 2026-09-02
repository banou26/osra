---
title: Overview
description: What is on each page of the documentation, and the order worth reading them in.
---

Osra lets two execution contexts call each other's functions and pass each other's values as if they were local: a page and a worker, a page and an iframe, an extension's content script and its background, two ends of a WebSocket.\
Each side calls `expose()` once, and what the other side exposed comes back ready to use.

If you want to see that working before reading anything else, [getting started](/general/getting-started/) is the whole idea in one page.

## Start here

- [Getting started](/general/getting-started/) is osra in a handful of lines: one `expose()` on each side, and a function called across the boundary.
- [Installation](/general/installation/) covers installing the package and wiring a page to a worker.

## The guides

Read these in order the first time, they build on each other.

- [Transport modes](/guides/transport-modes/) is the one distinction to learn early: a structured transport carries live values, a JSON one carries text, and it decides what you can send.
- [Transports](/guides/transports/) walks every channel osra runs over, from workers and iframes to WebSockets, service workers and the web extension family.
- [Custom transports & relays](/guides/custom-transports-and-relays/) wraps anything else in an `{ emit, receive }` pair, and forwards traffic between two contexts that cannot see each other.
- [Supported types](/guides/supported-types/) is the table to keep open: what crosses, what needs a structured transport, and what cannot cross at all.
- [Revivables](/guides/revivables/) covers the values that stay alive across the boundary, functions, promises, generators, streams and abort signals, and how each of them behaves once it has crossed.
- [identity() and transfer()](/guides/identity-and-transfer/) are the two ways to change how a value crosses: keep its reference stable, or move it instead of copying it.
- [Connections](/guides/connections/) is what a connection actually is, how the handshake makes one, and how to read, identify and drop each peer.
- [Multiple peers](/guides/multiple-peers/) covers several connections sharing one channel, and the options that decide who your side talks to.
- [Errors and lifecycle](/guides/lifecycle/) is what happens when things end: how errors cross, when `expose()` rejects, and what becomes of everything in flight when a connection goes away.
- [Custom revivables](/guides/custom-revivables/) teaches osra a type it does not know, your own class for example, by writing the same kind of module its built-in types are.

## Reference

- [expose()](/reference/expose/) is the full signature and every option.
- [TypeScript](/reference/typescript/) explains how `Remote<T>` maps your types across the connection, how the `Capable` check rejects what cannot cross, and how to read its errors.
- [Low-level API](/reference/low-level/) is what `expose()` is built on: `startConnections()`, `relay()`, the raw message helpers and the type guards.
- [Limitations](/reference/limitations/) is the honest list of what a message boundary makes impossible, and the workaround where there is one.

One thing to note is that the reference pages under [API](/api/) are generated from the source, so they are the place to check an exact signature.

## Internals

- [How it works](/internals/how-it-works/) is the handshake, the boxing walk and the port routing underneath every live value. Worth reading if you are writing a custom revivable, debugging something strange, or just curious.
