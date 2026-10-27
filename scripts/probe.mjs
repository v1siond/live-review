// node scripts/probe.mjs [sessionId]
// Prints what the panel would show for one Claude session, read with the compiled parsers and
// no VS Code: every player with its verdict and files, the files it only named, his git systems
// and the repo count per system. Run `npm run compile` first.
import { createRequire } from 'node:module'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const out = (name) => require(path.join(import.meta.dirname, '..', 'out', 'core', name))
const { CLAUDE_PROJECTS, listCurrentSessions, findSession } = out('sessions.js')
const { SessionReader } = out('players.js')
const { RepoRootCache, repoStateLoader } = out('repoState.js')
const { readRecords } = out('orchestra.js')
const { readSystems, OTHER_SYSTEM, SSH_CONFIG } = out('systems.js')
const { indexRepos } = out('repoIndex.js')

// The extension's own default for liveReview.recordFiles; the probe has no VS Code settings.
const RECORD_FILES = require('../package.json').contributes.configuration.properties['liveReview.recordFiles'].default

const session = await pickSession(process.argv[2])
const now = Date.now()
const git = { roots: new RepoRootCache(), stateOf: repoStateLoader() }
const players = await new SessionReader(session).readPlayers(await readRecords(RECORD_FILES), new Map(), git, now)

console.log(`session ${session.id} (${session.project}), last write ${new Date(session.lastWrite).toISOString()}`)
console.log(`players: ${players.length}, active: ${players.filter((player) => player.verdict.active).length}`)
players.sort((a, b) => a.id.localeCompare(b.id)).forEach(printPlayer)

const systems = await readSystems(SSH_CONFIG)
const editedRoots = [...new Set(players.flatMap((player) => player.files.map((file) => file.repo)).filter(Boolean))]
const repos = await indexRepos(editedRoots, systems)
printSystems(systems, repos)

async function pickSession(id) {
  if (id) {
    const found = await findSession(CLAUDE_PROJECTS, id)
    if (!found) throw new Error(`no session ${id} with players under ${CLAUDE_PROJECTS}`)
    return found
  }
  const [newest] = await listCurrentSessions(CLAUDE_PROJECTS)
  if (!newest) throw new Error(`no session with players under ${CLAUDE_PROJECTS}`)
  return newest
}

function printPlayer(player) {
  console.log(`\nagent ${player.id}`)
  console.log(`  description: ${player.description}`)
  console.log(`  label: ${player.label}`)
  console.log(`  active: ${player.verdict.active ? 'yes' : 'no'} (${player.verdict.state}), rule: ${player.verdict.rule}`)
  console.log(`  last action: ${player.lastAction}`)
  console.log(`  files changed: ${player.files.length}`)
  printByRepo(player.files, (file) => `[${file.status}, by ${file.how}]`)
  if (player.namedOnly.length === 0) return
  console.log(`  named in a Bash call, mtime outside every window of its calls (left out): ${player.namedOnly.length}`)
  printByRepo(player.namedOnly, (file) => writtenBy(file.file, player.id))
}

function printByRepo(files, tag) {
  const byRepo = Map.groupBy(files, (file) => file.repo ?? 'outside git')
  for (const [repo, entries] of byRepo) {
    console.log(`    ${repo}`)
    entries.forEach((file) => console.log(`      ${file.relative ?? file.file} ${tag(file)}`))
  }
}

// Without the extension's live history, a file is credited only to the player whose window holds
// its last save; when this player wrote it earlier, that earlier write shows up here.
function writtenBy(file, selfId) {
  const others = players.filter((other) => other.id !== selfId && other.files.some((credit) => credit.file === file))
  if (others.length === 0) return ''
  return `[last saved inside a call window of ${others.map((other) => other.id).join(', ')}]`
}

function printSystems(systemList, entries) {
  console.log(`\nsystems: ${systemList.length}`)
  const counts = Map.groupBy(entries, (entry) => entry.system)
  for (const name of [...systemList.map((system) => system.name), OTHER_SYSTEM]) {
    console.log(`  ${name}: ${counts.get(name)?.length ?? 0} repos`)
  }
  const scanned = entries.filter((entry) => entry.found === 'scan').length
  const added = entries.filter((entry) => entry.found === 'added')
  console.log(`total repos: ${entries.length} = ${scanned} scanned + ${added.length} edited by a player outside the scan`)
  added.forEach((entry) => console.log(`  ${entry.root}`))
}
