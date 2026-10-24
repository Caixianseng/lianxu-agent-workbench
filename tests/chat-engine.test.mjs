import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, validatePlan } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';

const task = (id = 'writing', extra = {}) => ({ id, title: `${id} task`, description: 'Prepare a small written deliverable', complexity: 1, risk: 'low', requiredSkills: ['writing'], dependencies: [], acceptance: ['Has a concrete example'], ...extra });
const assignmentsOf = run => run.tasks.map(t => ({ taskId: t.id, agentId: t.suggestedAgentId }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function prepared({ tasks = [task(), task('second')], route = { reply: '已按指令调整，请确认分配。', assignments: [{ taskId: 'writing', agentId: 'demo-builder' }] }, calls = [], extraPlan = {}, store = new Store(), ...options } = {}) {
  const provider = async (agent, request, context) => {
    calls.push({ agent, request, context });
    if (request.phase === 'plan') return { data: { tasks, ...extraPlan } };
    if (request.phase === 'route') return typeof route === 'function' ? route(agent, request, context) : { data: route, usage: { input_tokens: 3, output_tokens: 4 } };
    if (request.phase === 'execute') return { data: { content: 'A concrete example' } };
    if (request.phase === 'review') return { data: { passed: true, feedback: 'All criteria covered', criteria: request.task.acceptance.map(criterion => ({ criterion, passed: true, evidence: 'A concrete example was provided' })) } };
    return { data: { content: 'Consolidated results' } };
  };
  const engine = new Engine(store, provider);
  const run = engine.createRun({ goal: 'Write a concise explanation', leadAgentId: 'demo-lead', ...options });
  await engine.wait(run.id);
  return { engine, run, calls };
}

test('plan keeps the initial goal, lead reply and explicit eligible Agent preference', async () => {
  const { run } = await prepared({ tasks: [task('writing', { preferredAgentId: 'demo-builder' })], extraPlan: { reply: '写作任务按要求交给 Nova。' } });
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.messages.length, 2);
  assert.equal(run.messages[0].content, run.goal);
  assert.match(run.messages[1].content, /按要求交给 Nova/);
  for (const message of run.messages) {
    assert.ok(message.id && message.time);
    assert.ok(['user', 'assistant'].includes(message.role));
  }
  assert.equal(run.chatBusy, false); assert.equal(run.chatError, '');
  assert.equal(run.tasks[0].suggestedAgentId, 'demo-builder');
  assert.match(run.tasks[0].routingReason, /按目标中的指令指定/);
});

test('invalid plan preferences fail visibly without substituting a different Agent', async t => {
  for (const [name, preference] of [
    ['unknown Agent', { preferredAgentId: 'unknown' }],
    ['high-risk worker', { preferredAgentId: 'demo-builder', risk: 'high' }],
    ['insufficient tier', { preferredAgentId: 'demo-light', complexity: 2 }],
    ['missing skill', { preferredAgentId: 'demo-builder', requiredSkills: ['planning'] }]
  ]) await t.test(name, async () => {
    const { run } = await prepared({ tasks: [task('writing', preference)] });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /未自动替换/);
    assert.equal(run.tasks.length, 0);
  });
  assert.throws(() => validatePlan({ tasks: [task('writing', { preferredAgentId: null })] }));
});

test('chat uses the lead with bounded task/context data and updates suggestions without executing', async () => {
  const { engine, run, calls } = await prepared();
  const originalSecond = run.tasks[1].suggestedAgentId;
  assert.equal(engine.chat(run.id, { message: ' 把 T01 交给 Nova ' }), run);
  assert.equal(run.chatBusy, true);
  await engine.wait(run.id);
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.chatBusy, false); assert.equal(run.chatError, '');
  assert.equal(run.tasks[0].suggestedAgentId, 'demo-builder');
  assert.equal(run.tasks[1].suggestedAgentId, originalSecond);
  assert.ok(run.tasks.every(t => !t.agentId && t.attempts.length === 0));
  assert.equal(run.routingRevision, 1); assert.equal(run.callsUsed, 2);
  assert.equal(run.tasks[0].routingRevision, 1);
  assert.equal(run.tasks[1].routingRevision, undefined);
  assert.equal(run.usage.at(-1).phase, 'route');
  assert.match(run.tasks[0].routingReason, /按聊天指令指定 Nova/);
  assert.equal(run.messages.at(-2).content, '把 T01 交给 Nova');
  assert.match(run.messages.at(-1).content, /请确认分配/);
  assert.deepEqual(run.messages.at(-1).assignments, [{ taskId: 'writing', agentId: 'demo-builder' }]);
  const { agent, request } = calls[1];
  assert.equal(agent.id, run.leadAgentId);
  assert.equal(request.phase, 'route'); assert.equal(request.goal, run.goal);
  assert.equal(request.leadAgentId, run.leadAgentId);
  assert.equal(request.message, '把 T01 交给 Nova');
  assert.deepEqual(request.agents, run.agentSnapshots);
  assert.equal(request.tasks[0].displayId, 'T01');
  assert.equal(request.tasks[0].id, 'writing');
  assert.deepEqual(request.tasks[0].acceptance, run.tasks[0].acceptance);
  assert.equal(request.tasks[0].suggestedAgentId, 'demo-light');
  assert.equal(request.messages.at(-1).content, request.message);
  assert.deepEqual(calls.map(c => c.request.phase), ['plan', 'route']);
  engine.approve(run.id, { assignments: assignmentsOf(run) });
  await engine.wait(run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.tasks[0].attempts[0].agentId, 'demo-builder');
});

test('ambiguous instructions can ask a clarifying question with zero assignments', async () => {
  const { engine, run } = await prepared({ route: { reply: '你希望使用 Nova 还是 Spark？', assignments: [] } });
  const old = assignmentsOf(run);
  engine.chat(run.id, { message: '把它交给那个模型' }); await engine.wait(run.id);
  assert.deepEqual(assignmentsOf(run), old);
  assert.equal(run.routingRevision, 0);
  assert.equal(run.chatError, ''); assert.equal(run.status, 'awaiting_approval');
  assert.match(run.messages.at(-1).content, /Nova 还是 Spark/);
});

test('every routing assignment is validated before any suggestion is changed', async t => {
  const good = { taskId: 'writing', agentId: 'demo-builder' };
  for (const [name, assignments] of [
    ['unknown task', [good, { taskId: 'unknown', agentId: 'demo-builder' }]],
    ['unknown snapshot Agent', [good, { taskId: 'second', agentId: 'unknown' }]],
    ['duplicate task', [good, good]],
    ['malformed item', [good, null]]
  ]) await t.test(name, async () => {
    const { engine, run } = await prepared({ route: { reply: 'Updated', assignments } });
    const old = structuredClone(run.tasks);
    engine.chat(run.id, { message: '调整分工' }); await engine.wait(run.id);
    assert.deepEqual(run.tasks, old);
    assert.equal(run.status, 'awaiting_approval'); assert.equal(run.chatBusy, false);
    assert.ok(run.chatError); assert.equal(run.error, ''); assert.equal(run.routingRevision, 0);
    assert.match(run.messages.at(-1).content, /未更新任务分配/);
  });
});

test('high-risk and complex work cannot be routed to a worker even when its tier is sufficient', async t => {
  for (const restriction of [{ risk: 'high' }, { complexity: 3 }]) await t.test(JSON.stringify(restriction), async () => {
    const store = new Store();
    store.state.agents.find(a => a.id === 'demo-builder').tier = 3;
    const { engine, run } = await prepared({ store, tasks: [task('writing', restriction)] });
    engine.chat(run.id, { message: '交给 Nova' }); await engine.wait(run.id);
    assert.equal(run.tasks[0].suggestedAgentId, 'demo-lead');
    assert.match(run.chatError, /复杂\/高风险任务须由主导负责/);
    assert.equal(run.error, '');
  });
});

test('routing rejects insufficient tier and missing skills, while retaining valid old suggestions', async t => {
  for (const restriction of [{ complexity: 3, risk: 'low' }, { requiredSkills: ['planning'] }]) await t.test(JSON.stringify(restriction), async () => {
    const { engine, run } = await prepared({ tasks: [task('writing', restriction)] });
    engine.chat(run.id, { message: '交给 Nova' }); await engine.wait(run.id);
    assert.equal(run.tasks[0].suggestedAgentId, 'demo-lead'); assert.ok(run.chatError);
  });
});

test('new Agents added after planning are not accepted as members of an existing snapshot', async () => {
  let newId;
  const { engine, run } = await prepared({ route: async () => ({ data: { reply: 'Updated', assignments: [{ taskId: 'writing', agentId: newId }] } }) });
  newId = engine.addAgent({ name: 'New worker', provider: 'demo', model: 'new-model', tier: 2, skills: ['writing'] }).id;
  engine.chat(run.id, { message: '交给新模型' }); await engine.wait(run.id);
  assert.equal(run.tasks[0].suggestedAgentId, 'demo-light'); assert.match(run.chatError, /未知任务或 Agent/);
});

test('invalid or excessively long route replies leave allocation intact and allow a later retry', async t => {
  for (const invalid of [null, { reply: '', assignments: [] }, { reply: 'x'.repeat(6001), assignments: [] }, { reply: 'ok' }, { reply: 'ok', assignments: 'all' }]) await t.test(String(invalid?.reply?.length || 'invalid'), async () => {
    const { engine, run } = await prepared({ route: invalid });
    engine.chat(run.id, { message: '调整分工' }); await engine.wait(run.id);
    assert.equal(run.tasks[0].suggestedAgentId, 'demo-light'); assert.ok(run.chatError);
    assert.equal(run.chatBusy, false); assert.equal(run.status, 'awaiting_approval');
  });
  const { engine, run } = await prepared({ route: async () => { throw new Error('Model unavailable'); } });
  engine.chat(run.id, { message: '调整分工' }); await engine.wait(run.id);
  assert.equal(run.chatError, 'Model unavailable'); assert.equal(run.error, '');
  engine.provider = async () => ({ data: { reply: '请确认分配', assignments: [] } });
  engine.chat(run.id, { message: '再试一次' }); await engine.wait(run.id);
  assert.equal(run.chatError, ''); assert.equal(run.status, 'awaiting_approval');
});

test('chat shares the run call budget and never submits a request above its cap', async () => {
  const { engine, run, calls } = await prepared({ maxCalls: 5, route: { reply: '继续明确需求', assignments: [] } });
  for (let i = 0; i < 5; i++) { engine.chat(run.id, { message: `clarification ${i}` }); await engine.wait(run.id); }
  assert.equal(run.callsUsed, 5); assert.equal(calls.length, 5);
  assert.match(run.chatError, /调用次数已达上限/);
  assert.equal(run.error, ''); assert.equal(run.status, 'awaiting_approval'); assert.equal(run.chatBusy, false);
  assert.equal(run.routingRevision, 0); assert.equal(engine.jobs.size, 0);
});

test('routing locks approval, other runs and duplicate chats until the model has finished', async () => {
  const started = deferred(), release = deferred();
  const { engine, run } = await prepared({ route: async () => { started.resolve(); await release.promise; return { data: { reply: '已调整', assignments: [] } }; } });
  const other = engine.createRun({ goal: 'Another project', leadAgentId: 'demo-lead' }); await engine.wait(other.id);
  engine.chat(run.id, { message: '调整分工' }); await started.promise;
  assert.throws(() => engine.chat(run.id, { message: '同时发送' }), /正在调用模型/);
  assert.throws(() => engine.chat(other.id, { message: '另一个运行发送' }), /正在调用模型/);
  assert.throws(() => engine.approve(run.id, { assignments: assignmentsOf(run) }), /正在调用模型/);
  assert.throws(() => engine.approve(other.id, { assignments: assignmentsOf(other) }), /正在调用模型/);
  assert.throws(() => engine.createRun({ goal: 'Third project', leadAgentId: 'demo-lead' }), /正在调用模型/);
  release.resolve(); await engine.wait(run.id);
  assert.equal(engine.jobs.size, 0);
  engine.chat(other.id, { message: '现在可以发送' }); await engine.wait(other.id);
  assert.equal(other.routingRevision, 0);
});

test('cancelled routing discards late output and reserves the global job lock until it settles', async () => {
  const started = deferred(), release = deferred();
  let signal;
  const { engine, run } = await prepared({ route: async (_agent, _request, context) => {
    signal = context.signal; started.resolve(); await release.promise;
    return { data: { reply: 'Late reply must be discarded', assignments: [{ taskId: 'writing', agentId: 'demo-builder' }] } };
  } });
  const old = assignmentsOf(run);
  engine.chat(run.id, { message: '调整分工' }); await started.promise;
  engine.cancel(run.id);
  assert.equal(signal.aborted, true); assert.equal(run.chatBusy, false);
  assert.throws(() => engine.createRun({ goal: 'After cancellation', leadAgentId: 'demo-lead' }), /正在调用模型/);
  release.resolve(); await engine.wait(run.id);
  assert.equal(run.status, 'cancelled'); assert.equal(run.routingRevision, 0);
  assert.deepEqual(assignmentsOf(run), old);
  assert.equal(run.messages.at(-1).role, 'user');
  assert.equal(run.chatError, ''); assert.equal(engine.jobs.size, 0);
  const next = engine.createRun({ goal: 'Now safe', leadAgentId: 'demo-lead' }); await engine.wait(next.id);
  assert.equal(next.status, 'awaiting_approval');
});

test('cancelled planning also retains the global job lock until its ignored abort settles', async () => {
  const release = deferred(), started = deferred();
  const engine = new Engine(new Store(), async () => { started.resolve(); await release.promise; return { data: { tasks: [task()] } }; });
  const run = engine.createRun({ goal: 'Slow planning', leadAgentId: 'demo-lead' }); await started.promise;
  engine.cancel(run.id);
  assert.throws(() => engine.createRun({ goal: 'Unsafe overlap', leadAgentId: 'demo-lead' }), /正在调用模型/);
  release.resolve(); await engine.wait(run.id);
  assert.equal(run.status, 'cancelled'); assert.equal(run.tasks.length, 0); assert.equal(engine.jobs.size, 0);
});

test('chat validates status, message size and the 100-message limit before submitting', async () => {
  const { engine, run, calls } = await prepared();
  for (const message of ['', ' ', null, 123, 'x'.repeat(6001)]) assert.throws(() => engine.chat(run.id, { message }), /请输入聊天内容/);
  assert.equal(run.messages.length, 2); assert.equal(calls.length, 1);
  run.messages = Array.from({ length: 98 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', content: 'past', time: '2026-10-24T00:00:00.000Z' }));
  engine.chat(run.id, { message: '最后一个问题' }); await engine.wait(run.id);
  assert.equal(run.messages.length, 100);
  assert.throws(() => engine.chat(run.id, { message: '超过上限' }), /100 条上限/);
  engine.approve(run.id, { assignments: assignmentsOf(run) });
  assert.throws(() => engine.chat(run.id, { message: '执行期间不能改' }), /仅在等待确认分配/);
  await engine.wait(run.id);
  assert.throws(() => engine.chat(run.id, { message: '已经完成' }), /仅在等待确认分配/);
});

test('context is bounded in message count and character count with the newest instruction included', async () => {
  const { engine, run, calls } = await prepared();
  run.messages = Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'x'.repeat(11997), time: '2026-10-24T00:00:00.000Z' }));
  engine.chat(run.id, { message: '当前明确的指令' }); await engine.wait(run.id);
  const context = calls.at(-1).request.messages;
  assert.ok(context.length <= 12);
  assert.ok(context.reduce((sum, item) => sum + item.content.length, 0) <= 24000);
  assert.ok(context.every(item => item.content.length <= 6000));
  assert.equal(context.at(-1).content, '当前明确的指令');
});

test('legacy runs without messages can use routing and receive a lazily initialized goal', async () => {
  const { engine, run } = await prepared();
  delete run.messages; delete run.chatBusy; delete run.chatError; delete run.routingRevision;
  engine.chat(run.id, { message: '交给 Nova' }); await engine.wait(run.id);
  assert.equal(run.messages[0].content, run.goal); assert.equal(run.messages[0].role, 'user');
  assert.equal(run.messages.length, 3); assert.equal(run.routingRevision, 1); assert.equal(run.chatBusy, false);
});

test('restart recovers interrupted chat while preserving completed and awaiting-approval statuses', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-chat-recovery-'));
  t.after(() => { const resolved = join(tmpdir(), 'agent-chat-recovery-'); assert.ok(directory.startsWith(resolved)); rmSync(directory, { recursive: true, force: true }); });
  const { run } = await prepared();
  const old = structuredClone(run); delete old.messages; delete old.chatBusy; delete old.chatError;
  old.id = 'legacy';
  const busy = { ...structuredClone(run), id: 'busy', chatBusy: true };
  const completed = { ...structuredClone(run), id: 'done', status: 'completed', chatBusy: true, summary: 'Finished previously' };
  const file = join(directory, 'state.json');
  writeFileSync(file, JSON.stringify({ version: 1, agents: [], runs: [busy, completed, old] }));
  const restarted = new Store(file);
  assert.equal(restarted.state.runs[0].status, 'awaiting_approval');
  assert.equal(restarted.state.runs[0].chatBusy, false); assert.match(restarted.state.runs[0].chatError, /重启打断/);
  assert.equal(restarted.state.runs[0].messages.at(-1).role, 'assistant');
  assert.equal(restarted.state.runs[1].status, 'completed'); assert.equal(restarted.state.runs[1].summary, completed.summary);
  assert.equal(restarted.state.runs[2].messages[0].content, run.goal); assert.equal(restarted.state.runs[2].chatBusy, false);
  const twice = new Store(file);
  assert.equal(twice.state.runs[0].messages.length, restarted.state.runs[0].messages.length);
});
