import { execFileSync } from 'node:child_process';

/**
 * Default synchronous command runner for gh and git.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
export function defaultRunner(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: stdout || '', stderr: '', status: 0 };
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : err.message;
    const stdout = err.stdout ? String(err.stdout) : '';
    const wrapped = new Error(`Command failed: ${command} ${args.join(' ')}\n${stderr}`.trim());
    wrapped.status = typeof err.status === 'number' ? err.status : 1;
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    throw wrapped;
  }
}
