import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, validatePlan, validateReview, validateAgent } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';

const task = (id = 'a', options = {}) => ({ id, title: id, description: 'Write a specific deliverable', complexity: 1, risk: 'low', requiredSkills: ['writing'], dependencies: [], acceptance: ['Contains evidence'], ...options });
const plan = [task(), task('hard', { complexity: 3, dependencies: ['a'] })];
function provider({ fail = 0, tasks = plan, calls = [] } = {}) {
  let attempts = 0;
  return async (agent, request) => {
    calls.push({ id: agent.id, phase: request.phase, task: request.task?.id });
    if (request.phase === 'plan') return { data: { tasks } };
    if (request.phase === 'execute') return { data: { content: request.task.id === 'a' && attempts++ < fail ? 'bad' : 'Evidence with complete deliverable' } };
    if (request.phase === 'review') return { data: { passed: request.output !== 'bad', feedback: request.output === 'bad' ? 'Need evidence' : 'Reviewed evidence', criteria: request.task.acceptance.map(c => ({ criterion: c, passed: request.output !== 'bad', evidence: 'Compared deliverable to criterion' })) } };
    return { data: { content: 'Final consolidated deliverable' } };
  };
}
async function prepared(p = provider(), opts = {}) {
  const e = new Engine(new Store(), p);
  const r = e.createRun({ goal: 'Create a useful plan', leadAgentId: 'demo-lead', ...opts });
  await e.wait(r.id);
  return { e, r, assignments: r.tasks.map(t => ({ taskId: t.id, agentId: t.suggestedAgentId })) };
}

test('plans then waits for human selection, executes DAG and synthesizes only accepted work', async () => {
  const calls = [];
  const { e, r, assignments } = await prepared(provider({ calls }));
  assert.equal(r.status, 'awaiting_approval'); assert.equal(calls.length, 1);
  assert.equal(r.tasks[0].suggestedAgentId, 'demo-light');
  assert.equal(r.tasks[1].suggestedAgentId, 'demo-lead');
  e.approve(r.id, { assignments }); await e.wait(r.id);
  assert.equal(r.status, 'completed'); assert.equal(r.callsUsed, 6);
  assert.ok(r.tasks.every(t => t.status === 'passed'));
  assert.ok(calls.findIndex(c => c.phase === 'review' && c.task === 'a') < calls.findIndex(c => c.phase === 'execute' && c.task === 'hard'));
});

test('two rejected worker attempts escalate to the lead, all attempts retained', async () => {
  const { e, r, assignments } = await prepared(provider({ fail: 2 }));
  e.approve(r.id, { assignments }); await e.wait(r.id);
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.tasks[0].attempts.map(a => a.agentId), ['demo-light', 'demo-light', 'demo-lead']);
  assert.equal(r.tasks[0].attempts[0].review.passed, false);
});

test('persistent failure requires attention and blocks dependencies', async () => {
  const { e, r, assignments } = await prepared(provider({ fail: 99 }));
  e.approve(r.id, { assignments }); await e.wait(r.id);
  assert.equal(r.status, 'needs_attention');
  assert.equal(r.tasks[0].output, ''); assert.equal(r.tasks[1].status, 'blocked'); assert.equal(r.summary, '');
});

test('budget counts planning, workers, reviews and summary; never exceeds cap', async () => {
  const { e, r, assignments } = await prepared(provider({ fail: 1 }), { maxCalls: 5 });
  e.approve(r.id, { assignments }); await e.wait(r.id);
  assert.equal(r.status, 'needs_attention'); assert.equal(r.callsUsed, 5); assert.equal(r.summary, '');
});

test('approval validates entire input before mutating and rejects double approval', async () => {
  const { e, r, assignments } = await prepared();
  assert.throws(() => e.approve(r.id, { assignments: [{ taskId: 'a', agentId: 'demo-light' }, { taskId: 'hard', agentId: 'demo-light' }] }));
  assert.equal(r.status, 'awaiting_approval'); assert.ok(r.tasks.every(t => !t.agentId));
  assert.throws(() => e.approve(r.id, { assignments: [assignments[0], assignments[0]] }));
  e.approve(r.id, { assignments }); assert.throws(() => e.approve(r.id, { assignments }));
  await e.wait(r.id);
});

test('cancel discards late model output even if provider ignores AbortSignal', async () => {
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const base = provider();
  const delayed = async (agent, request) => {
    if (request.phase === 'execute') { started(); await new Promise(resolve => { release = resolve; }); }
    return base(agent, request);
  };
  const { e, r, assignments } = await prepared(delayed);
  e.approve(r.id, { assignments }); await startedPromise;
  e.cancel(r.id); release(); await e.wait(r.id);
  assert.equal(r.status, 'cancelled'); assert.equal(r.tasks[0].output, ''); assert.equal(r.summary, '');
});

test('strict plan and review validation reject cycles, unknown dependencies and false success', () => {
  assert.throws(() => validatePlan({ tasks: [task('a', { dependencies: ['a'] })] }));
  assert.throws(() => validatePlan({ tasks: [task('a', { dependencies: ['missing'] })] }));
  assert.throws(() => validatePlan({ tasks: [task('a'), task('a')] }));
  assert.throws(() => validateReview({ passed: true, feedback: 'ok', criteria: [] }, task()));
  const review = validateReview({ passed: true, feedback: 'ok', criteria: [{ criterion: 'Contains evidence', passed: false, evidence: 'Missing' }] }, task());
  assert.equal(review.passed, false);
});

test('secrets belong in environment names and API endpoints reject credentials', () => {
  const a = { name: 'API Agent', provider: 'openai-compatible', model: 'model-name', tier: 2, skills: ['general'], baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'API_KEY' };
  assert.equal(validateAgent(a).apiKeyEnv, 'API_KEY');
  assert.throws(() => validateAgent({ ...a, baseUrl: 'https://user:secret@api.example.com/v1' }));
  assert.throws(() => validateAgent({ ...a, baseUrl: 'http://api.example.com/v1' }));
  assert.throws(() => validateAgent({ ...a, apiKeyEnv: 'sk-secret' }));
});

test('concurrent ready tasks reserve budget atomically and still respect dependencies', async () => {
  const { e, r, assignments } = await prepared(provider({ tasks: [task('a'), task('b'), task('c')] }), { maxCalls: 5, concurrency: 3 });
  e.approve(r.id, { assignments }); await e.wait(r.id);
  assert.equal(r.callsUsed, 5); assert.equal(r.status, 'needs_attention');
});

test('real runs cannot receive demo results', async () => {
  const { e, r } = await prepared();
  e.addAgent({ name: 'API agent', provider: 'openai-compatible', model: 'm', tier: 3, skills: ['*'], baseUrl: 'https://example.com/v1' });
  assert.equal(r.agentSnapshots.some(a => a.provider !== 'demo'), false);
});

test('failed Agent persistence rolls back memory and retry adds exactly one Agent', () => {
  const store = new Store();
  const engine = new Engine(store);
  const original = structuredClone(store.state.agents);
  const failure = new Error('simulated disk write failure');
  let fail = true;
  store.save = () => { if (fail) throw failure; };
  const input = { name: '本机 CLI', provider: 'cli', model: 'model-small', tier: 2, skills: ['coding'], cliProfile: 'local-test-cli' };

  assert.throws(() => engine.addAgent(input), error => error === failure);
  assert.deepEqual(engine.state.agents, original, 'a failed save must leave no phantom Agent or remove existing Agents');

  fail = false;
  const added = engine.addAgent(input);
  assert.equal(engine.state.agents.length, original.length + 1);
  assert.equal(engine.state.agents.filter(agent => agent.id === added.id).length, 1);
  assert.equal(engine.state.agents.filter(agent => agent.cliProfile === input.cliProfile).length, 1);
  assert.deepEqual(engine.state.agents.slice(0, original.length), original);
});
