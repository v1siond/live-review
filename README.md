# Live Review

A VS Code panel that shows every Claude session running on this machine, what each of its players is changing, with a diff per file, and the notes each session writes in the workspace folder, beside the repos we pick. It reads the players' own transcripts and our local clones; it sends nothing anywhere and never writes to a repo.

## What it shows

The Live Review icon in the left bar opens three sections. Each section has a Collapse All button in its title bar that folds only that section.

**Repos.** Every clone under `~/projects` (3 levels deep), grouped by the git system its `origin` points at. The systems come from the `Host` and `HostName` lines of `~/.ssh/config`: every alias on github.com, gitlab.* or bitbucket.org, plus github.com. A clone that matches none sits under Other. Tick a repo to watch it. Per repo we see the branch, the files changed now, the commits not pushed yet and how far behind the upstream it is. A repo a player of a listed session edited is marked with its row and sorts first; a repo with nothing to review is greyed and sorts last. The `+` adds a folder the scan missed, the pin keeps a repo at the top of its system, the `x` takes it off the list. The picks are saved.

**Sessions.** One node per Claude session running now, in any project, newest first, named by its project and start time ("game-engine, 00:31"). Under it:

- "you", the session's own agent, then one line per player: its row and job from the `ORCHESTRA.md` of the session's workspace folder, its state (working, waiting, done) and its last action. Under each are the repos and files it changed, and each file opens its diff. Click a player for its timeline.
- **Workspace files**: every file saved since the session started in its folder under `~/projects/REDACTED/.claude-workspace` (the folders its Write and Edit calls touched there), newest first, each opening the file.

A finished player stays, greyed, through every refresh. The `x` on a player removes it, "Clear finished" on a session removes its finished players, and the `x` on a session removes it with all its players. What we remove stays removed, across reloads, until that player edits a file again. A session whose process ended stays listed until we remove it or reload the window. Every node keeps its id between refreshes, so what we expanded stays expanded.

**Changes.** Every changed file of the ticked repos, uncommitted or in an unpushed commit, tagged with the player that wrote it ("you, game-engine" for a session's own agent), or "by hand" when no transcript of a listed session did. It refreshes within 5 seconds of a save.

## How it knows who changed what

The running sessions come from Claude Code's own registry, `~/.claude/sessions/<pid>.json`: an entry counts while its process runs (the pid is alive with the start time the entry recorded) and it is a terminal session (`kind` interactive, `entrypoint` cli). Headless `claude -p` runs and background jobs are left out. A session's own transcript is `~/.claude/projects/<cwd>/<session>.jsonl`, and a player's is `~/.claude/projects/<cwd>/<session>/subagents/agent-<id>.jsonl`. Both are read in 8 MB steps and then only from where the last read stopped.

- A Write, Edit or MultiEdit call names its file, so that file is the player's.
- A Bash call gets the files of its repo that are dirty or inside an unpushed commit, and keeps the ones its command names whose mtime falls inside the call (from the call to its result, 1 second of slack each side). A file the call only read keeps its old mtime, so it is left out.
- While the panel runs it remembers every credit it saw, so a file stays with the player that wrote it after someone else saves it again.
- A player is working while its transcript grew in the last 10 minutes and its last message is a tool call, done once its last message is a final text, and waiting when it went quiet mid-call.

Git only runs read commands, plus `git fetch` on the Fetch button and every 10 minutes for the ticked repos. Every call passes `--no-optional-locks`, so it never takes the index lock while a player commits.

## Build and install

```bash
cd ~/projects/claude/vscode-live-review && npm install && npm run compile
npx @vscode/vsce package --allow-missing-repository
~/.vscode-server/bin/*/bin/code-server --install-extension live-review-0.2.1.vsix --force
```

Reload the VS Code window after the install. `node scripts/probe.mjs [sessionId]` prints what the Sessions section sees, one block per running session (or only the one named), from the terminal.
