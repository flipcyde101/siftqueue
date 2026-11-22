import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueRef, parseIssuesFile } from '../src/parser.js';

test('parseIssueRef parses GitHub issue URLs and short refs', () => {
  const fromUrl = parseIssueRef('https://github.com/vercel/next.js/issues/12345');
  assert.deepEqual(fromUrl, {
    owner: 'vercel',
    repo: 'next.js',
    shortRepo: 'next.js',
    issueNum: 12345,
    issueUrl: 'https://github.com/vercel/next.js/issues/12345',
    canonicalRef: 'vercel/next.js#12345',
  });

  const fromUrlWithQuery = parseIssueRef('  https://github.com/nodejs/node/issues/99?foo=bar#issuecomment-1  ');
  assert.equal(fromUrlWithQuery.owner, 'nodejs');
  assert.equal(fromUrlWithQuery.repo, 'node');
  assert.equal(fromUrlWithQuery.issueNum, 99);

  const fromShort = parseIssueRef('microsoft/typescript#54321');
  assert.deepEqual(fromShort, {
    owner: 'microsoft',
    repo: 'typescript',
    shortRepo: 'typescript',
    issueNum: 54321,
    issueUrl: 'https://github.com/microsoft/typescript/issues/54321',
    canonicalRef: 'microsoft/typescript#54321',
  });
});

test('parseIssueRef rejects malformed references', () => {
  assert.throws(() => parseIssueRef('not-a-valid-ref'), /Invalid issue reference/);
  assert.throws(() => parseIssueRef('https://github.com/owner/repo/pull/10'), /Invalid issue reference/);
  assert.throws(() => parseIssueRef('owner/repo#0'), /Invalid issue number/);
});

test('parseIssuesFile ignores comments, blank lines, CRLF, and duplicates', () => {
  const content = [
    '# Batch issues',
    '',
    'https://github.com/acme/alpha/issues/10',
    '  # indented comment',
    'acme/beta#20',
    'https://github.com/acme/alpha/issues/10',
    '   ',
  ].join('\r\n');

  const refs = parseIssuesFile(content);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].canonicalRef, 'acme/alpha#10');
  assert.equal(refs[1].canonicalRef, 'acme/beta#20');
});

test('parseIssuesFile reports line number on error', () => {
  const content = '# ok\nacme/alpha#10\nbad-line\n';
  assert.throws(() => parseIssuesFile(content), /Line 3:/);
});
