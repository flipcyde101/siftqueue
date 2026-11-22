import path from 'node:path';
import { DEFAULT_PROJECTS_DIR } from './constants.js';

/**
 * Build shared D: cache environment variables rooted under <projectsDir>/.cache.
 * @param {string} [projectsDir]
 * @returns {{ NPM_CONFIG_CACHE: string, PNPM_HOME: string, UV_CACHE_DIR: string, CARGO_HOME: string }}
 */
export function buildCacheEnv(projectsDir = DEFAULT_PROJECTS_DIR) {
  const root = projectsDir || DEFAULT_PROJECTS_DIR;
  const cacheRoot = path.join(root, '.cache');
  return {
    NPM_CONFIG_CACHE: path.join(cacheRoot, 'npm'),
    PNPM_HOME: path.join(cacheRoot, 'pnpm'),
    UV_CACHE_DIR: path.join(cacheRoot, 'uv'),
    CARGO_HOME: path.join(cacheRoot, 'cargo'),
  };
}

/**
 * Build a ready-to-use agent task packet for a queued or in-progress item.
 * @param {object} item
 * @param {{ NPM_CONFIG_CACHE: string, PNPM_HOME: string, UV_CACHE_DIR: string, CARGO_HOME: string }} cacheEnv
 * @returns {object}
 */
export function buildTaskPacket(item, cacheEnv) {
  const nextStep = item.status === 'QUEUED'
    ? `siftqueue prepare ${item.item_key} --clone`
    : `Work in ${item.workspace_dir} and update status with: siftqueue update ${item.item_key} --status <STATUS>`;

  const prompt = [
    `Task Key: ${item.item_key} (id=${item.id})`,
    `Batch: ${item.batch}`,
    `Repository: ${item.owner}/${item.repo}`,
    `Issue: #${item.issue_num} (${item.issue_url})`,
    `Status: ${item.status}`,
    `Target Workspace: ${item.workspace_dir}`,
    `Cache Env:`,
    `  NPM_CONFIG_CACHE=${cacheEnv.NPM_CONFIG_CACHE}`,
    `  PNPM_HOME=${cacheEnv.PNPM_HOME}`,
    `  UV_CACHE_DIR=${cacheEnv.UV_CACHE_DIR}`,
    `  CARGO_HOME=${cacheEnv.CARGO_HOME}`,
    `Next Step: ${nextStep}`,
  ].join('\n');

  return {
    id: item.id,
    itemKey: item.item_key,
    batch: item.batch,
    owner: item.owner,
    repo: item.repo,
    issueNum: item.issue_num,
    issueUrl: item.issue_url,
    status: item.status,
    workspaceDir: item.workspace_dir,
    cacheEnv,
    nextStep,
    prompt,
  };
}
