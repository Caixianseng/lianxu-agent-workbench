import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAgent, createProviderClient, parseAgentJson } from '../src/providers.mjs';

const demoLead = { provider: 'demo', name: 'Lead', model: 'demo', tier: 3 };
const request = { phase: 'execute', goal: '实现测试目标', task: { title: '测试任务', acceptance: ['检查输入'] } };

async function serverFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

async function cliFixture(t, source, options = {}) {
  const directory = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.agent-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'fixture.mjs');
  const configPath = path.join(directory, 'profiles.json');
  await writeFile(script, source);
  await writeFile(configPath, JSON.stringify({ profiles: [{ id: 'fixture', name: 'Fixture', command: process.execPath, args: [script, '{model}'], outputFormat: options.format || 'json', envAllowList: ['FIXTURE_API_KEY'], ...options.profile }] }));
  const client = createProviderClient({ configPath, env: { ...process.env, FIXTURE_API_KEY: 'private-fixture-secret', UNRELATED_DATABASE_SECRET: 'must-not-inherit' }, ...options.client });
  return { client, agent: { provider: 'cli', model: 'fixture model; & $(never-executed)', cliProfile: 'fixture' }, directory };
}

test('JSON protocol accepts fenced objects and rejects arrays, prose and malformed JSON', () => {
  assert.deepEqual(parseAgentJson('```json\n{"content":"ok"}\n```'), { content: 'ok' });
  for (const text of ['[]', 'null', 'here {"content":"ok"}', '{broken}']) assert.throws(() => parseAgentJson(text), /JSON/);
});

test('demo plans dependencies and catches a failed economical attempt before repair', async () => {
  const { data: plan } = await callAgent(demoLead, { phase: 'plan', goal: '测试目标' });
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.tasks.at(-1).complexity, 3);
  const task = plan.tasks[0];
  const worker = { ...demoLead, tier: 1 };
  const first = await callAgent(worker, { ...request, task, demoFailure: true, attempt: 1 });
  const rejected = await callAgent(demoLead, { phase: 'review', task, output: first.data });
  assert.equal(rejected.data.passed, false);
  assert.equal(rejected.data.criteria.length, task.acceptance.length);
  const repaired = await callAgent(worker, { ...request, task, demoFailure: true, attempt: 2, feedback: rejected.data.feedback });
  const accepted = await callAgent(demoLead, { phase: 'review', task, output: repaired.data.content });
  assert.equal(accepted.data.passed, true);
  assert.ok(accepted.data.criteria.every(item => item.evidence.includes(item.criterion)));
});

test('pre-cancelled calls never invoke the provider', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(callAgent(demoLead, request, { signal: controller.signal }), { name: 'AbortError' });
});

test('API POST preserves model choice, handles fenced output and only returns numeric usage', async t => {
  const baseUrl = await serverFixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer mock-private-key');
    let body = '';
    for await (const part of req) body += part;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, 'user-selected-model');
    assert.equal(parsed.messages[0].role, 'system');
    assert.equal(parsed.stream, false);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"content":"mock-private-key 已完成"}\n```' } }], usage: { total_tokens: 12, secret: 'mock-private-key' } }));
  });
  const client = createProviderClient({ env: { TEST_API_KEY: 'mock-private-key' } });
  const result = await client.callAgent({ provider: 'openai-compatible', model: 'user-selected-model', baseUrl, apiKeyEnv: 'TEST_API_KEY' }, request);
  assert.equal(result.data.content, '[已隐藏] 已完成');
  assert.deepEqual(result.usage, { total_tokens: 12 });
});

test('API failures hide response bodies, URL credentials and network exception messages', async t => {
  const baseUrl = await serverFixture(t, (_req, res) => { res.writeHead(401); res.end('secret-returned-by-provider'); });
  const agent = { provider: 'openai-compatible', model: 'test', baseUrl };
  await assert.rejects(createProviderClient().callAgent(agent, request), error => /401/.test(error.message) && !error.message.includes('secret-returned'));
  await assert.rejects(createProviderClient().callAgent({ ...agent, baseUrl: 'https://secret:pass@example.com' }, request), error => !error.message.includes('secret:pass'));
  await assert.rejects(createProviderClient({ fetchImpl: async () => { throw new Error('token-should-not-leak'); } }).callAgent(agent, request), error => !error.message.includes('token-should-not-leak'));
});

test('planning identifies the selected lead and restricts high-risk tasks to its capabilities', async () => {
  let context;
  let instructions;
  const client = createProviderClient({ fetchImpl: async (_url, options) => {
    const message = JSON.parse(options.body).messages[1].content;
    [instructions, context] = message.split('输入数据：\n');
    context = JSON.parse(context);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ id: 'simple', title: '简单工作', complexity: 1 }] }) } }] }));
  } });
  await client.callAgent({ provider: 'openai-compatible', model: 'test', baseUrl: 'https://example.com/v1' }, {
    phase: 'plan', goal: '整理一份清单', leadAgentId: 'lead-balanced',
    agents: [{ id: 'worker-powerful', tier: 3, skills: ['research'] }, { id: 'lead-balanced', tier: 2, skills: ['writing'], apiKeyEnv: 'PRIVATE_ENV_NAME', baseUrl: 'https://private.example' }],
  });
  assert.equal(context.leadAgentId, 'lead-balanced');
  assert.deepEqual(context.agents[1].skills, ['writing']);
  assert.ok(!Object.hasOwn(context.agents[1], 'apiKeyEnv'));
  assert.ok(!Object.hasOwn(context.agents[1], 'baseUrl'));
  assert.match(instructions, /requiredSkills 必须全部由该主导具备/);
  assert.match(instructions, /简单目标不必包含复杂度 3/);
});

test('API refuses redirects instead of forwarding credentials', async t => {
  let redirected = false;
  const baseUrl = await serverFixture(t, (req, res) => {
    if (req.url === '/leak') redirected = true;
    res.writeHead(302, { Location: '/leak' }); res.end();
  });
  await assert.rejects(createProviderClient().callAgent({ provider: 'openai-compatible', model: 'test', baseUrl }, request));
  assert.equal(redirected, false);
});

test('API enforces timeout, cancellation, response size and valid content shape', async t => {
  const never = await serverFixture(t, () => {});
  const agent = { provider: 'openai-compatible', model: 'test', baseUrl: never };
  await assert.rejects(createProviderClient({ timeoutMs: 50 }).callAgent(agent, request), /超时/);
  const controller = new AbortController();
  const pending = createProviderClient().callAgent(agent, request, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
  const large = await serverFixture(t, (_req, res) => res.end('x'.repeat(2000)));
  await assert.rejects(createProviderClient({ maxBytes: 100 }).callAgent({ ...agent, baseUrl: large }, request), /大小限制/);
  const wrong = await serverFixture(t, (_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"irrelevant":true}' } }] })));
  await assert.rejects(createProviderClient().callAgent({ ...agent, baseUrl: wrong }, request), /content/);
});

test('CLI passes model as a single argv, prompt via stdin and only allowlisted secrets', async t => {
  const { client, agent } = await cliFixture(t, `let input=''; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({content:JSON.stringify({model:process.argv[2],hasGoal:input.includes('实现测试目标'),secret:process.env.FIXTURE_API_KEY,unrelated:process.env.UNRELATED_DATABASE_SECRET || null})}));`);
  const profiles = await client.getCliProfiles();
  assert.equal(profiles.find(profile => profile.id === 'fixture').available, true);
  assert.ok(!JSON.stringify(profiles).includes('private-fixture-secret'));
  const result = await client.callAgent(agent, request);
  const content = JSON.parse(result.data.content);
  assert.equal(content.model, agent.model);
  assert.equal(content.hasGoal, true);
  assert.equal(content.secret, '[已隐藏]');
  assert.equal(content.unrelated, null);
});

test('Codex JSONL and Claude JSON results are extracted, upstream error records reject', async t => {
  const codex = await cliFixture(t, `process.stdin.resume(); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({content:'codex fixture'})}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:3}}));`, { format: 'codex-jsonl' });
  const result = await codex.client.callAgent(codex.agent, request);
  assert.equal(result.data.content, 'codex fixture');
  assert.equal(result.usage.input_tokens, 5);
  const claude = await cliFixture(t, `process.stdin.resume(); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({content:'claude fixture'})}));`, { format: 'claude-json' });
  assert.equal((await claude.client.callAgent(claude.agent, request)).data.content, 'claude fixture');
  const error = await cliFixture(t, `process.stdin.resume(); console.log(JSON.stringify({type:'turn.failed',error:{message:'private-fixture-secret'}}));`, { format: 'codex-jsonl' });
  await assert.rejects(error.client.callAgent(error.agent, request), err => /Codex CLI/.test(err.message) && !err.message.includes('private-fixture-secret'));
});

test('Codex reconnect errors can recover with a final reply and successful completion', async t => {
  const events = [
    { type: 'thread.started', thread_id: 'test-thread' },
    { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... private-fixture-secret' },
    { type: 'error', message: 'Reconnecting... (os error 10054)' },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"content":"recovered reply"}' } },
    { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 4 } },
  ];
  const f = await cliFixture(t, `process.stdin.resume();for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`, { format: 'codex-jsonl' });
  const result = await f.client.callAgent(f.agent, request);
  assert.equal(result.data.content, 'recovered reply');
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 4 });
});

test('Codex requires the latest turn to complete and never reuses a previous reply or exposes errors', async t => {
  const reply = { type: 'item.completed', item: { type: 'agent_message', text: '{"content":"old reply"}' } };
  const complete = { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } };
  const reconnect = { type: 'error', message: 'private-fixture-secret' };
  const failed = { type: 'turn.failed', error: { message: 'private-fixture-secret' } };
  const sequences = [
    [reconnect],
    [reply],
    [reconnect, reply],
    [reply, complete, reconnect],
    [reply, complete, reconnect, complete],
    [reply, complete, { type: 'turn.started' }],
    [reply, complete, { type: 'turn.started' }, reconnect],
    [reply, complete, { type: 'turn.started' }, complete],
    [reply, complete, { type: 'turn.started' }, reply],
    [reply, complete, failed],
    [failed, reply, complete],
  ];
  for (const events of sequences) {
    const f = await cliFixture(t, `process.stdin.resume();for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`, { format: 'codex-jsonl' });
    await assert.rejects(f.client.callAgent(f.agent, request), error => /Codex CLI/.test(error.message) && !error.message.includes('private-fixture-secret'));
  }
  const events = [reply, complete, { type: 'turn.started' }, reconnect,
    { type: 'item.completed', item: { type: 'agent_message', text: '{"content":"new reply"}' } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }];
  const f = await cliFixture(t, `process.stdin.resume();for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`, { format: 'codex-jsonl' });
  const result = await f.client.callAgent(f.agent, request);
  assert.equal(result.data.content, 'new reply');
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
});

test('CLI stderr and non-zero exit do not leak secrets', async t => {
  const { client, agent } = await cliFixture(t, `process.stdin.resume(); console.error(process.env.FIXTURE_API_KEY); process.exitCode=7;`);
  await assert.rejects(client.callAgent(agent, request), error => /7/.test(error.message) && !error.message.includes('private-fixture-secret'));
});

test('CLI bounded output kills a runaway writer', async t => {
  const { client, agent } = await cliFixture(t, `process.stdin.resume(); setInterval(()=>process.stdout.write('x'.repeat(5000)),10);`, { client: { maxBytes: 1000 } });
  await assert.rejects(client.callAgent(agent, request), /大小限制/);
});

test('CLI timeout and cancellation terminate the worker and its descendant process', async t => {
  const { client, agent, directory } = await cliFixture(t, `import {writeFileSync} from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url'; import {spawn} from 'node:child_process'; const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'pid'),JSON.stringify([process.pid,descendant.pid])); process.stdin.resume(); setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = client.callAgent(agent, request, { signal: controller.signal });
  pending.catch(() => {});
  let pids;
  for (let i = 0; i < 100; i++) {
    try { pids = JSON.parse(await readFile(path.join(directory, 'pid'), 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(pids?.length, 2, 'fixture and descendant should launch');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const timeout = await cliFixture(t, 'process.stdin.resume(); setInterval(()=>{},1000);', { client: { timeoutMs: 100 } });
  await assert.rejects(timeout.client.callAgent(timeout.agent, request), /超时/);
});

test('unknown profile, shell shim and missing environment names fail closed', async t => {
  const { client, agent } = await cliFixture(t, 'process.stdin.resume();');
  await assert.rejects(client.callAgent({ ...agent, cliProfile: 'not-configured' }, request), /不存在/);
  const shim = await cliFixture(t, '', { profile: { command: 'claude.cmd' } });
  await assert.rejects(shim.client.getCliProfiles(), /原生可执行/);
  await assert.rejects(createProviderClient({ env: {} }).callAgent({ provider: 'openai-compatible', model: 'test', baseUrl: 'https://example.com/v1', apiKeyEnv: 'ABSENT_KEY' }, request), /ABSENT_KEY/);
});

test('OpenCode JSONL aggregates text events while errors and tool attempts reject', async t => {
  const f = await cliFixture(t, `process.stdin.resume();console.log(JSON.stringify({type:'step_start'}));console.log(JSON.stringify({type:'text',part:{text:'{"content":'}}));console.log(JSON.stringify({type:'text',part:{text:'"OpenCode result"}'}}));console.log(JSON.stringify({type:'step_finish'}));`, { format: 'opencode-jsonl' });
  assert.equal((await f.client.callAgent(f.agent, request)).data.content, 'OpenCode result');
  for (const type of ['error', 'tool_use', 'permission']) {
    const rejected = await cliFixture(t, `process.stdin.resume();console.log(JSON.stringify({type:'${type}',error:'private-fixture-secret'}));`, { format: 'opencode-jsonl' });
    await assert.rejects(rejected.client.callAgent(rejected.agent, request), error => /OpenCode/.test(error.message) && !error.message.includes('private-fixture-secret'));
  }
});

test('Qoder JSON result supports structured content and rejects model failures', async t => {
  const f = await cliFixture(t, `process.stdin.resume();console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{"content":"Qoder result"}'}));`, { format: 'qoder-json' });
  assert.equal((await f.client.callAgent(f.agent, request)).data.content, 'Qoder result');
  const rejected = await cliFixture(t, `process.stdin.resume();console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'private-fixture-secret'}));`, { format: 'qoder-json' });
  await assert.rejects(rejected.client.callAgent(rejected.agent, request), /Qoder CLI/);
});
