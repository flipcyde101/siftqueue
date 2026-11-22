import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const STATUSES = Object.freeze([
  'QUEUED',
  'CLONED',
  'REPRODUCED',
  'FIXED',
  'VERIFIED',
  'PR_OPENED',
  'SKIPPED',
]);

export const ACTIONABLE_STATUSES = Object.freeze([
  'QUEUED',
  'CLONED',
  'REPRODUCED',
  'FIXED',
  'VERIFIED',
]);

export const TERMINAL_STATUSES = Object.freeze([
  'PR_OPENED',
  'SKIPPED',
]);

export const DEFAULT_PROJECTS_DIR = 'D:\\Codex\\Projects';

export function getDefaultDbPath() {
  if (process.env.SIFTQUEUE_DB && process.env.SIFTQUEUE_DB.trim()) {
    return process.env.SIFTQUEUE_DB.trim();
  }
  return path.join(os.homedir(), '.siftqueue', 'siftqueue.db');
}
