// Loaded before every test process. A default transport or accidental socket
// is a test failure, including attempts whose exceptions an adapter redacts.
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import dgram from 'node:dgram'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, resolve, sep } from 'node:path'

function blocked() {
  process.exitCode = 88
  throw new Error('offline suite forbids network access')
}
// Loopback is hermetic, not network: contract doubles bind 127.0.0.1
// explicitly and fetch it. Numeric loopback needs no DNS, so name
// resolution stays fully blocked. Anything off-loopback stays blocked.
const LOOPBACK = new Set(['127.0.0.1', '::1'])
function loopbackUrl(url) {
  try {
    return LOOPBACK.has(new URL(String(url)).hostname)
  } catch {
    return false
  }
}
const realFetch = globalThis.fetch
globalThis.fetch = (url, ...rest) => (loopbackUrl(url) ? realFetch(url, ...rest) : blocked())
const realListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const options = args[0] && typeof args[0] === 'object' ? args[0] : null
  const host = options ? options.host : typeof args[1] === 'string' ? args[1] : null
  if (host && LOOPBACK.has(host)) return realListen.apply(this, args)
  return blocked()
}
// Binding or reaching numeric loopback resolves without touching DNS or the
// wire, so the resolver stays blocked for everything else.
const realLookup = dns.lookup
dns.lookup = (host, ...rest) => (LOOPBACK.has(host) ? realLookup(host, ...rest) : blocked())
const realLookupAsync = dns.promises.lookup
dns.promises.lookup = (host, ...rest) => (LOOPBACK.has(host) ? realLookupAsync(host, ...rest) : blocked())
// Outbound loopback stays possible (fetching the doubles above); a missing
// host defaults to localhost, which cannot resolve while DNS stays blocked,
// so nothing off-loopback can be reached this way either.
function loopbackConnect(args) {
  const options = args[0] && typeof args[0] === 'object' ? args[0] : null
  const host = options ? (options.host ?? options.hostname ?? null) : typeof args[1] === 'string' ? args[1] : null
  return host === null || LOOPBACK.has(host)
}
const realSocketConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  return loopbackConnect(args) ? realSocketConnect.apply(this, args) : blocked()
}
const realNetConnect = net.connect
net.connect = (...args) => (loopbackConnect(args) ? realNetConnect(...args) : blocked())
const realCreateConnection = net.createConnection
net.createConnection = (...args) => (loopbackConnect(args) ? realCreateConnection(...args) : blocked())
http.request = blocked
http.get = blocked
https.request = blocked
https.get = blocked
tls.connect = blocked
dgram.createSocket = blocked
dns.resolve = blocked
dns.promises.resolve = blocked
// No accidental live gh/curl/provider CLI. Only Node test children and
// executables authored inside this run's synthetic scratch are allowed.
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[name]
  const check = file => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR
    if (file !== process.execPath && !(typeof file === 'string' && isAbsolute(file) && scratch &&
        resolve(file).startsWith(resolve(scratch) + sep))) blocked()
  }
  childProcess[name] = (file, ...arguments_) => {
    check(file)
    return original(file, ...arguments_)
  }
  if (original[promisify.custom]) {
    childProcess[name][promisify.custom] = (file, ...arguments_) => {
      check(file)
      return original[promisify.custom](file, ...arguments_)
    }
  }
}
childProcess.exec = blocked
childProcess.execSync = blocked
syncBuiltinESMExports()
