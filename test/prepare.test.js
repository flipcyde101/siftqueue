import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBatch, openDb } from '../src/db.js';
import { parseIssuesFile } from '../src/parser.js';
import { prepareItem } from '../src/prepare.js';

function setupWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftqueue-prepare-test-'));
  const db = openDb(path.join(dir, 'siftqueue.db'));
  const projectsDir = path.join(dir, 'projects');
  const refs = parseIssuesFile('acme/widget#42\n');
  initBatch(db, { batch: 's4', refs, projectsDir });
  return { dir, db, projectsDir };
}

test('prepareItem fetches metadata and writes brief without cloning when clone=false', () => {
  const { dir, db } = setupWorkspace();
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({
          number: 42,
          title: 'Fix widget crash',
          body: 'Steps to reproduce...',
          url: 'https://github.com/acme/widget/issues/42',
          state: 'OPEN',
          labels: [{ name: 'bug' }],
          author: { login: 'octocat' },
        }),
        stderr: '',
        status: 0,
      };
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };

  try {
    const res = prepareItem(db, 's4-01-widget-42', { clone: false, runner: mockRunner });
    assert.equal(calls.length, 1);
    assert.equal(res.cloned, false);
    assert.equal(res.item.status, 'QUEUED');
    assert.ok(fs.existsSync(res.issueJsonPath));
    assert.ok(fs.existsSync(res.briefPath));

    const savedJson = JSON.parse(fs.readFileSync(res.issueJsonPath, 'utf8'));
    assert.equal(savedJson.issue.title, 'Fix widget crash');
    assert.equal(savedJson.queue.itemKey, 's4-01-widget-42');

    const brief = fs.readFileSync(res.briefPath, 'utf8');
    assert.match(brief, /Fix widget crash/);
    assert.match(brief, /NPM_CONFIG_CACHE/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareItem clones repository and updates status to CLONED when clone=true', () => {
  const { dir, db } = setupWorkspace();
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({
          number: 42,
          title: 'Fix widget crash',
          body: 'Details',
          url: 'https://github.com/acme/widget/issues/42',
          state: 'OPEN',
          labels: [],
          author: { login: 'octocat' },
        }),
        stderr: '',
        status: 0,
      };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      const targetDir = args[3];
      fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true });
      return { stdout: 'Cloning...', stderr: '', status: 0 };
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };

  try {
    const res = prepareItem(db, 's4-01-widget-42', { clone: true, runner: mockRunner });
    assert.equal(calls.length, 2);
    assert.equal(res.cloned, true);
    assert.equal(res.item.status, 'CLONED');
    assert.ok(fs.existsSync(path.join(res.item.workspace_dir, '.git')));
    assert.ok(fs.existsSync(res.issueJsonPath));
    assert.ok(fs.existsSync(res.briefPath));

    // Running prepare --clone again skips re-cloning when .git exists
    const res2 = prepareItem(db, 's4-01-widget-42', { clone: true, runner: mockRunner });
    assert.equal(calls.length, 3);
    assert.equal(res2.cloned, false);
    assert.equal(res2.alreadyCloned, true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
