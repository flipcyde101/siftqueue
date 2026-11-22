import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeStreamCapture() {
  let buffer = '';
  return {
    stream: {
      write(chunk) {
        buffer += String(chunk);
      },
    },
    read() {
      return buffer;
    },
  };
}

function invoke(argv, runner) {
  const out = makeStreamCapture();
  const err = makeStreamCapture();
  const code = runCli(argv, {
    stdout: out.stream,
    stderr: err.stream,
    runner,
  });
  return { code, stdout: out.read(), stderr: err.read() };
}

test('CLI --help and --version work', () => {
  const help = invoke(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /siftqueue/);

  const ver = invoke(['--version']);
  assert.equal(ver.code, 0);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI end-to-end workflow with temp DB, temp issues file, and mocked gh runner', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftqueue-cli-test-'));
  const dbPath = path.join(tmpDir, 'queue.db');
  const projectsDir = path.join(tmpDir, 'projects');
  const issuesFile = path.join(tmpDir, 'issues.txt');
  fs.writeFileSync(
    issuesFile,
    '# sample batch\nhttps://github.com/acme/foo/issues/11\nacme/bar#22\n',
    'utf8'
  );

  const mockRunner = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({
          number: Number(args[2]),
          title: `Issue ${args[2]}`,
          body: 'Body text',
          url: `https://github.com/${args[4]}/issues/${args[2]}`,
          state: 'OPEN',
          labels: [],
          author: { login: 'tester' },
        }),
        stderr: '',
        status: 0,
      };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      fs.mkdirSync(path.join(args[3], '.git'), { recursive: true });
      return { stdout: '', stderr: '', status: 0 };
    }
    throw new Error(`Unexpected runner call: ${cmd} ${args.join(' ')}`);
  };

  try {
    const initRes = invoke([
      'init',
      's4',
      issuesFile,
      '--projects-dir',
      projectsDir,
      '--db',
      dbPath,
      '--json',
    ]);
    assert.equal(initRes.code, 0);
    const initJson = JSON.parse(initRes.stdout);
    assert.equal(initJson.ok, true);
    assert.equal(initJson.added.length, 2);

    const statusRes = invoke(['status', 's4', '--db', dbPath, '--json']);
    assert.equal(statusRes.code, 0);
    const statusJson = JSON.parse(statusRes.stdout);
    assert.equal(statusJson.total, 2);
    assert.equal(statusJson.counts.QUEUED, 2);

    const nextRes = invoke(['next', 's4', '--db', dbPath, '--json']);
    assert.equal(nextRes.code, 0);
    const nextJson = JSON.parse(nextRes.stdout);
    assert.equal(nextJson.item.item_key, 's4-01-foo-11');
    assert.equal(nextJson.cacheEnv.NPM_CONFIG_CACHE, path.join(projectsDir, '.cache', 'npm'));
    assert.equal(nextJson.cacheEnv.PNPM_HOME, path.join(projectsDir, '.cache', 'pnpm'));
    assert.equal(nextJson.cacheEnv.UV_CACHE_DIR, path.join(projectsDir, '.cache', 'uv'));
    assert.equal(nextJson.cacheEnv.CARGO_HOME, path.join(projectsDir, '.cache', 'cargo'));
    assert.match(nextJson.packet.prompt, /Task Key: s4-01-foo-11/);

    const prepRes = invoke(['prepare', 's4-01-foo-11', '--clone', '--db', dbPath, '--json'], mockRunner);
    assert.equal(prepRes.code, 0);
    const prepJson = JSON.parse(prepRes.stdout);
    assert.equal(prepJson.cloned, true);
    assert.equal(prepJson.item.status, 'CLONED');

    const updRes = invoke([
      'update',
      's4-01-foo-11',
      '--status',
      'PR_OPENED',
      '--pr',
      'https://github.com/acme/foo/pull/99',
      '--note',
      'Fixed',
      '--db',
      dbPath,
      '--json',
    ]);
    assert.equal(updRes.code, 0);
    const updJson = JSON.parse(updRes.stdout);
    assert.equal(updJson.item.status, 'PR_OPENED');
    assert.equal(updJson.item.pr_url, 'https://github.com/acme/foo/pull/99');

    const nextRes2 = invoke(['next', 's4', '--db', dbPath, '--json']);
    assert.equal(nextRes2.code, 0);
    assert.equal(JSON.parse(nextRes2.stdout).item.item_key, 's4-02-bar-22');

    invoke(['update', 's4-02-bar-22', '--status', 'SKIPPED', '--db', dbPath]);
    const nextEmpty = invoke(['next', 's4', '--db', dbPath, '--json']);
    assert.equal(nextEmpty.code, 0);
    assert.equal(JSON.parse(nextEmpty.stdout).item, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('repository contains zero em dashes (U+2014)', () => {
  const filesToCheck = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        filesToCheck.push(fullPath);
      }
    }
  }
  walk(ROOT_DIR);

  for (const filePath of filesToCheck) {
    const content = fs.readFileSync(filePath, 'utf8');
    assert.equal(
      content.includes('\u2014'),
      false,
      `Found em dash (U+2014) in ${path.relative(ROOT_DIR, filePath)}`
    );
  }
});
