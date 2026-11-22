const GITHUB_ISSUE_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i;
const SHORT_REF_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;

/**
 * Parse a single GitHub issue reference (URL or owner/repo#num).
 * @param {string} rawLine
 * @returns {{ owner: string, repo: string, shortRepo: string, issueNum: number, issueUrl: string, canonicalRef: string }}
 */
export function parseIssueRef(rawLine) {
  const line = rawLine.trim();
  let match = GITHUB_ISSUE_URL_RE.exec(line);
  if (!match) {
    match = SHORT_REF_RE.exec(line);
  }
  if (!match) {
    throw new Error(`Invalid issue reference: "${line}". Expected GitHub issue URL or owner/repo#num.`);
  }

  const owner = match[1];
  const repo = match[2];
  const issueNum = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(issueNum) || issueNum <= 0) {
    throw new Error(`Invalid issue number in "${line}".`);
  }

  const shortRepo = repo.replace(/[^A-Za-z0-9._-]/g, '-');
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNum}`;
  const canonicalRef = `${owner}/${repo}#${issueNum}`;

  return {
    owner,
    repo,
    shortRepo,
    issueNum,
    issueUrl,
    canonicalRef,
  };
}

/**
 * Parse an issues file containing one issue URL or owner/repo#num per line.
 * Blank lines and lines starting with # are ignored.
 * @param {string} content
 * @returns {Array<{ owner: string, repo: string, shortRepo: string, issueNum: number, issueUrl: string, canonicalRef: string }>}
 */
export function parseIssuesFile(content) {
  const lines = content.split(/\r?\n/);
  const refs = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    try {
      const parsed = parseIssueRef(trimmed);
      const dedupeKey = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.issueNum}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        refs.push(parsed);
      }
    } catch (err) {
      throw new Error(`Line ${i + 1}: ${err.message}`);
    }
  }

  return refs;
}
