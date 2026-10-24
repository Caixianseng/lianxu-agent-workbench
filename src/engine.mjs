import { randomUUID } from 'node:crypto';
import { callAgent } from './providers.mjs';
import { activeStatuses } from './store.mjs';

const now = () => new Date().toISOString();
export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
class BudgetError extends Error {}
const requireInput = (condition, message) => { if (!condition) throw new InputError(message); };
const text = (value, max = 6000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const stringList = (value, max = 20) => Array.isArray(value) && value.length <= max && value.every(x => text(x, 500));
const modesMatch = (a, b) => (a.provider === 'demo') === (b.provider === 'demo');
const messageEntry = (role, content) => ({ id: randomUUID(), role, content, time: now() });
const messagesOf = run => {
  if (!Array.isArray(run.messages)) run.messages = [messageEntry('user', run.goal)];
  return run.messages;
};
function chatContext(messages) {
  const recent = [];
  let remaining = 24000;
  for (const item of messages.slice(-12).reverse()) {
    if (!['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue;
    const content = item.content.slice(0, Math.min(6000, remaining));
    if (content) recent.unshift({ role: item.role, content });
    remaining -= content.length;
    if (!remaining) break;
  }
  return recent;
}

export function validateAgent(input) {
  requireInput(input && typeof input === 'object', 'Agent 配置无效');
  requireInput(text(input.name, 80) && text(input.model, 160), '请填写 Agent 名称和模型 ID');
  requireInput(['demo', 'openai-compatible', 'cli'].includes(input.provider), '未知接入方式');
  requireInput([1, 2, 3].includes(input.tier), '能力等级必须为 1、2 或 3');
  requireInput(stringList(input.skills) && input.skills.length > 0, '至少填写一个技能标签');
  const agent = { id: randomUUID(), name: input.name.trim(), provider: input.provider, model: input.model.trim(), tier: input.tier, skills: [...new Set(input.skills.map(x => x.trim()))] };
  if (input.provider === 'openai-compatible') {
    let url;
    try { url = new URL(input.baseUrl); } catch { throw new InputError('API Base URL 无效'); }
    requireInput(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), '远程 API 必须使用 HTTPS，本地接口可使用 HTTP');
    requireInput(!url.username && !url.password && !url.search && !url.hash, 'API URL 不能包含凭据、查询参数或锚点');
    requireInput(!input.apiKeyEnv || (typeof input.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(input.apiKeyEnv)), '请填写密钥的环境变量名称，不要填写密钥本身');
    agent.baseUrl = url.href.replace(/\/$/, '');
    agent.apiKeyEnv = input.apiKeyEnv || '';
  }
  if (input.provider === 'cli') {
    requireInput(text(input.cliProfile, 80) && /^[\w-]+$/.test(input.cliProfile), '请选择 CLI 配置');
    agent.cliProfile = input.cliProfile;
  }
  return agent;
}

export function validatePlan(data) {
  requireInput(data && Array.isArray(data.tasks) && data.tasks.length >= 1 && data.tasks.length <= 8, '主导规划必须包含 1–8 个任务');
  const ids = new Set();
  const tasks = data.tasks.map(t => {
    requireInput(t && typeof t === 'object', '任务格式无效');
    requireInput(text(t.id, 80) && /^[\w-]+$/.test(t.id) && !ids.has(t.id), '任务 ID 必须唯一，且仅包含字母、数字、下划线或短横线');
    ids.add(t.id);
    requireInput(text(t.title, 200) && text(t.description), '任务缺少标题或说明');
    requireInput([1, 2, 3].includes(t.complexity) && ['low', 'medium', 'high'].includes(t.risk), '任务复杂度或风险等级无效');
    requireInput(stringList(t.requiredSkills) && stringList(t.dependencies, 8), '任务技能或依赖格式无效');
    requireInput(stringList(t.acceptance, 10) && t.acceptance.length > 0 && new Set(t.acceptance).size === t.acceptance.length, '每项任务需要 1–10 条不重复的验收标准');
    requireInput(new Set(t.dependencies).size === t.dependencies.length, '任务依赖不能重复');
    requireInput(t.preferredAgentId === undefined || text(t.preferredAgentId, 80), '指定的 Agent ID 必须是非空字符串');
    return { id: t.id, title: t.title, description: t.description, complexity: t.complexity, risk: t.risk, requiredSkills: t.requiredSkills, dependencies: t.dependencies, acceptance: t.acceptance, ...(t.preferredAgentId === undefined ? {} : { preferredAgentId: t.preferredAgentId }), status: 'pending', attempts: [], output: '', review: null, error: '' };
  });
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    requireInput(byId.has(id), `未知依赖任务：${id}`);
    requireInput(!visiting.has(id), '任务依赖形成循环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  tasks.forEach(t => visit(t.id));
  return tasks;
}

export function eligible(agent, task, lead) {
  if (!modesMatch(agent, lead)) return false;
  if (agent.tier < task.complexity || !task.requiredSkills.every(s => agent.skills.includes(s) || agent.skills.includes('*'))) return false;
  if (task.complexity === 3 || task.risk === 'high') return agent.id === lead.id;
  return true;
}

export function validateReview(data, task) {
  if (!data || typeof data.passed !== 'boolean' || !text(data.feedback, 12000) || !Array.isArray(data.criteria) || data.criteria.length !== task.acceptance.length) throw new Error('审查结果格式无效或未覆盖所有验收条件');
  const seen = new Set();
  for (const item of data.criteria) {
    if (!item || !task.acceptance.includes(item.criterion) || seen.has(item.criterion) || typeof item.passed !== 'boolean' || !text(item.evidence, 6000)) throw new Error('审查结果缺少逐项验收依据');
    seen.add(item.criterion);
  }
  return { passed: data.passed && data.criteria.every(c => c.passed), feedback: data.feedback, criteria: data.criteria.map(c => ({ criterion: c.criterion, passed: c.passed, evidence: c.evidence })) };
}

function contentOf(data) {
  if (!data || !text(data.content, 60000)) throw new Error('模型产物为空、格式无效或超过 60000 字符');
  return data.content;
}

export class Engine {
  constructor(store, provider = callAgent) { this.store = store; this.provider = provider; this.jobs = new Map(); this.controllers = new Map(); }
  get state() { return this.store.state; }
  persist(run) { run.updatedAt = now(); this.store.save(); }
  event(run, type, message, taskId) {
    run.events.push({ id: randomUUID(), time: now(), type, message, ...(taskId ? { taskId } : {}) });
    this.persist(run);
  }
  getRun(id) { const run = this.state.runs.find(r => r.id === id); if (!run) throw new InputError('运行不存在', 404); return run; }
  addAgent(input) {
    const a = validateAgent(input);
    this.state.agents.push(a);
    try { this.store.save(); } catch (error) { this.state.agents = this.state.agents.filter(item => item.id !== a.id); throw error; }
    return a;
  }
  removeAgent(id) {
    requireInput(!this.state.runs.some(r => activeStatuses.has(r.status) && r.agentSnapshots.some(a => a.id === id)), '此 Agent 正被未结束的运行引用');
    requireInput(this.state.agents.some(a => a.id === id), 'Agent 不存在');
    this.state.agents = this.state.agents.filter(a => a.id !== id); this.store.save();
  }
  requireIdle() {
    requireInput(this.jobs.size === 0 && !this.state.runs.some(r => ['planning', 'running'].includes(r.status) || r.chatBusy), '已有运行正在调用模型，请等待当前请求结束后再继续');
  }
  launch(run, operation, { chat = false } = {}) {
    const controller = new AbortController(); this.controllers.set(run.id, controller);
    const job = Promise.resolve().then(() => operation(controller.signal)).catch(error => {
      if (run.status === 'cancelled') return;
      if (chat) {
        run.chatError = (typeof error?.message === 'string' ? error.message : '聊天请求失败，请重试').slice(0, 6000);
        messagesOf(run).push(messageEntry('assistant', `未更新任务分配：${run.chatError}`));
        this.event(run, 'chat_error', run.chatError);
        return;
      }
      run.status = run.status === 'planning' ? 'failed' : 'needs_attention';
      run.error = error.message;
      this.event(run, 'error', error.message);
    }).finally(() => {
      try { if (chat) { run.chatBusy = false; this.persist(run); } }
      finally { this.controllers.delete(run.id); this.jobs.delete(run.id); }
    });
    this.jobs.set(run.id, job);
  }
  async wait(id) { await this.jobs.get(id); }
  check(run, signal) { if (signal.aborted || run.status === 'cancelled') throw new Error('运行已取消'); }
  async invoke(run, agent, request, signal) {
    this.check(run, signal);
    if (run.callsUsed >= run.maxCalls) throw new BudgetError('模型调用次数已达上限，未继续提交新的请求');
    run.callsUsed += 1;
    const phaseName = { plan: '规划', route: '聊天分工', execute: '执行', review: '审查', synthesize: '汇总' }[request.phase] || request.phase;
    this.event(run, 'call', `${agent.name} · ${phaseName}（${run.callsUsed}/${run.maxCalls}）`, request.task?.id);
    const result = await this.provider(agent, { ...request, goal: run.goal, demoFailure: run.demoFailure }, { signal });
    this.check(run, signal);
    if (result.usage) { run.usage.push({ agentId: agent.id, phase: request.phase, usage: result.usage }); this.persist(run); }
    return result.data;
  }
  createRun(input) {
    requireInput(input && text(input.goal, 12000), '请填写项目目标（最多 12000 字符）');
    const lead = this.state.agents.find(a => a.id === input.leadAgentId);
    requireInput(lead, '请选择主导 Agent');
    const maxCalls = input.maxCalls ?? 40, concurrency = input.concurrency ?? 2;
    requireInput(Number.isInteger(maxCalls) && maxCalls >= 5 && maxCalls <= 200, '调用次数上限应为 5–200');
    requireInput(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, '并行数应为 1–4');
    this.requireIdle();
    const run = { id: randomUUID(), goal: input.goal.trim(), leadAgentId: lead.id, status: 'planning', createdAt: now(), updatedAt: now(), maxCalls, concurrency, demoFailure: input.demoFailure === true, callsUsed: 0, tasks: [], events: [], summary: '', question: '', error: '', usage: [], messages: [messageEntry('user', input.goal.trim())], chatBusy: false, chatError: '', routingRevision: 0, agentSnapshots: structuredClone(this.state.agents.filter(a => modesMatch(a, lead))) };
    this.state.runs.unshift(run);
    this.event(run, 'plan', `${lead.name} 正在拆解目标、定义依赖和验收条件`);
    this.launch(run, async signal => {
      const plan = await this.invoke(run, lead, { phase: 'plan', leadAgentId: lead.id, agents: run.agentSnapshots }, signal);
      requireInput(plan.reply === undefined || text(plan.reply, 6000), '主导的规划回复格式无效或超过 6000 字符');
      const tasks = validatePlan(plan);
      for (const task of tasks) {
        if (task.preferredAgentId !== undefined) {
          const specified = run.agentSnapshots.find(a => a.id === task.preferredAgentId);
          requireInput(specified, `任务“${task.title}”指定了不存在的 Agent，未自动替换。请明确使用已添加的 Agent。`);
          requireInput(eligible(specified, task, lead), `任务“${task.title}”指定的 ${specified.name} 不符合能力/技能要求；复杂或高风险任务须由主导负责，未自动替换。`);
          task.suggestedAgentId = specified.id;
          task.routingReason = `按目标中的指令指定 ${specified.name} · ${specified.model}，等待你确认`;
          continue;
        }
        const candidates = run.agentSnapshots.filter(a => eligible(a, task, lead)).sort((a, b) => a.tier - b.tier || (a.id === lead.id ? 1 : -1));
        requireInput(candidates.length > 0, `任务“${task.title}”没有符合能力/技能要求的模型，请补充 Agent 或选择能力更强、技能匹配的主导。`);
        task.suggestedAgentId = candidates[0].id;
        task.routingReason = task.complexity === 3 || task.risk === 'high' ? '复杂或高风险任务，由主导负责' : '按技能标签匹配，并优先建议满足能力等级的轻量模型；等级由用户配置';
      }
      run.tasks = tasks;
      run.status = 'awaiting_approval';
      run.question = '计划已准备好。你希望每项任务使用哪个 Agent / 模型？请确认下面的分配，之后我会调度执行并逐项审查。';
      run.messages.push(messageEntry('assistant', [plan.reply?.trim(), run.question].filter(Boolean).join('\n\n')));
      this.event(run, 'approval', run.question);
    });
    return run;
  }
  chat(id, input) {
    const run = this.getRun(id);
    requireInput(run.status === 'awaiting_approval', '仅在等待确认分配时可以聊天调整任务');
    this.requireIdle();
    requireInput(input && text(input.message, 6000), '请输入聊天内容（最多 6000 字符）');
    const messages = messagesOf(run);
    requireInput(messages.length <= 98, '此运行聊天记录已达 100 条上限，请新建运行');
    const lead = run.agentSnapshots.find(a => a.id === run.leadAgentId);
    requireInput(lead, '此运行缺少主导 Agent 快照，无法调整任务');
    const message = input.message.trim();
    messages.push(messageEntry('user', message));
    run.chatBusy = true; run.chatError = '';
    this.event(run, 'chat', '主导正在理解你的分工指令，完成后仍需确认分配');
    this.launch(run, async signal => {
      const data = await this.invoke(run, lead, {
        phase: 'route', message, leadAgentId: run.leadAgentId, agents: run.agentSnapshots,
        tasks: run.tasks.map((task, index) => ({ id: task.id, displayId: `T${String(index + 1).padStart(2, '0')}`, title: task.title, description: task.description, suggestedAgentId: task.suggestedAgentId, agentId: task.agentId, complexity: task.complexity, risk: task.risk, requiredSkills: task.requiredSkills, acceptance: task.acceptance })),
        messages: chatContext(messages)
      }, signal);
      requireInput(data && text(data.reply, 6000) && Array.isArray(data.assignments) && data.assignments.length <= run.tasks.length, '主导聊天回复格式无效，任务分配未更新');
      const assignments = new Map();
      for (const item of data.assignments) {
        requireInput(item && text(item.taskId, 80) && text(item.agentId, 80) && !assignments.has(item.taskId), '聊天分配包含重复或无效的任务 ID');
        const task = run.tasks.find(t => t.id === item.taskId), agent = run.agentSnapshots.find(a => a.id === item.agentId);
        requireInput(task && agent, '聊天分配引用了未知任务或 Agent，任务分配未更新');
        requireInput(eligible(agent, task, lead), '聊天分配无效：模型能力或技能不匹配，复杂/高风险任务须由主导负责，任务分配未更新');
        assignments.set(task.id, agent);
      }
      this.check(run, signal);
      if (assignments.size) run.routingRevision = (run.routingRevision || 0) + 1;
      for (const task of run.tasks) {
        const agent = assignments.get(task.id);
        if (agent) {
          task.suggestedAgentId = agent.id;
          task.routingReason = `按聊天指令指定 ${agent.name} · ${agent.model}，等待你确认`;
          task.routingRevision = run.routingRevision;
        }
      }
      messages.push({ ...messageEntry('assistant', data.reply.trim()), assignments: [...assignments].map(([taskId, agent]) => ({ taskId, agentId: agent.id })) });
      this.event(run, 'chat_reply', assignments.size ? `主导已更新 ${assignments.size} 项建议分配，等待你确认` : '主导已回复，当前建议分配保持不变');
    }, { chat: true });
    return run;
  }
  approve(id, input) {
    const run = this.getRun(id);
    requireInput(run.status === 'awaiting_approval', '此运行当前不能确认分配');
    this.requireIdle();
    requireInput(input && Array.isArray(input.assignments) && input.assignments.length === run.tasks.length, '必须为每项任务确认一个模型');
    const lead = run.agentSnapshots.find(a => a.id === run.leadAgentId);
    const assignments = new Map();
    for (const item of input.assignments) {
      requireInput(item && !assignments.has(item.taskId), '任务分配不能重复');
      const task = run.tasks.find(t => t.id === item.taskId), agent = run.agentSnapshots.find(a => a.id === item.agentId);
      requireInput(task && agent && eligible(agent, task, lead), '分配无效：模型能力或技能不匹配，复杂/高风险任务须由主导负责');
      assignments.set(task.id, agent.id);
    }
    requireInput(run.tasks.every(t => assignments.has(t.id)), '缺少任务分配');
    // Commit only after every assignment passes validation.
    for (const task of run.tasks) task.agentId = assignments.get(task.id);
    run.status = 'running'; run.question = '';
    this.event(run, 'start', '模型分配已确认，开始执行。每项产物需经主导逐条审查。');
    this.launch(run, signal => this.execute(run, lead, signal));
    return run;
  }
  cancel(id) {
    const run = this.getRun(id);
    requireInput(activeStatuses.has(run.status), '此运行已结束');
    run.status = 'cancelled'; run.chatBusy = false; this.controllers.get(id)?.abort();
    for (const t of run.tasks) if (!['passed', 'blocked', 'needs_attention'].includes(t.status)) t.status = 'cancelled';
    this.event(run, 'cancel', '用户取消运行，已完成产物保留');
    return run;
  }
  async task(run, task, lead, signal) {
    const assigned = run.agentSnapshots.find(a => a.id === task.agentId);
    const executors = assigned.id === lead.id ? [lead, lead] : eligible(lead, task, lead) ? [assigned, assigned, lead] : [assigned, assigned];
    let feedback = '';
    for (let i = 0; i < executors.length; i++) {
      this.check(run, signal);
      const agent = executors[i];
      task.status = i === 0 ? 'running' : agent.id === lead.id && assigned.id !== lead.id ? 'escalating' : 'retrying';
      const attempt = { agentId: agent.id, phase: i === 0 ? 'execute' : agent.id !== assigned.id ? 'takeover' : 'repair', output: '', review: null, error: '', startedAt: now() };
      task.attempts.push(attempt);
      this.event(run, task.status, `${task.title}：${agent.name}${i ? ' 根据反馈修复' : ' 开始执行'}`, task.id);
      try {
        const data = await this.invoke(run, agent, { phase: 'execute', task, feedback, attempt: i + 1, dependencies: task.dependencies.map(id => { const t = run.tasks.find(x => x.id === id); return { id, title: t.title, output: t.output }; }) }, signal);
        attempt.output = contentOf(data);
        task.status = 'reviewing'; this.persist(run);
        const review = validateReview(await this.invoke(run, lead, { phase: 'review', task, output: attempt.output }, signal), task);
        attempt.review = review; task.review = review;
        if (review.passed) {
          task.output = attempt.output; task.status = 'passed'; task.error = ''; attempt.finishedAt = now();
          this.event(run, 'passed', `${task.title}：主导的逐项模型审查通过`, task.id);
          return;
        }
        feedback = review.feedback + '\n' + review.criteria.filter(c => !c.passed).map(c => `${c.criterion}：${c.evidence}`).join('\n');
        this.event(run, 'rejected', `${task.title}：审查未通过，将在次数上限内修复或接管`, task.id);
      } catch (error) {
        if (signal.aborted || run.status === 'cancelled') return;
        attempt.error = error.message; feedback = error.message;
        this.event(run, 'attempt_error', `${task.title}：${error.message}`, task.id);
        if (error instanceof BudgetError) { attempt.finishedAt = now(); break; }
      }
      attempt.finishedAt = now(); this.persist(run);
    }
    this.check(run, signal);
    task.status = 'needs_attention'; task.error = feedback || '修复与主导接管后仍未通过';
    this.event(run, 'attention', `${task.title}：需要人工处理，未标记为成功`, task.id);
  }
  async execute(run, lead, signal) {
    while (run.tasks.some(t => t.status === 'pending')) {
      this.check(run, signal);
      for (const task of run.tasks.filter(t => t.status === 'pending')) {
        if (task.dependencies.some(id => ['needs_attention', 'blocked'].includes(run.tasks.find(t => t.id === id).status))) {
          task.status = 'blocked'; task.error = '依赖任务未通过验收'; this.event(run, 'blocked', `${task.title}：依赖未通过，停止此分支`, task.id);
        }
      }
      const ready = run.tasks.filter(t => t.status === 'pending' && t.dependencies.every(id => run.tasks.find(t => t.id === id).status === 'passed'));
      if (!ready.length) break;
      await Promise.all(ready.slice(0, run.concurrency).map(t => this.task(run, t, lead, signal)));
    }
    this.check(run, signal);
    if (run.tasks.some(t => t.status !== 'passed')) {
      for (const t of run.tasks.filter(t => t.status === 'pending')) { t.status = 'blocked'; t.error = '依赖任务未通过验收'; }
      run.status = 'needs_attention'; run.error = '部分任务未通过。可查看每次尝试、审查意见和接管记录。';
      this.event(run, 'attention', run.error); return;
    }
    const summary = await this.invoke(run, lead, { phase: 'synthesize', tasks: run.tasks.map(t => ({ id: t.id, title: t.title, output: t.output, acceptance: t.acceptance })) }, signal);
    run.summary = contentOf(summary); run.status = 'completed';
    this.event(run, 'completed', '全部任务通过模型审查，主导已汇总产物。模型审查不等同于代码测试或事实核验。');
  }
}
