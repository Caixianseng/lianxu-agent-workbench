import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const selectedPath = 'C:\\Trusted CLI\\codex.exe';
const agentInput = extra => ({ name: '本机模型', provider: 'cli', model: 'model-small', tier: 2, skills: ['coding'], ...extra });

async function fixture(t, overrides = {}) {
  const calls = { pick: 0, discoverFile: [], discoverProfile: [], registerProfile: [] };
  const profile = { id: 'local-test-cli', name: '已选择 CLI', command: selectedPath, args: ['--private-argument'], outputFormat: 'json' };
  const discovery = {
    profile, path: selectedPath, kind: 'codex', name: profile.name,
    models: [{ id: 'model-small', name: '轻量模型' }, { id: 'model-large', name: '强力模型', description: '来自本机目录' }],
    source: '本地模型缓存', warnings: ['未验证账号权限'],
  };
  const app = createApp({
    store: new Store(),
    profiles: async () => [{ id: 'existing-cli', name: '现有 CLI', available: true, detail: '测试配置' }],
    pickFile: async options => { calls.pick++; return overrides.pickFile ? overrides.pickFile(options) : selectedPath; },
    cliCatalog: {
      discoverFile: async file => {
        calls.discoverFile.push(file);
        return overrides.discoverFile ? overrides.discoverFile(file, discovery) : discovery;
      },
      discoverProfile: async id => {
        calls.discoverProfile.push(id);
        if (id !== 'existing-cli') throw Object.assign(new Error('CLI 配置不存在'), { status: 404 });
        return { ...discovery, profileId: id, available: true };
      },
      registerProfile: async value => {
        calls.registerProfile.push(value);
        assert.equal(value, profile, 'registration must use the original server-side profile');
        return overrides.registerProfile ? overrides.registerProfile(value) : value;
      },
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, data = {}, headers = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  const selectFile = async () => {
    const response = await post('/api/cli/pick-file');
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...app, base, post, selectFile, calls, discovery, profile, initialAgentCount: app.engine.state.agents.length };
}

async function rejected(response) {
  assert.ok(response.status >= 400 && response.status < 500, `expected client error, received ${response.status}`);
  const data = await response.json();
  assert.equal(typeof data.error, 'string');
  return data;
}

function publicCatalog(data) {
  for (const key of ['profile', 'command', 'args', 'envAllowList']) assert.equal(Object.hasOwn(data, key), false, `must not expose ${key}`);
  assert.equal(JSON.stringify(data).includes('--private-argument'), false);
}

test('native picker cancellation has no discovery or persistence side effects', async t => {
  const f = await fixture(t, { pickFile: async () => null });
  assert.deepEqual(await f.selectFile(), { cancelled: true });
  assert.equal(f.calls.pick, 1);
  assert.deepEqual(f.calls.discoverFile, []);
  assert.deepEqual(f.calls.registerProfile, []);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
});

test('file selection exposes metadata and a token while keeping executable configuration private', async t => {
  const f = await fixture(t);
  const picked = await f.selectFile();
  assert.match(picked.selectionId, /^[a-f0-9-]{36}$/i);
  assert.equal(picked.path, selectedPath);
  assert.deepEqual(picked.models, f.discovery.models);
  assert.equal(picked.source, f.discovery.source);
  assert.deepEqual(picked.warnings, f.discovery.warnings);
  publicCatalog(picked);
  assert.deepEqual(f.calls.discoverFile, [selectedPath]);
  assert.deepEqual(f.calls.registerProfile, []);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
});

test('existing profile model directory is public metadata and enforces model membership on save', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/cli/profiles/existing-cli/models`);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.deepEqual(catalog.models, f.discovery.models);
  publicCatalog(catalog);
  await rejected(await f.post('/api/agents', agentInput({ cliProfile: 'existing-cli', model: 'forged-model' })));
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
  const saved = await f.post('/api/agents', agentInput({ cliProfile: 'existing-cli' }));
  assert.equal(saved.status, 201);
  const agent = await saved.json();
  assert.equal(agent.cliProfile, 'existing-cli');
  assert.equal(agent.model, 'model-small');
  assert.deepEqual(f.calls.registerProfile, [], 'existing profiles must not be re-registered');
});

test('unknown and expired selection tokens cannot register profiles or add agents', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t);
  await rejected(await f.post('/api/agents', agentInput({ cliSelectionId: '00000000-0000-4000-8000-000000000000' })));
  const picked = await f.selectFile();
  now += 31 * 60 * 1000;
  const expired = await rejected(await f.post('/api/agents', agentInput({ cliSelectionId: picked.selectionId })));
  assert.match(expired.error, /过期|失效|重新选择/);
  assert.deepEqual(f.calls.registerProfile, []);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
});

test('tampered models and invalid Agent fields do not register or consume a valid selection', async t => {
  const f = await fixture(t);
  const { selectionId } = await f.selectFile();
  for (const invalid of [{ model: 'forged-model' }, { name: '' }, { tier: 0 }, { skills: [] }]) {
    await rejected(await f.post('/api/agents', agentInput({ cliSelectionId: selectionId, ...invalid })));
    assert.deepEqual(f.calls.registerProfile, []);
    assert.equal(f.engine.state.agents.length, f.initialAgentCount);
  }
  const response = await f.post('/api/agents', agentInput({ cliSelectionId: selectionId }));
  assert.equal(response.status, 201);
  const agent = await response.json();
  assert.equal(agent.cliProfile, f.profile.id);
  assert.equal(agent.model, 'model-small');
  assert.equal(Object.hasOwn(agent, 'cliSelectionId'), false);
  assert.equal(Object.hasOwn(agent, 'cliPath'), false);
  assert.equal(f.calls.registerProfile.length, 1);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount + 1);
});

test('browser-supplied CLI paths cannot bypass native selection even with an existing profile', async t => {
  const f = await fixture(t);
  await rejected(await f.post('/api/agents', agentInput({ cliPath: 'C:\\untrusted.exe' })));
  for (const injected of [{ cliPath: 'C:\\untrusted.exe' }, { command: 'cmd.exe' }, { args: ['/c', 'anything'] }, { profile: { command: 'cmd.exe' } }]) {
    await rejected(await f.post('/api/agents', agentInput({ cliProfile: 'existing-cli', ...injected })));
  }
  await rejected(await f.post('/api/cli/pick-file', { path: 'C:\\untrusted.exe' }));
  assert.equal(f.calls.pick, 0);
  assert.deepEqual(f.calls.discoverFile, []);
  assert.deepEqual(f.calls.registerProfile, []);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
});

test('cross-origin requests are rejected before the native picker or profile registration', async t => {
  const f = await fixture(t);
  const headers = { Origin: 'https://untrusted.example' };
  assert.equal((await f.post('/api/cli/pick-file', {}, headers)).status, 403);
  assert.equal(f.calls.pick, 0);
  assert.deepEqual(f.calls.discoverFile, []);
  const { selectionId } = await f.selectFile();
  assert.equal((await f.post('/api/agents', agentInput({ cliSelectionId: selectionId }), headers)).status, 403);
  assert.deepEqual(f.calls.registerProfile, []);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
});

test('empty discovered catalogs cannot be bypassed by supplying an arbitrary model', async t => {
  const f = await fixture(t, { discoverFile: async (_, discovery) => ({ ...discovery, models: [] }) });
  const { selectionId } = await f.selectFile();
  await rejected(await f.post('/api/agents', agentInput({ cliSelectionId: selectionId })));
  assert.deepEqual(f.calls.registerProfile, []);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
});

test('profile registration failure creates no Agent and permits a corrected retry', async t => {
  let fail = true;
  const f = await fixture(t, { registerProfile: async value => {
    if (fail) throw Object.assign(new Error('无法保存本地 CLI 配置'), { status: 400 });
    return value;
  } });
  const { selectionId } = await f.selectFile();
  await rejected(await f.post('/api/agents', agentInput({ cliSelectionId: selectionId })));
  assert.equal(f.engine.state.agents.length, f.initialAgentCount);
  fail = false;
  const saved = await f.post('/api/agents', agentInput({ cliSelectionId: selectionId }));
  assert.equal(saved.status, 201);
  assert.equal(f.calls.registerProfile.length, 2);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount + 1);
});

test('concurrent and repeated submissions of one selection register and add exactly once', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const registrationStarted = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { registerProfile: async value => {
    started();
    await gate;
    return value;
  } });
  const { selectionId } = await f.selectFile();
  const input = agentInput({ cliSelectionId: selectionId });
  const first = f.post('/api/agents', input);
  await registrationStarted;
  assert.equal((await f.post('/api/agents', input)).status, 409);
  assert.equal(f.calls.registerProfile.length, 1);
  release();
  assert.equal((await first).status, 201);
  assert.equal((await f.post('/api/agents', input)).status, 409);
  assert.equal((await f.post('/api/agents', { ...input, model: 'model-large' })).status, 409);
  assert.equal(f.calls.registerProfile.length, 1);
  assert.equal(f.engine.state.agents.length, f.initialAgentCount + 1);
});

test('a second picker request is rejected while the native window is open', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pickerStarted = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { pickFile: async () => { started(); await gate; return selectedPath; } });
  const first = f.post('/api/cli/pick-file');
  await pickerStarted;
  assert.equal((await f.post('/api/cli/pick-file')).status, 409);
  assert.equal(f.calls.pick, 1);
  release();
  assert.equal((await first).status, 200);
});

test('malformed picker requests and unknown fields fail before opening a native window', async t => {
  const f = await fixture(t);
  for (const input of [null, [], 'file', 42, { command: 'cmd.exe' }, { fileId: 'forged' }, { directory: 'C:\\' }]) {
    await rejected(await f.post('/api/cli/pick-file', input));
  }
  assert.equal(f.calls.pick, 0);
  assert.deepEqual(f.calls.discoverFile, []);
  assert.deepEqual(f.calls.registerProfile, []);
});

test('closing the picker HTTP request aborts the native window and releases its lock', { timeout: 5000 }, async t => {
  let started, aborted;
  const pickerStarted = new Promise(resolve => { started = resolve; });
  const pickerAborted = new Promise(resolve => { aborted = resolve; });
  let invocation = 0;
  const f = await fixture(t, { pickFile: async ({ signal }) => {
    if (++invocation > 1) return null;
    started();
    return new Promise(resolve => signal.addEventListener('abort', () => { aborted(); resolve(null); }, { once: true }));
  } });
  const controller = new AbortController();
  const request = fetch(`${f.base}/api/cli/pick-file`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
  });
  await pickerStarted;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await pickerAborted;
  assert.deepEqual(await f.selectFile(), { cancelled: true });
  assert.equal(f.calls.pick, 2);
  assert.deepEqual(f.calls.discoverFile, []);
  assert.deepEqual(f.calls.registerProfile, []);
});

test('native picker failures remain errors and release the lock for a subsequent request', async t => {
  let failed = false;
  const f = await fixture(t, { pickFile: async () => {
    if (!failed) { failed = true; throw Object.assign(new Error('系统文件选择器启动失败'), { status: 400 }); }
    return null;
  } });
  const error = await rejected(await f.post('/api/cli/pick-file'));
  assert.match(error.error, /启动失败/);
  assert.equal(Object.hasOwn(error, 'cancelled'), false);
  assert.deepEqual(await f.selectFile(), { cancelled: true });
  assert.equal(f.calls.pick, 2);
  assert.deepEqual(f.calls.discoverFile, []);
  assert.deepEqual(f.calls.registerProfile, []);
});
