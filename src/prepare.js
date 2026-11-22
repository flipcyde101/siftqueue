import fs from 'node:fs';
import path from 'node:path';
import { resolveItem, updateItem } from './db.js';
import { buildCacheEnv } from './env.js';
import { defaultRunner } from './runner.js';

const ISSUE_JSON_FIELDS = 'number,title,body,url,state,labels,author,createdAt,updatedAt';

/**
 * Fetch GitHub issue metadata, optionally clone the repo, and write brief files.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|number} idOrKey
 * @param {{ clone?: boolean, runner?: Function }} [options]
 */
export function prepareItem(db, idOrKey, options = {}) {
  const { clone = false, runner = defaultRunner } = options;
  let item = resolveItem(db, idOrKey);
  const repoSlug = `${item.owner}/${item.repo}`;

  const viewResult = runner('gh', [
    'issue',
    'view',
    String(item.issue_num),
    '--repo',
    repoSlug,
    '--json',
    ISSUE_JSON_FIELDS,
  ]);

  let issueMeta;
  try {
    issueMeta = JSON.parse(viewResult.stdout || '{}');
  } catch (err) {
    throw new Error(`Failed to parse gh issue view JSON output: ${err.message}`);
  }

  let cloned = false;
  let alreadyCloned = false;

  if (clone) {
    const gitDir = path.join(item.workspace_dir, '.git');
    if (fs.existsSync(gitDir)) {
      alreadyCloned = true;
    } else {
      fs.mkdirSync(path.dirname(item.workspace_dir), { recursive: true });
      runner('gh', ['repo', 'clone', repoSlug, item.workspace_dir]);
      cloned = true;
    }

    if (item.status === 'QUEUED') {
      item = updateItem(db, item.id, { status: 'CLONED' });
    }
  }

  fs.mkdirSync(item.workspace_dir, { recursive: true });

  const cacheEnv = buildCacheEnv(item.projects_dir);
  const issueJsonPath = path.join(item.workspace_dir, '.siftqueue-issue.json');
  const briefPath = path.join(item.workspace_dir, '.siftqueue-brief.md');

  const issuePayload = {
    queue: {
      id: item.id,
      itemKey: item.item_key,
      batch: item.batch,
      owner: item.owner,
      repo: item.repo,
      issueNum: item.issue_num,
      issueUrl: item.issue_url,
      status: item.status,
      workspaceDir: item.workspace_dir,
    },
    cacheEnv,
    issue: issueMeta,
    preparedAt: new Date().toISOString(),
  };

  fs.writeFileSync(issueJsonPath, `${JSON.stringify(issuePayload, null, 2)}\n`, 'utf8');

  const labels = Array.isArray(issueMeta.labels)
    ? issueMeta.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
    : [];
  const authorLogin = typeof issueMeta.author === 'string'
    ? issueMeta.author
    : issueMeta.author?.login || 'unknown';

  const briefLines = [
    `# ${item.item_key}: ${issueMeta.title || `Issue #${item.issue_num}`}`,
    '',
    `- **Repository:** ${repoSlug}`,
    `- **Issue:** #${item.issue_num} (${issueMeta.url || item.issue_url})`,
    `- **State:** ${issueMeta.state || 'OPEN'}`,
    `- **Author:** ${authorLogin}`,
    `- **Labels:** ${labels.length ? labels.join(', ') : 'none'}`,
    `- **Queue Status:** ${item.status}`,
    `- **Workspace:** \`${item.workspace_dir}\``,
    '',
    '## Shared Cache Environment',
    '',
    '```powershell',
    `$env:NPM_CONFIG_CACHE = "${cacheEnv.NPM_CONFIG_CACHE}"`,
    `$env:PNPM_HOME = "${cacheEnv.PNPM_HOME}"`,
    `$env:UV_CACHE_DIR = "${cacheEnv.UV_CACHE_DIR}"`,
    `$env:CARGO_HOME = "${cacheEnv.CARGO_HOME}"`,
    '```',
    '',
    '## Issue Description',
    '',
    issueMeta.body ? String(issueMeta.body).trim() : '_No description provided._',
    '',
  ];

  fs.writeFileSync(briefPath, briefLines.join('\n'), 'utf8');

  return {
    item,
    issue: issueMeta,
    cloned,
    alreadyCloned,
    issueJsonPath,
    briefPath,
    cacheEnv,
  };
}
