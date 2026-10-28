import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type GitSystem = { name: string; hostName: string }

export const OTHER_SYSTEM = 'Other'

export const SSH_CONFIG = path.join(os.homedir(), '.ssh', 'config')

const GIT_HOST = /^(github\.com|gitlab\..+|bitbucket\.org)$/i
// ssh reaches github.com with no Host block at all, so it is always one of your systems.
const DEFAULT_SYSTEM: GitSystem = { name: 'github.com', hostName: 'github.com' }

// Only the Host and HostName lines are parsed. Keys are never opened: the alias is all a
// clone's origin URL carries, and git itself applies the rest of the config when it fetches.
export async function readSystems(sshConfigPath: string): Promise<GitSystem[]> {
  const text = await fs.readFile(sshConfigPath, 'utf8').catch(() => '')
  return systemsFromConfig(text)
}

export function systemsFromConfig(text: string): GitSystem[] {
  const hostNames = new Map<string, string>()
  let block: string[] = []
  for (const line of text.split('\n')) {
    const [keyword, ...values] = line.trim().split(/\s+/)
    const key = keyword.toLowerCase()
    if (key === 'host') {
      block = values.filter((alias) => !/[*?!]/.test(alias))
      block.forEach((alias) => hostNames.set(alias, alias))
    }
    if (key === 'hostname') block.forEach((alias) => hostNames.set(alias, values[0]))
  }
  const systems = [...hostNames].filter(([, hostName]) => GIT_HOST.test(hostName)).map(([name, hostName]) => ({ name, hostName }))
  if (systems.some((system) => system.name === DEFAULT_SYSTEM.name)) return systems
  return [DEFAULT_SYSTEM, ...systems]
}

// git@alias:group/repo.git, ssh://git@alias:22/group/repo.git and https://host/group/repo.git
export function originHost(url: string): string | null {
  const scheme = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)/i)
  if (scheme) return scheme[1]
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):/)
  return scp ? scp[1] : null
}

// An alias in the URL names its system directly; a plain host falls back to the first alias
// that resolves to it.
export function systemOf(originUrl: string | null, systems: GitSystem[]): string {
  const host = originUrl ? originHost(originUrl) : null
  if (!host) return OTHER_SYSTEM
  const byAlias = systems.find((system) => system.name === host)
  if (byAlias) return byAlias.name
  const byHost = systems.find((system) => system.hostName === host)
  return byHost ? byHost.name : OTHER_SYSTEM
}
