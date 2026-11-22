import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ACTIONABLE_STATUSES,
  DEFAULT_PROJECTS_DIR,
  STATUSES,
  getDefaultDbPath,
} from './constants.js';

const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Open (and initialize) the SQLite database in WAL mode.
 * @param {string} [dbPath]
 * @returns {DatabaseSync}
 */
export function openDb(dbPath = getDefaultDbPath()) {
  const resolvedPath = dbPath || getDefaultDbPath();
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch TEXT NOT NULL,
      seq INTEGER NOT NULL,
      item_key TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      short_repo TEXT NOT NULL,
      issue_num INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      projects_dir TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      pr_url TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(batch, owner, repo, issue_num)
    );
    CREATE INDEX IF NOT EXISTS idx_items_batch_status ON items(batch, status);
  `);

  return db;
}

/**
 * Validate a batch identifier.
 * @param {string} batch
 */
export function validateBatchName(batch) {
  if (!batch || !BATCH_RE.test(batch)) {
    throw new Error(
      `Invalid batch name "${batch}". Use alphanumeric characters, dots, underscores, or hyphens.`
    );
  }
}

/**
 * Validate a status value.
 * @param {string} status
 * @returns {string}
 */
export function validateStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (!STATUSES.includes(normalized)) {
    throw new Error(
      `Invalid status "${status}". Expected one of: ${STATUSES.join(', ')}.`
    );
  }
  return normalized;
}

/**
 * Register parsed issue references into a batch.
 * @param {DatabaseSync} db
 * @param {{ batch: string, refs: Array<object>, projectsDir?: string }} options
 */
export function initBatch(db, { batch, refs, projectsDir = DEFAULT_PROJECTS_DIR }) {
  validateBatchName(batch);
  const resolvedProjectsDir = projectsDir || DEFAULT_PROJECTS_DIR;

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM items WHERE batch = ?')
    .get(batch);
  let seq = Number(maxRow?.max_seq || 0);

  const checkStmt = db.prepare(
    'SELECT id, item_key FROM items WHERE batch = ? AND owner = ? AND repo = ? AND issue_num = ?'
  );
  const insertStmt = db.prepare(`
    INSERT INTO items (
      batch, seq, item_key, owner, repo, short_repo, issue_num, issue_url,
      projects_dir, workspace_dir, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)
  `);
  const getByIdStmt = db.prepare('SELECT * FROM items WHERE id = ?');

  const added = [];
  const skipped = [];
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const ref of refs) {
      const existing = checkStmt.get(batch, ref.owner, ref.repo, ref.issueNum);
      if (existing) {
        skipped.push({
          id: existing.id,
          itemKey: existing.item_key,
          canonicalRef: ref.canonicalRef,
          reason: 'already_exists',
        });
        continue;
      }

      seq += 1;
      const nn = String(seq).padStart(2, '0');
      const itemKey = `${batch}-${nn}-${ref.shortRepo}-${ref.issueNum}`;
      const workspaceDir = path.join(resolvedProjectsDir, itemKey);

      const info = insertStmt.run(
        batch,
        seq,
        itemKey,
        ref.owner,
        ref.repo,
        ref.shortRepo,
        ref.issueNum,
        ref.issueUrl,
        resolvedProjectsDir,
        workspaceDir,
        now,
        now
      );

      const inserted = getByIdStmt.get(info.lastInsertRowid);
      added.push(inserted);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    batch,
    projectsDir: resolvedProjectsDir,
    added,
    skipped,
  };
}

/**
 * Resolve an item by numeric id, item_key, or owner/repo#num.
 * @param {DatabaseSync} db
 * @param {string|number} idOrKey
 * @returns {object}
 */
export function resolveItem(db, idOrKey) {
  const raw = String(idOrKey ?? '').trim();
  if (!raw) {
    throw new Error('Item identifier is required.');
  }

  if (/^\d+$/.test(raw)) {
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(raw));
    if (!row) {
      throw new Error(`Item not found for id: ${raw}`);
    }
    return row;
  }

  const byKey = db.prepare('SELECT * FROM items WHERE item_key = ?').get(raw);
  if (byKey) {
    return byKey;
  }

  const refMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(raw);
  if (refMatch) {
    const [, owner, repo, numStr] = refMatch;
    const rows = db
      .prepare('SELECT * FROM items WHERE owner = ? AND repo = ? AND issue_num = ?')
      .all(owner, repo, Number.parseInt(numStr, 10));
    if (rows.length === 1) {
      return rows[0];
    }
    if (rows.length > 1) {
      const keys = rows.map((r) => r.item_key).join(', ');
      throw new Error(`Ambiguous issue reference "${raw}". Matches: ${keys}`);
    }
  }

  throw new Error(`Item not found: ${raw}`);
}

/**
 * Get summary counts and items, optionally filtered by batch.
 * @param {DatabaseSync} db
 * @param {string} [batch]
 */
export function getStatus(db, batch) {
  const rows = batch
    ? db
        .prepare('SELECT * FROM items WHERE batch = ? ORDER BY seq ASC, id ASC')
        .all(batch)
    : db
        .prepare('SELECT * FROM items ORDER BY batch ASC, seq ASC, id ASC')
        .all();

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of rows) {
    if (Object.hasOwn(counts, row.status)) {
      counts[row.status] += 1;
    }
  }

  return {
    batch: batch || null,
    total: rows.length,
    counts,
    items: rows,
  };
}

/**
 * Update an item's status, PR URL, and/or note.
 * @param {DatabaseSync} db
 * @param {string|number} idOrKey
 * @param {{ status?: string, prUrl?: string, note?: string }} updates
 */
export function updateItem(db, idOrKey, updates) {
  const item = resolveItem(db, idOrKey);
  const nextStatus = updates.status !== undefined
    ? validateStatus(updates.status)
    : item.status;
  const nextPrUrl = updates.prUrl !== undefined ? updates.prUrl : item.pr_url;
  const nextNote = updates.note !== undefined ? updates.note : item.note;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE items
    SET status = ?, pr_url = ?, note = ?, updated_at = ?
    WHERE id = ?
  `).run(nextStatus, nextPrUrl, nextNote, now, item.id);

  return db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
}

/**
 * Return the next actionable item (in-progress first, then QUEUED), optionally filtered by batch.
 * @param {DatabaseSync} db
 * @param {string} [batch]
 * @returns {object|null}
 */
export function getNextItem(db, batch) {
  const placeholders = ACTIONABLE_STATUSES.map(() => '?').join(', ');
  const sql = batch
    ? `
      SELECT * FROM items
      WHERE batch = ? AND status IN (${placeholders})
      ORDER BY CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END ASC, seq ASC, id ASC
      LIMIT 1
    `
    : `
      SELECT * FROM items
      WHERE status IN (${placeholders})
      ORDER BY CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END ASC, id ASC
      LIMIT 1
    `;

  const params = batch ? [batch, ...ACTIONABLE_STATUSES] : [...ACTIONABLE_STATUSES];
  const row = db.prepare(sql).get(...params);
  return row || null;
}
