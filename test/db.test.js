import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getNextItem,
  getStatus,
  initBatch,
  openDb,
  resolveItem,
  updateItem,
} from '../src/db.js';
import { parseIssuesFile } from '../src/parser.js';

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftqueue-db-test-'));
  const dbPath = path.join(dir, 'siftqueue.db');
  const db = openDb(dbPath);
  return { dir, dbPath, db };
}

test('openDb enables WAL mode and creates items table', () => {
  const { dir, db } = createTempDb();
  try {
    const mode = db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(mode.journal_mode).toLowerCase(), 'wal');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initBatch registers items with standardized workspace paths and skips duplicates', () => {
  const { dir, db } = createTempDb();
  const projectsDir = path.join(dir, 'projects');
  try {
    const refs = parseIssuesFile('acme/alpha#1\nhttps://github.com/acme/beta/issues/42\n');
    const first = initBatch(db, { batch: 's4', refs, projectsDir });
    assert.equal(first.added.length, 2);
    assert.equal(first.skipped.length, 0);
    assert.equal(first.added[0].item_key, 's4-01-alpha-1');
    assert.equal(first.added[0].workspace_dir, path.join(projectsDir, 's4-01-alpha-1'));
    assert.equal(first.added[0].status, 'QUEUED');
    assert.equal(first.added[1].item_key, 's4-02-beta-42');

    const moreRefs = parseIssuesFile('acme/alpha#1\nacme/gamma#7\n');
    const second = initBatch(db, { batch: 's4', refs: moreRefs, projectsDir });
    assert.equal(second.added.length, 1);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.added[0].item_key, 's4-03-gamma-7');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveItem, updateItem, getStatus, and getNextItem lifecycle', () => {
  const { dir, db } = createTempDb();
  const projectsDir = path.join(dir, 'projects');
  try {
    const refs = parseIssuesFile('acme/alpha#1\nacme/beta#2\nacme/gamma#3\n');
    initBatch(db, { batch: 'b1', refs, projectsDir });

    const byId = resolveItem(db, '1');
    const byKey = resolveItem(db, 'b1-01-alpha-1');
    const byRef = resolveItem(db, 'acme/alpha#1');
    assert.equal(byId.id, byKey.id);
    assert.equal(byKey.id, byRef.id);

    const updated = updateItem(db, 'b1-02-beta-2', {
      status: 'REPRODUCED',
      note: 'Reproduced locally',
    });
    assert.equal(updated.status, 'REPRODUCED');
    assert.equal(updated.note, 'Reproduced locally');

    // In-progress item (REPRODUCED) should be returned before QUEUED items
    const next1 = getNextItem(db, 'b1');
    assert.equal(next1.item_key, 'b1-02-beta-2');

    updateItem(db, 'b1-02-beta-2', {
      status: 'PR_OPENED',
      prUrl: 'https://github.com/acme/beta/pull/100',
    });
    updateItem(db, 'b1-01-alpha-1', { status: 'SKIPPED', note: 'Duplicate upstream' });

    const next2 = getNextItem(db, 'b1');
    assert.equal(next2.item_key, 'b1-03-gamma-3');

    const status = getStatus(db, 'b1');
    assert.equal(status.total, 3);
    assert.equal(status.counts.PR_OPENED, 1);
    assert.equal(status.counts.SKIPPED, 1);
    assert.equal(status.counts.QUEUED, 1);
    assert.equal(status.counts.REPRODUCED, 0);

    assert.throws(
      () => updateItem(db, 'b1-03-gamma-3', { status: 'INVALID' }),
      /Invalid status/
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
