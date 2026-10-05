// Test-only preload. Fail instead of making an accidental real request or
// binding a socket. All suites use injected in-memory transports/serve adapters.
import { Socket, Server } from 'node:net'
const refuse = () => { throw new Error('offline suite forbids real network I/O') }
globalThis.fetch = refuse
Socket.prototype.connect = refuse
Server.prototype.listen = refuse
