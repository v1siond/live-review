// Prints what the panel would show, read with the compiled parsers and no VS Code. Run
// `npm run compile` first.
//
//   node scripts/probe.mjs [sessionId] [--projects-root <dir>] [--scan-depth <n>]
//     One block per live Claude session with "you" and every player, each with its verdict and
//     files, then the session's workspace files; after the sessions, your git systems and the repo
//     count per system. A session id prints only that session.
//
//   node scripts/probe.mjs --repo <root> [--compare <ref>] [--projects-root <dir>]
//     Reads no sessions. Line 1 is the repo's summary as the Repos section shows it, then every
//     changed path of the repo, one per line, sorted and unique. --compare compares the repo to
//     that branch, as a pick of Compare to a branch would.
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = (name) => require(path.join(root, 'out', name))
const { CLAUDE_PROJECTS, CLAUDE_SESSIONS, SessionIndex } = out('core/sessions.js')
const { SessionReader } = out('core/players.js')
const { RepoRootCache, changedPaths, repoStateLoader } = out('core/repoState.js')
const { readSystems, OTHER_SYSTEM, SSH_CONFIG } = out('core/systems.js')
const { indexRepos } = out('core/repoIndex.js')
const { WorkspaceScanner } = out('core/workspace.js')
const { expandHome } = out('core/files.js')
const { repoSummary } = out('view/labels.js')

// The extension's own setting defaults; the probe has no VS Code settings.
const settings = require('../package.json').contributes.configuration.properties
const defaultOf = (key) => String(settings[`liveReview.${key}`].default)
// The newest workspace files printed per session; the count above them is the full list.
const WORKSPACE_SHOWN = 8

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    compare: { type: 'string' },
    'projects-root': { type: 'string', default: defaultOf('projectsRoot') },
    'scan-depth': { type: 'string', default: defaultOf('scanDepth') },
  },
})
const projectsRoot = path.resolve(expandHome(options['projects-root']))
const workspaceRoot = defaultOf('workspaceRoot')

const modes = { repo: () => probeRepo(path.resolve(expandHome(options.repo)), options.compare), sessions: () => probeSessions(positionals[0]) }
await modes[options.repo ? 'repo' : 'sessions']()

// --compare is an explicit pick; without it the repo keeps the HEAD comparison.
async function probeRepo(repo, compare) {
  const stateOf = repoStateLoader(() => ({ stored: compare, fallback: '' }))
  const state = await stateOf(repo)
  const paths = [...changedPaths(state).keys()].sort()
  console.log([repoSummary(state), ...paths].join('\n'))
}

async function probeSessions(sessionId) {
  const now = Date.now()
  const git = { roots: new RepoRootCache(), stateOf: repoStateLoader(() => ({ stored: undefined, fallback: '' })), projectsRoot }
  const scanner = new WorkspaceScanner()
  const live = await new SessionIndex(CLAUDE_SESSIONS, CLAUDE_PROJECTS).listLive(projectsRoot)
  const sessions = live.filter((session) => !sessionId || session.id === sessionId)
  if (sessions.length === 0) throw new Error(`no live session${sessionId ? ` ${sessionId}` : ''} in ${CLAUDE_SESSIONS}`)

  console.log(`live sessions: ${sessions.length}`)
  const allPlayers = []
  for (const session of sessions) {
    const started = Date.now()
    const read = await new SessionReader(session).read(workspaceRoot, new Map(), git, now)
    const workspace = await scanner.filesSince(workspaceRoot, read.workspaceFolders, session.startedAt, now)
    allPlayers.push(...read.players)
    printSession(session, read, workspace, Date.now() - started)
  }

  const systems = await readSystems(SSH_CONFIG)
  const editedRoots = [...new Set(allPlayers.flatMap((player) => player.files.map((file) => file.repo)).filter(Boolean))]
  const scan = { projectsRoot, depth: Number(options['scan-depth']) }
  printSystems(systems, await indexRepos(scan, editedRoots, systems))
}

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
  for (const [repo, entries] of groupBy(files, (file) => file.repo ?? 'outside git')) {
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
  const counts = groupBy(entries, (entry) => entry.system)
  for (const name of [...systemList.map((system) => system.name), OTHER_SYSTEM]) {
    console.log(`  ${name}: ${counts.get(name)?.length ?? 0} repos`)
  }
  const scanned = entries.filter((entry) => entry.found === 'scan').length
  const added = entries.filter((entry) => entry.found === 'added')
  console.log(`total repos: ${entries.length} = ${scanned} scanned + ${added.length} edited by a player outside the scan`)
  added.forEach((entry) => console.log(`  ${entry.root}`))
}

// Map.groupBy needs Node 21; the probe runs on Node 18.
function groupBy(items, keyOf) {
  const groups = new Map()
  items.forEach((item) => groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]))
  return groups
}
