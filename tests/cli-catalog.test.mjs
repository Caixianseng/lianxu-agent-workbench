import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliCatalog } from '../src/cli-catalog.mjs';
import { createProviderClient } from '../src/providers.mjs';

async function fixture(t, extraEnv = {}) {
  const directory = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.cli-catalog-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, '.codex');
  const claudeHome = path.join(directory, '.claude');
  const configPath = path.join(directory, 'config', 'cli-profiles.json');
  await mkdir(codexHome); await mkdir(claudeHome);
  const env = { USERPROFILE: directory, HOME: directory, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ...extraEnv };
  const catalog = createCliCatalog({ env, configPath, now: () => Date.parse('2026-10-23T01:00:00Z') });
  async function json(file, value) { await writeFile(file, JSON.stringify(value)); return file; }
  async function executable(kind) {
    const file = path.join(directory, process.platform === 'win32' ? `${kind}.exe` : kind);
    // Deliberately not executable machine code: discovery must not run it.
    await writeFile(file, 'READ-ONLY DISCOVERY FIXTURE; NEVER EXECUTE');
    await chmod(file, 0o755);
    return file;
  }
  return { directory, codexHome, claudeHome, configPath, catalog, env, json, executable };
}

test('Codex executable discovery uses visible local cache models and never persists or executes', async t => {
  const f = await fixture(t);
  await f.json(path.join(f.codexHome, 'models_cache.json'), {
    identity: { secret: 'must-never-leak' }, fetched_at: '2026-10-22T20:00:00Z',
    models: [{ slug: 'model-a', display_name: 'Model A', description: 'Example', visibility: 'list', base_instructions: 'must-never-leak' }, { slug: 'hidden-model', visibility: 'hide' }, { slug: 'model-a', visibility: 'list' }],
  });
  const file = await f.executable('codex');
  const result = await f.catalog.discoverCliFile(file);
  assert.equal(result.kind, 'codex');
  assert.equal(result.path, file);
  assert.deepEqual(result.models, [{ id: 'model-a', name: 'Model A', description: 'Example' }]);
  assert.match(result.source, /models_cache.json/);
  assert.equal(result.updatedAt, '2026-10-22T20:00:00.000Z');
  assert.ok(result.profile.args.includes('read-only'));
  assert.ok(result.profile.args.includes('shell_tool'));
  assert.ok(!JSON.stringify(result).includes('must-never-leak'));
  await assert.rejects(access(f.configPath), { code: 'ENOENT' });
});

test('missing and stale Codex caches return explicit warnings without invented models', async t => {
  const f = await fixture(t);
  const file = await f.executable('codex');
  const empty = await f.catalog.discoverCliFile(file);
  assert.deepEqual(empty.models, []);
  assert.match(empty.warnings.join(' '), /生成模型缓存/);
  await f.json(path.join(f.codexHome, 'models_cache.json'), { fetched_at: '2026-01-01T00:00:00Z', models: [{ slug: 'old-model', visibility: 'list' }] });
  const stale = await f.catalog.discoverCliFile(file);
  assert.match(stale.warnings.join(' '), /超过 24 小时/);
  await writeFile(path.join(f.codexHome, 'models_cache.json'), 'broken');
  const broken = await f.catalog.discoverCliFile(file);
  assert.deepEqual(broken.models, []);
  assert.match(broken.warnings.join(' '), /无法解析/);
});

test('Claude discovery projects only explicitly configured models and excludes credentials', async t => {
  const f = await fixture(t, { ANTHROPIC_MODEL: 'configured-env-model', ANTHROPIC_API_KEY: 'api-key-must-never-leak' });
  await f.json(path.join(f.claudeHome, 'settings.json'), {
    model: 'configured-settings-model', availableModels: ['configured-allowed-model', '*'],
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'configured-pinned-model', ANTHROPIC_AUTH_TOKEN: 'token-must-never-leak' },
  });
  const result = await f.catalog.discoverCliFile(await f.executable('claude'));
  assert.deepEqual(result.models.map(item => item.id), ['configured-settings-model', 'configured-allowed-model', 'configured-pinned-model', 'configured-env-model']);
  assert.match(result.warnings.join(' '), /不代表账号所有可用模型/);
  assert.ok(!JSON.stringify(result).includes('must-never-leak'));
  assert.ok(result.profile.args.includes('--safe-mode'));
});

test('unknown executables and shell shims are rejected without attempting execution', async t => {
  const f = await fixture(t);
  for (const kind of ['unknown', 'codex.cmd', 'claude.ps1']) {
    const file = path.join(f.directory, kind === 'unknown' ? 'unknown.exe' : kind);
    await writeFile(file, 'must not execute');
    await assert.rejects(f.catalog.discoverCliFile(file), error => error.status === 400);
  }
  await assert.rejects(f.catalog.discoverCliFile(f.directory), error => error.status === 400);
  await assert.rejects(f.catalog.discoverCliFile('relative.exe'), error => error.status === 400);
});

test('JSON manifests import fixed args and models, register atomically and preserve existing config', async t => {
  const f = await fixture(t);
  const manifest = await f.json(path.join(f.directory, 'adapter.json'), {
    name: 'My trusted adapter', command: process.execPath,
    args: ['C:/trusted/adapter.mjs', '--model', '{model}'], outputFormat: 'json',
    models: [{ id: ' local-one ', name: 'Local One' }, 'local-two'], envAllowList: ['MY_LOCAL_KEY'],
  });
  await mkdir(path.dirname(f.configPath));
  await f.json(f.configPath, { note: 'keep this', profiles: [{ id: 'existing', name: 'Existing', command: process.execPath, args: [], outputFormat: 'json' }] });
  const found = await f.catalog.discoverCliFile(manifest);
  assert.equal(found.kind, 'manifest');
  assert.equal(found.models.length, 2);
  const stored = await f.catalog.registerCliProfile(found.profile);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(config.note, 'keep this');
  assert.equal(config.profiles.length, 2);
  assert.equal(config.profiles[0].id, 'existing');
  assert.equal(config.profiles[1].id, stored.id);
  assert.equal((await createProviderClient({ env: f.env, configPath: f.configPath }).getCliProfiles()).find(row => row.id === stored.id).available, true);
  const refreshed = await f.catalog.discoverProfileModels(stored.id);
  assert.equal(refreshed.models[0].id, 'local-one');
  assert.ok(!Object.hasOwn(refreshed, 'profile'));
  await f.catalog.registerCliProfile(found.profile);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).profiles.length, 2);
});

test('registration rejects browser-supplied or mutated command definitions', async t => {
  const f = await fixture(t);
  const found = await f.catalog.discoverCliFile(await f.executable('codex'));
  await assert.rejects(f.catalog.registerCliProfile(structuredClone(found.profile)), error => error.status === 400);
  found.profile.args.push('--dangerous-added-argument');
  await assert.rejects(f.catalog.registerCliProfile(found.profile), error => error.status === 400);
  await assert.rejects(access(f.configPath), { code: 'ENOENT' });
});

test('parallel registrations preserve both selected profiles and registered native catalogs refresh', async t => {
  const f = await fixture(t);
  const first = await f.catalog.discoverCliFile(await f.executable('codex'));
  const second = await f.catalog.discoverCliFile(await f.executable('claude'));
  await Promise.all([f.catalog.registerCliProfile(first.profile), f.catalog.registerCliProfile(second.profile)]);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).profiles.length, 2);
  await f.json(path.join(f.codexHome, 'models_cache.json'), { models: [{ slug: 'newly-cached', visibility: 'list' }] });
  assert.equal((await f.catalog.discoverProfileModels(first.profile.id)).models[0].id, 'newly-cached');
});

test('invalid JSON model manifests fail with status 400 and never leak source text', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'bad.json');
  await writeFile(file, '{"secret":"do-not-echo",broken}');
  await assert.rejects(f.catalog.discoverCliFile(file), error => error.status === 400 && !error.message.includes('do-not-echo'));
  for (const models of [undefined, [], [{ id: '--bad-flag' }], ['bad\nmodel'], ['x'.repeat(161)]]) {
    await f.json(file, { name: 'bad', command: process.execPath, args: [], outputFormat: 'json', models });
    await assert.rejects(f.catalog.discoverCliFile(file), error => error.status === 400);
  }
  await assert.rejects(f.catalog.discoverProfileModels('missing'), error => error.status === 400);
});

test('OpenCode desktop selection resolves a CLI and lists models without registering or launching the GUI', async t => {
  const f = await fixture(t);
  const file = await f.executable('OpenCode');
  const calls = [];
  const catalog = createCliCatalog({ env: f.env, configPath: f.configPath,
    locateCli: (kind, options) => { calls.push({ kind, path: options.selectedPath }); return { command: process.execPath, prefix: [], desktop: true }; },
    readModels: async (kind, location) => { assert.equal(kind, 'opencode'); assert.equal(location.command, process.execPath); return { models: [{ id: 'provider/model-a', name: 'A' }], source: 'CLI models', warnings: [] }; },
  });
  const found = await catalog.discoverCliFile(file);
  assert.equal(found.kind, 'opencode');
  assert.equal(found.path, file);
  assert.equal(found.profile.command, process.execPath);
  assert.equal(found.profile.outputFormat, 'opencode-jsonl');
  assert.deepEqual(calls, [{ kind: 'opencode', path: file }]);
  assert.match(found.warnings[0], /桌面程序/);
  assert.equal(found.models[0].id, 'provider/model-a');
  await assert.rejects(access(f.configPath), { code: 'ENOENT' });
});

test('Qoder Launcher resolves a Node CLI prefix and shows missing login without fabricating models', async t => {
  const f = await fixture(t);
  const file = await f.executable('Qoder Launcher');
  const prefix = [path.join(f.directory, 'qodercli.js')];
  const catalog = createCliCatalog({ env: f.env, configPath: f.configPath,
    locateCli: () => ({ command: process.execPath, prefix, desktop: true }),
    readModels: async (kind, location) => { assert.equal(kind, 'qoder'); assert.deepEqual(location.prefix, prefix); return { models: [], source: 'Qoder CLI', warnings: ['尚未登录'], loginRequired: true }; },
  });
  const found = await catalog.discoverCliFile(file);
  assert.equal(found.kind, 'qoder');
  assert.equal(found.profile.command, process.execPath);
  assert.equal(found.profile.args[0], prefix[0]);
  assert.deepEqual(found.models, []);
  assert.equal(found.loginRequired, true);
  assert.match(found.warnings.join(' '), /尚未登录/);
  assert.ok(found.profile.args.includes('--model'));
});

test('a supported desktop with no CLI reports the actual missing component', async t => {
  const f = await fixture(t);
  const catalog = createCliCatalog({ env: f.env, configPath: f.configPath, locateCli: () => null });
  await assert.rejects(catalog.discoverCliFile(await f.executable('Qoder Launcher')), error => error.status === 400 && /未找到对应 CLI/.test(error.message));
});
