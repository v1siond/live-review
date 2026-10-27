import { execFile } from 'node:child_process'

export type GitResult = { ok: true; stdout: string } | { ok: false; error: string }

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

// The one door to git for the whole extension and the probe. --no-optional-locks keeps
// read commands such as status from taking .git/index.lock while a player commits in the
// same repo, and execFile passes arguments without a shell, so no path is ever parsed as code.
// GIT_TERMINAL_PROMPT=0 makes a fetch that needs a password fail instead of hanging.
export function runGit(cwd: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitResult> {
  const options = {
    cwd,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', ...args], options, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: String(stderr).trim() || error.message })
      resolve({ ok: true, stdout: String(stdout) })
    })
  })
}
