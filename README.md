# Live Review

A VS Code panel that shows what each Claude player of the current session is changing, in the repos we pick, with a diff per file. It reads the players' own transcripts and our local clones; it sends nothing anywhere and never writes to a repo.

## What it shows

The Live Review icon in the left bar opens three sections.

**Repos.** Every clone under `~/projects` (3 levels deep), grouped by the git system its `origin` points at. The systems come from the `Host` and `HostName` lines of `~/.ssh/config`: every alias on github.com, gitlab.* or bitbucket.org, plus github.com. A clone that matches none sits under Other. Tick a repo to watch it. Per repo we see the branch, the files changed now, the commits not pushed yet and how far behind the upstream it is. A repo a player of the session edited is marked with its row and sorts first; a repo with nothing to review is greyed and sorts last. The `+` adds a folder the scan missed, the pin keeps a repo at the top of its system, the `x` takes it off the list. The picks are saved.

**Players.** One line per Claude agent of the session: its row and job from `ORCHESTRA.md`, its state (working, waiting, done) and its last action. Under it are the repos and files that player changed, and each file opens its diff. Click the player for its timeline. A finished player stays greyed until Clear.

**Changes.** Every changed file of the ticked repos, uncommitted or in an unpushed commit, tagged with the player that wrote it, or "you" when no player did. It refreshes within 5 seconds of a save.

## How it knows who changed what

A player's transcript lives at `~/.claude/projects/<cwd>/<session>/subagents/agent-<id>.jsonl`.

- A Write, Edit or MultiEdit call names its file, so that file is the player's.
- A Bash call gets the files of its repo that are dirty or inside an unpushed commit, and keeps the ones its command names whose mtime falls inside the call (from the call to its result, 1 second of slack each side). A file the call only read keeps its old mtime, so it is left out.
- While the panel runs it remembers every credit it saw, so a file stays with the player that wrote it after someone else saves it again.
- A player is working while its transcript grew in the last 10 minutes and its last message is a tool call, done once its last message is a final text, and waiting when it went quiet mid-call.

Git only runs read commands, plus `git fetch` on the Fetch button and every 10 minutes for the ticked repos. Every call passes `--no-optional-locks`, so it never takes the index lock while a player commits.

## Build and install

```bash
cd ~/projects/claude/vscode-live-review && npm install && npm run compile
npx @vscode/vsce package --allow-missing-repository
~/.vscode-server/bin/*/bin/code-server --install-extension live-review-0.1.0.vsix --force
```

Reload the VS Code window after the install. `node scripts/probe.mjs [sessionId]` prints what the panel sees for a session, from the terminal.
