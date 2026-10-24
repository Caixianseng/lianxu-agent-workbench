import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelListing, readCliModels } from '../src/cli-models.mjs';

test('OpenCode listing projects only explicit provider/model identifiers and deduplicates', () => {
  assert.deepEqual(parseModelListing('opencode', '\x1b[32mtest/model-a\x1b[0m\nother/namespace/model:latest\ntest/model-a\nNotice: no model\nhttps://example.invalid\n'), [{ id: 'test/model-a', name: 'test/model-a' }, { id: 'other/namespace/model:latest', name: 'other/namespace/model:latest' }]);
});

test('Qoder 1.1.77 MODEL listing preserves system names and custom explicit IDs', () => {
  const models = parseModelListing('qoder', 'MODEL\nAuto\nSystem Model With Spaces\nMy custom model (custom-id)\nToo long (a-very-long-model-id-truncated-by-cli…)\nAuto\n');
  assert.deepEqual(models, [{ id: 'Auto', name: 'Auto' }, { id: 'System Model With Spaces', name: 'System Model With Spaces' }, { id: 'custom-id', name: 'My custom model' }]);
  assert.deepEqual(parseModelListing('qoder', 'Not logged in. Run qoder login'), []);
  assert.deepEqual(parseModelListing('qoder', 'Some future unsupported format'), []);
});

test('JSON model rows project only model ID and name', () => {
  const source = { models: [{ id: 'model-a', name: 'A', apiKey: 'never-echo', systemPrompt: 'never-echo' }, { modelID: 'model-b', name: 'B' }] };
  assert.deepEqual(parseModelListing('qoder', JSON.stringify(source)), [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }]);
});

test('model query executes only the fixed model-list command and recognizes missing Qoder login', async () => {
  const source = "console.error('Not logged in. Run qodercli login to authenticate.');process.exitCode=1;";
  const catalog = await readCliModels('qoder', { command: process.execPath, prefix: ['-e', source, '--'] });
  assert.equal(catalog.loginRequired, true);
  assert.deepEqual(catalog.models, []);
  assert.match(catalog.warnings.join(' '), /login-qoder/);
});

test('failed model-list requests do not expose upstream secrets or diagnostics', async () => {
  await assert.rejects(readCliModels('opencode', { command: process.execPath, prefix: ['-e', "console.error('private-model-query-secret');process.exitCode=1;", '--'] }), error => error.status === 400 && !error.message.includes('private-model-query-secret'));
});
