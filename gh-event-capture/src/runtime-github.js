// The installed wrapper lives beside the private consumer configuration. Never
// resolve the executable through PATH: a service override must not replace it.
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function approvedGithub(configFile) {
  const secure = dirname(configFile)
  for (const directory of [secure, join(secure, 'bin')]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) ||
      await realpath(directory) !== directory) throw new Error('unsafe gh directory')
  }
  const path = join(secure, 'bin', 'gh')
  const wrapper = await lstat(path)
  if (!wrapper.isFile() || wrapper.uid !== process.getuid() || (wrapper.mode & 0o077) ||
    !(wrapper.mode & 0o100)) throw new Error('unsafe gh wrapper')
  return path
}
