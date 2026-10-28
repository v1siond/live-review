# Changelog

## 0.3.1

- Security: every git call runs with `core.fsmonitor`, `diff.external` and `core.hooksPath` turned off from the command line, and the diff with `--no-ext-diff`, so a repo under the projects folder whose `.git/config` someone else wrote no longer runs a command when the panel starts and reads it.
- Security: `liveReview.projectsRoot`, `liveReview.scanDepth`, `liveReview.workspaceRoot` and `liveReview.defaultCompareBranch` are machine settings, so a cloned repo's `.vscode/settings.json` can no longer point the scan at another folder; `scanDepth` stops at 6, and the extension does not run in Restricted Mode.
- Build: `@azure/msal-node`, pulled in by `@vscode/vsce` for publishing, is pinned to 7.1.0 through `overrides` (GHSA-xcx6-jx8p-x3h5), and `npm audit` finds 0 vulnerabilities. The extension itself ships no dependency.
- Package: the README screenshot (`media/*.png`) stays out of the vsix; the README on GitHub shows it.
- README: a screenshot of the panel on a demo repo, a check per requirement, where to install the extension and where `~/.claude` must be on Linux, WSL, macOS and Windows, a First run walk through with a Check it works list, and Troubleshooting rows for a missing git, an empty or wrong projects folder, a repo under Other, Remote SSH and dev containers.
- README: building from source needs Node.js 22 (what `@vscode/vsce` 4 asks for), and the Workspace files node is listed on every session.

## 0.3.0

Upgrading from 0.2.x: the publisher is now `v1siond`, so VS Code installs 0.3.0 as a new extension with empty saved state. Re-tick your repos after upgrading from 0.2.x (and pin them again), then uninstall the 0.2.x Live Review from the Extensions view (`code --list-extensions | grep live-review` shows both ids).

- Compare to a branch: a new icon on each repo in Repos opens a pick of HEAD, the default, your local branches and your remote branches. With a branch picked, the repo shows every file changed since the merge base with that branch (committed or not), the commits ahead of it, and ahead and behind counts; every diff opens against the merge base.
- New setting `liveReview.defaultCompareBranch`: the branch every repo without a pick of its own is compared to, in the repos where it exists.
- New settings `liveReview.projectsRoot` (default `~/projects`) and `liveReview.scanDepth` (default 3) for where the clones are scanned.
- `liveReview.workspaceRoot` is empty by default; Workspace files and rows per player turn on when you set it.
- Settings apply at once, without a reload.
- The probe takes `--repo <root>`, `--compare <ref>`, `--projects-root <dir>` and `--scan-depth <n>`.
- MIT license, its own repository, and a full README.

## 0.2.1

- A Collapse All button in the title bar of each section, folding only that section.

## 0.2.0

- Sessions lists every Claude Code session running on the machine, in any folder, newest first, with "you" (the session's own agent) and each player.
- What you remove (a player, a session, the finished players of a session) stays removed across reloads until that player edits a file again.
- Workspace files: the files each session saved in its notes folder since it started.

## 0.1.0

- First release: a Live Review panel in VS Code with Repos, Players and Changes.
- Repos lists every local clone grouped by the git system its origin points at, read from `~/.ssh/config`, with checkboxes to pick the repos to watch, pins, and a button to add a folder.
- Players shows each agent of the session, its row and job, its state and its last action, the files it changed with a diff per file, and its timeline on click.
- Changes lists every changed file of the picked repos, tagged with the player that wrote it.
