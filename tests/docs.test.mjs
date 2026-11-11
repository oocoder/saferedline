import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs, checkLineLink } from '../scripts/check_docs.mjs';

const file = ['// comment', 'const a = 1;', '', 'function attestOrThrow() {}', 'text = null;'].join('\n');
const read = (rel) => (rel === 'src/x.mjs' ? file : null);

test('docs links (README etc.) are fresh: files exist, #L ranges valid and point at the claimed code', () => {
  const { problems } = checkDocs();
  assert.deepEqual(problems, []);
});

test('checker catches stale links (self-test)', () => {
  assert.equal(checkLineLink('src/x.mjs#L4', '`attestOrThrow`', read), null);
  assert.match(checkLineLink('src/x.mjs#L2', '`attestOrThrow`', read), /expected/);   // wrong code at the line
  assert.match(checkLineLink('src/x.mjs#L99', 'x', read), /outside/);                  // past end of file
  assert.match(checkLineLink('src/x.mjs#L1', 'x', read), /comment-only/);              // comment line
  assert.match(checkLineLink('src/x.mjs#L3', 'x', read), /blank/);                     // blank line
  assert.match(checkLineLink('src/y.mjs#L1', 'x', read), /not found/);
  assert.equal(checkLineLink('src/x.mjs#L4-L5', 'dropped after use', read), null);
  assert.match(checkLineLink('src/x.mjs#L5-L4', 'x', read), /outside/);
});

import { sentinelBlock } from '../scripts/check_docs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('sentinel links must land inside the sentinel describe block', () => {
  const src = ["describe('other', () => {", '  assert.ok(1);', '});', '', "describe('zero retention (sentinel)', () => {", '  assert.ok(2);', '});', '', "describe('after', () => {", '  assert.ok(3);', '});'].join('\n');
  assert.deepEqual(sentinelBlock(src.split('\n')), [5, 8]);
  const rd = (rel) => (rel === 'tests/pipeline.test.mjs' ? src : null);
  assert.equal(checkLineLink('tests/pipeline.test.mjs#L6', 'the sentinel test', rd), null);
  assert.match(checkLineLink('tests/pipeline.test.mjs#L2', 'the sentinel test', rd), /outside the sentinel describe block/);
  assert.match(checkLineLink('tests/pipeline.test.mjs#L10', 'the sentinel test', rd), /outside the sentinel describe block/);
});

test('docs commands: unknown `npm run x` and missing shortcut scripts are reported; docs/plans is not scanned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x', twin: 'y' } }));
  fs.writeFileSync(path.join(root, 'README.md'), 'Run `npm run twin` then `npm test`, `npm ci`, but not `npm run bogus` or `npm start`.\n');
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'old.md'), '`npm run ghost`\n');
  const { problems } = checkDocs(root);
  assert.deepEqual(problems.map((p) => p.replace(/^README.md:\d+ /, '')).sort(), ['npm start has no script', 'unknown npm script: npm run bogus']);
});
