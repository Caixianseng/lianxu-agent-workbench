import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callAgent, createProviderClient } from '../src/providers.mjs';

async function fixture(t, answer, inspect = () => {}) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    inspect(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { provider: 'openai-compatible', model: 'test-model', baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('routing projects user messages and candidate identity without private profile fields', async t => {
  const answer = { reply: '分工建议已更新，确认后才执行。', assignments: [{ taskId: 'task-a', agentId: 'worker' }] };
  let context;
  const agent = await fixture(t, answer, body => {
    assert.match(body.messages[1].content, /displayId/);
    assert.match(body.messages[1].content, /不唯一/);
    context = JSON.parse(body.messages[1].content.split('输入数据：\n')[1]);
  });
  const result = await createProviderClient().callAgent(agent, {
    phase: 'route', goal: '整理资料', message: 'T01 交给 @工具（model-small）', leadAgentId: 'lead',
    tasks: [{ id: 'task-a', displayId: 'T01', title: '整理', complexity: 1, risk: 'low', requiredSkills: [] }],
    agents: [{ id: 'worker', name: '工具', model: 'model-small', tier: 2, skills: ['writing'], command: 'private-command', apiKey: 'private-key' }],
    messages: [{ role: 'user', content: '保持其他分工', privateMetadata: 'private-value' }],
  });
  assert.deepEqual(result.data, answer);
  assert.equal(context.message, 'T01 交给 @工具（model-small）');
  assert.deepEqual(context.messages, [{ role: 'user', content: '保持其他分工' }]);
  assert.deepEqual(context.agents, [{ id: 'worker', name: '工具', model: 'model-small', tier: 2, skills: ['writing'] }]);
  assert.ok(!JSON.stringify(context).includes('private-'));
});

test('routing rejects incomplete structured output instead of treating it as a reply', async t => {
  for (const answer of [{ reply: '已完成' }, { assignments: [] }, { reply: '', assignments: [] }, { reply: 'x'.repeat(6001), assignments: [] }]) {
    const agent = await fixture(t, answer);
    await assert.rejects(createProviderClient().callAgent(agent, { phase: 'route', message: '调整分工' }), /分工回复/);
  }
});

test('demo routing resolves explicit task numbers and models and clarifies ambiguous or ineligible instructions', async () => {
  const agents = [
    { id: 'lead', name: '主导', model: 'demo-lead', provider: 'demo', tier: 3, skills: ['*'] },
    { id: 'worker', name: '执行者', model: 'demo-small', provider: 'demo', tier: 1, skills: ['writing'] },
    { id: 'other', name: '执行者', model: 'demo-large', provider: 'demo', tier: 2, skills: ['writing'] },
  ];
  const tasks = [{ id: 'task-a', title: '写摘要', complexity: 1, risk: 'low', requiredSkills: ['writing'] }, { id: 'task-b', title: '架构', complexity: 3, risk: 'high', requiredSkills: [] }];
  const request = { phase: 'route', goal: '演示', agents, tasks, leadAgentId: 'lead' };
  const result = await callAgent(agents[0], { ...request, message: 'T01 交给 @执行者（demo-large）；T02 交给 @主导（demo-lead）' });
  assert.deepEqual(result.data.assignments, [{ taskId: 'task-a', agentId: 'other' }, { taskId: 'task-b', agentId: 'lead' }]);
  for (const message of ['T01 交给 @执行者', 'T01 交给 @未配置', 'T02 交给 @执行者（demo-large）', 'T01 交给 @执行者（demo-small）；T01 交给 @执行者（demo-large）']) {
    assert.deepEqual((await callAgent(agents[0], { ...request, message })).data.assignments, []);
  }
});
