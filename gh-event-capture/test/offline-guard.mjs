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
globalThis.fetch = async () => blocked()
net.Socket.prototype.connect = blocked
net.Server.prototype.listen = blocked
net.connect = blocked
net.createConnection = blocked
http.request = blocked
http.get = blocked
https.request = blocked
https.get = blocked
tls.connect = blocked
dgram.createSocket = blocked
dns.lookup = blocked
dns.resolve = blocked
dns.promises.lookup = blocked
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
