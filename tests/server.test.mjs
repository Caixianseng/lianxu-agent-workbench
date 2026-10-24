import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { eligible } from '../src/engine.mjs';
import { request } from 'node:http';

test('HTTP demo roundtrip, export, request isolation and credential-safe state', async t => {
  const { server, engine } = createApp({ store: new Store(), profiles: async () => [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  assert.equal((await post('/api/runs', {}, { Origin: 'https://malicious.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/state`, { headers: { Host: 'malicious.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', body: '{}' })).status, 415);
  const created = await post('/api/runs', { goal: '演示失败修复闭环', leadAgentId: 'demo-lead', demoFailure: true });
  assert.equal(created.status, 201);
  const { id } = await created.json(); await engine.wait(id);
  const run = engine.getRun(id); assert.equal(run.status, 'awaiting_approval');
  const approved = await post(`/api/runs/${id}/approve`, { assignments: run.tasks.map(task => ({ taskId: task.id, agentId: task.suggestedAgentId })) });
  assert.equal(approved.status, 200); await engine.wait(id);
  assert.equal(run.status, 'completed'); assert.equal(run.tasks[0].attempts.length, 2);
  const report = await fetch(`${base}/api/runs/${id}/export`);
  assert.match(await report.text(), /模型审查/);
  assert.match(report.headers.get('content-disposition'), /attachment/);
  assert.equal((await fetch(`${base}/src/server.mjs`)).status, 404);
});

test('restart interrupts active work while retaining awaiting approval and historical output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
  try {
    const file = join(dir, 'state.json'); const store = new Store(file);
    store.state.runs.push({ id: 'active', status: 'running', tasks: [{ status: 'passed', output: 'accepted' }, { status: 'reviewing' }] }, { id: 'approval', status: 'awaiting_approval', tasks: [] }); store.save();
    const recovered = new Store(file);
    assert.equal(recovered.state.runs[0].status, 'interrupted');
    assert.equal(recovered.state.runs[0].tasks[0].output, 'accepted');
    assert.equal(recovered.state.runs[0].tasks[1].status, 'cancelled');
    assert.equal(recovered.state.runs[1].status, 'awaiting_approval');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('leader cannot bypass skill or tier eligibility', () => {
  const lead = { id: 'lead', provider: 'demo', tier: 1, skills: ['writing'] };
  assert.equal(eligible(lead, { complexity: 2, risk: 'low', requiredSkills: ['writing'] }, lead), false);
  assert.equal(eligible(lead, { complexity: 1, risk: 'low', requiredSkills: ['coding'] }, lead), false);
});
