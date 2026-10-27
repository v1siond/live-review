// node scripts/probe.mjs [sessionId]
// Prints what the Sessions section would show, read with the compiled parsers and no VS Code: one
// block per live Claude session with "you" and every player, each with its verdict and files, then
// the session's workspace files; after the sessions, his git systems and the repo count per
// system. A session id prints only that session. Run `npm run compile` first.
import { createRequire } from 'node:module'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const out = (name) => require(path.join(import.meta.dirname, '..', 'out', 'core', name))
const { CLAUDE_PROJECTS, CLAUDE_SESSIONS, SessionIndex } = out('sessions.js')
const { SessionReader } = out('players.js')
const { RepoRootCache, repoStateLoader } = out('repoState.js')
const { readSystems, OTHER_SYSTEM, SSH_CONFIG } = out('systems.js')
const { indexRepos } = out('repoIndex.js')
const { WorkspaceScanner } = out('workspace.js')

// The extension's own default for liveReview.workspaceRoot; the probe has no VS Code settings.
const WORKSPACE_ROOT = require('../package.json').contributes.configuration.properties['liveReview.workspaceRoot'].default
// The newest workspace files printed per session; the count above them is the full list.
const WORKSPACE_SHOWN = 8

const now = Date.now()
const git = { roots: new RepoRootCache(), stateOf: repoStateLoader() }
const scanner = new WorkspaceScanner(WORKSPACE_ROOT)
const live = await new SessionIndex(CLAUDE_SESSIONS, CLAUDE_PROJECTS).listLive()
const sessions = live.filter((session) => !process.argv[2] || session.id === process.argv[2])
if (sessions.length === 0) throw new Error(`no live session${process.argv[2] ? ` ${process.argv[2]}` : ''} in ${CLAUDE_SESSIONS}`)

console.log(`live sessions: ${sessions.length}`)
const allPlayers = []
for (const session of sessions) {
  const started = Date.now()
  const read = await new SessionReader(session).read(WORKSPACE_ROOT, new Map(), git, now)
  const workspace = await scanner.filesSince(read.workspaceFolders, session.startedAt, now)
  allPlayers.push(...read.players)
  printSession(session, read, workspace, Date.now() - started)
}

const systems = await readSystems(SSH_CONFIG)
const editedRoots = [...new Set(allPlayers.flatMap((player) => player.files.map((file) => file.repo)).filter(Boolean))]
printSystems(systems, await indexRepos(editedRoots, systems))

function printSession(session, read, workspace, readMs) {
  console.log(`\n=== ${session.project}, started ${new Date(session.startedAt).toISOString()} (session ${session.id}, read in ${readMs} ms)`)
  const working = read.players.filter((player) => player.verdict.state === 'working').length
  console.log(`players: ${read.players.length} (you + ${read.players.length - 1}), working: ${working}`)
  read.players.forEach((player) => printPlayer(player, read.players))
  console.log(`  workspace folders: ${read.workspaceFolders.join(', ') || 'none'}`)
  console.log(`  workspace files since the start: ${workspace.length}`)
  workspace.slice(0, WORKSPACE_SHOWN).forEach((file) => console.log(`    ${file.relative} [${new Date(file.mtime).toISOString()}]`))
}

function printPlayer(player, players) {
  console.log(`\n  player ${player.id}: ${player.label}`)
  console.log(`    state: ${player.verdict.state}, rule: ${player.verdict.rule}`)
  console.log(`    last action: ${player.lastAction}`)
  console.log(`    last change: ${player.lastChange ? new Date(player.lastChange).toISOString() : 'none'}`)
  console.log(`    files changed: ${player.files.length}`)
  printByRepo(player.files, (file) => `[${file.status}, by ${file.how}]`)
  if (player.namedOnly.length === 0) return
  console.log(`    named in a Bash call, mtime outside every window of its calls (left out): ${player.namedOnly.length}`)
  printByRepo(player.namedOnly, (file) => writtenBy(file.file, player, players))
}

function printByRepo(files, tag) {
  const byRepo = Map.groupBy(files, (file) => file.repo ?? 'outside git')
  for (const [repo, entries] of byRepo) {
    console.log(`      ${repo}`)
    entries.forEach((file) => console.log(`        ${file.relative ?? file.file} ${tag(file)}`))
  }
}

// Without the extension's live history, a file is credited only to the player whose window holds
// its last save; when this player wrote it earlier, that earlier write shows up here.
function writtenBy(file, self, players) {
  const others = players.filter((other) => other.key !== self.key && other.files.some((credit) => credit.file === file))
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
