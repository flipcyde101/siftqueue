import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROJECTS_DIR,
  STATUSES,
  VERSION,
  getDefaultDbPath,
} from './constants.js';
import {
  getNextItem,
  getStatus,
  initBatch,
  openDb,
  updateItem,
} from './db.js';
import { buildCacheEnv, buildTaskPacket } from './env.js';
import { parseIssuesFile } from './parser.js';
import { prepareItem } from './prepare.js';
import { defaultRunner } from './runner.js';

const HELP_TEXT = `siftqueue v${VERSION}
Local SQLite-backed batch queue for triaging, cloning, and tracking GitHub issue fixes.

Usage:
  siftqueue <command> [options]

Commands:
  init <batch> <issuesFile> [--projects-dir <dir>] [--json]
      Parse an issues file (GitHub URLs or owner/repo#num) and register items as QUEUED.

  status [batch] [--json]
      Show summary counts and item table (optionally filtered by batch).

  update <idOrKey> --status <STATUS> [--pr <url>] [--note <text>] [--json]
      Update an item status (${STATUSES.join(', ')}) and optional PR URL or note.

  next [batch] [--json]
      Return the next actionable item, target workspace, D: cache env vars, and task packet.

  prepare <idOrKey> [--clone] [--json]
      Fetch issue metadata via gh issue view, write .siftqueue-issue.json and .siftqueue-brief.md,
      and optionally clone via gh repo clone when --clone is passed.

Global Options:
  --db <path>       Override SQLite DB path (default: $SIFTQUEUE_DB or ~/.siftqueue/siftqueue.db)
  --json            Output machine-readable JSON
  -h, --help        Show this help message
  -v, --version     Show version
`;

/**
 * Parse CLI arguments into global flags, command, positionals, and command options.
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const positionals = [];
  const flags = {
    json: false,
    help: false,
    version: false,
    clone: false,
    db: undefined,
    projectsDir: undefined,
    status: undefined,
    pr: undefined,
    note: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '--clone') {
      flags.clone = true;
    } else if (arg === '--db' || arg.startsWith('--db=')) {
      flags.db = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (flags.db === undefined) throw new Error('Missing value for --db');
    } else if (arg === '--projects-dir' || arg.startsWith('--projects-dir=')) {
      flags.projectsDir = arg.includes('=')
        ? arg.slice(arg.indexOf('=') + 1)
        : argv[++i];
      if (flags.projectsDir === undefined) throw new Error('Missing value for --projects-dir');
    } else if (arg === '--status' || arg.startsWith('--status=')) {
      flags.status = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (flags.status === undefined) throw new Error('Missing value for --status');
    } else if (arg === '--pr' || arg.startsWith('--pr=')) {
      flags.pr = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (flags.pr === undefined) throw new Error('Missing value for --pr');
    } else if (arg === '--note' || arg.startsWith('--note=')) {
      flags.note = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (flags.note === undefined) throw new Error('Missing value for --note');
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: positionals[0] || null,
    args: positionals.slice(1),
    flags,
  };
}

function formatTable(items) {
  if (items.length === 0) {
    return 'No items found.';
  }
  const headers = ['ID', 'KEY', 'STATUS', 'ISSUE', 'WORKSPACE'];
  const rows = items.map((item) => [
    String(item.id),
    item.item_key,
    item.status,
    `${item.owner}/${item.repo}#${item.issue_num}`,
    item.workspace_dir,
  ]);
  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...rows.map((r) => r[idx].length))
  );
  const formatRow = (cols) =>
    cols.map((col, idx) => col.padEnd(widths[idx])).join('  ');

  return [
    formatRow(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(formatRow),
  ].join('\n');
}

/**
 * Run the siftqueue CLI.
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, runner?: Function }} [io]
 * @returns {number}
 */
export function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const runner = io.runner || defaultRunner;

  const writeOut = (text) => stdout.write(`${text}\n`);
  const writeErr = (text) => stderr.write(`${text}\n`);

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    writeErr(`Error: ${err.message}`);
    return 1;
  }

  const { command, args, flags } = parsed;

  if (flags.version) {
    writeOut(flags.json ? JSON.stringify({ version: VERSION }) : VERSION);
    return 0;
  }

  if (flags.help || !command) {
    writeOut(HELP_TEXT.trimEnd());
    return 0;
  }

  const dbPath = flags.db || getDefaultDbPath();
  let db;
  try {
    db = openDb(dbPath);

    switch (command) {
      case 'init': {
        const [batch, issuesFile] = args;
        if (!batch || !issuesFile) {
          throw new Error('Usage: siftqueue init <batch> <issuesFile> [--projects-dir <dir>] [--json]');
        }
        const resolvedIssuesFile = path.resolve(issuesFile);
        if (!fs.existsSync(resolvedIssuesFile)) {
          throw new Error(`Issues file not found: ${resolvedIssuesFile}`);
        }
        const content = fs.readFileSync(resolvedIssuesFile, 'utf8');
        const refs = parseIssuesFile(content);
        if (refs.length === 0) {
          throw new Error(`No valid issue references found in ${resolvedIssuesFile}`);
        }
        const projectsDir = flags.projectsDir || DEFAULT_PROJECTS_DIR;
        const result = initBatch(db, { batch, refs, projectsDir });

        if (flags.json) {
          writeOut(JSON.stringify({ ok: true, dbPath, ...result }, null, 2));
        } else {
          writeOut(
            `Batch "${result.batch}": added ${result.added.length}, skipped ${result.skipped.length} (projectsDir: ${result.projectsDir})`
          );
          if (result.added.length > 0) {
            writeOut(formatTable(result.added));
          }
        }
        return 0;
      }

      case 'status': {
        const [batch] = args;
        const result = getStatus(db, batch);
        if (flags.json) {
          writeOut(JSON.stringify({ ok: true, dbPath, ...result }, null, 2));
        } else {
          const scope = result.batch ? `batch "${result.batch}"` : 'all batches';
          const summary = STATUSES.map((s) => `${s}=${result.counts[s]}`).join(' ');
          writeOut(`Status (${scope}, total=${result.total}): ${summary}`);
          writeOut(formatTable(result.items));
        }
        return 0;
      }

      case 'update': {
        const [idOrKey] = args;
        if (!idOrKey) {
          throw new Error('Usage: siftqueue update <idOrKey> --status <STATUS> [--pr <url>] [--note <text>] [--json]');
        }
        if (flags.status === undefined && flags.pr === undefined && flags.note === undefined) {
          throw new Error('Specify at least --status, --pr, or --note.');
        }
        const updated = updateItem(db, idOrKey, {
          status: flags.status,
          prUrl: flags.pr,
          note: flags.note,
        });
        if (flags.json) {
          writeOut(JSON.stringify({ ok: true, item: updated }, null, 2));
        } else {
          writeOut(`Updated ${updated.item_key} (id=${updated.id}) -> ${updated.status}`);
          if (updated.pr_url) writeOut(`  PR: ${updated.pr_url}`);
          if (updated.note) writeOut(`  Note: ${updated.note}`);
        }
        return 0;
      }

      case 'next': {
        const [batch] = args;
        const item = getNextItem(db, batch);
        if (!item) {
          if (flags.json) {
            writeOut(JSON.stringify({ ok: true, item: null, packet: null }, null, 2));
          } else {
            writeOut(batch ? `No actionable items in batch "${batch}".` : 'No actionable items in queue.');
          }
          return 0;
        }
        const cacheEnv = buildCacheEnv(item.projects_dir);
        const packet = buildTaskPacket(item, cacheEnv);
        if (flags.json) {
          writeOut(JSON.stringify({ ok: true, item, cacheEnv, packet }, null, 2));
        } else {
          writeOut(packet.prompt);
        }
        return 0;
      }

      case 'prepare': {
        const [idOrKey] = args;
        if (!idOrKey) {
          throw new Error('Usage: siftqueue prepare <idOrKey> [--clone] [--json]');
        }
        const result = prepareItem(db, idOrKey, {
          clone: flags.clone,
          runner,
        });
        if (flags.json) {
          writeOut(JSON.stringify({ ok: true, ...result }, null, 2));
        } else {
          writeOut(`Prepared ${result.item.item_key} (status=${result.item.status})`);
          writeOut(`  Workspace: ${result.item.workspace_dir}`);
          writeOut(`  Issue JSON: ${result.issueJsonPath}`);
          writeOut(`  Brief: ${result.briefPath}`);
          if (flags.clone) {
            writeOut(`  Clone: ${result.cloned ? 'cloned' : 'already present'}`);
          }
        }
        return 0;
      }

      default:
        throw new Error(`Unknown command: ${command}. Run "siftqueue --help" for usage.`);
    }
  } catch (err) {
    if (flags.json) {
      writeOut(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      writeErr(`Error: ${err.message}`);
    }
    return 1;
  } finally {
    if (db) {
      db.close();
    }
  }
}
