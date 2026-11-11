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
