'use strict';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const state = {agents: [], runs: [], cliProfiles: []};
let selectedRunId = null;
let agentFingerprint = '';
let runFingerprint = '';
let toastTimer;
let creating = false;
let newConversation = false;
let chatContextKey = '';
let chatMessagesFingerprint = '';
let chatChipsFingerprint = '';
let serviceConnected = false;
const chatDrafts = new Map();
const chatRequestErrors = new Map();
const chatSubmissions = new Set();
const suggestedAssignments = new Map();
const assignments = new Map();
const openDetails = new Set();
let cliRequestVersion = 0;
let agentDialogVersion = 0;
let agentSaving = false;
let cliDiscovery = {selectionId:'', profileId:'', path:'', models:[], loading:false, message:'选择程序后，将在下方显示模型列表。', warnings:[], error:false};
let cliRequestController = null;
const activeStatuses = new Set(['planning', 'awaiting_approval', 'running']);
const statusNames = {planning:'规划中',awaiting_approval:'等待模型确认',running:'执行中',completed:'已完成',needs_attention:'需要人工关注',failed:'执行失败',cancelled:'已取消',interrupted:'运行中断',pending:'待执行',reviewing:'主导复核中',retrying:'修正中',escalating:'升级主导处理',passed:'通过复核',blocked:'依赖阻塞'};
const tierNames = {1:'轻量',2:'均衡',3:'高阶'};
const providerNames = {'demo':'演示','openai-compatible':'API','cli':'本机 CLI'};
const riskNames = {low:'低风险',medium:'中风险',high:'高风险'};

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: {'Content-Type':'application/json', ...options.headers} });
  let result;
  try { result = await response.json(); } catch { throw new Error(`服务响应异常（${response.status}）`); }
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 7000 : 4000);
}
function badge(status) { return `<span class="badge badge-${esc(status)}"><span></span>${esc(statusNames[status] || status)}</span>`; }
function initials(name) { return esc(Array.from(name || 'A').slice(0, 1).join('')); }
function dateLabel(value, includeDate = false) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return date.toLocaleString('zh-CN', includeDate ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'} : {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function agentsFor(run) {
  const snapshots = Array.isArray(run?.agentSnapshots) ? run.agentSnapshots : [];
  return [...state.agents, ...snapshots.filter((item) => !state.agents.some((agent) => agent.id === item.id))];
}
function agentFor(id, run) { return agentsFor(run).find((agent) => agent.id === id); }
function eligibleAgents(task, run) {
  const lead = agentFor(run.leadAgentId, run);
  const snapshotIds = new Set((run.agentSnapshots || []).map((agent) => agent.id));
  return state.agents.filter((agent) => {
    if (!snapshotIds.has(agent.id)) return false;
    if (!agent.configured || (agent.provider === 'demo') !== (lead?.provider === 'demo')) return false;
    if ((task.complexity === 3 || task.risk === 'high') && agent.id !== run.leadAgentId) return false;
    return agent.tier >= task.complexity && (agent.skills?.includes('*') || (task.requiredSkills || []).every((skill) => agent.skills?.includes(skill)));
  });
}
function setView(view) {
  document.querySelectorAll('.view').forEach((node) => { node.hidden = node.id !== `view-${view}`; });
  document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
  $('#page-title').textContent = view === 'agents' ? 'Agent 管理' : '协作工作台';
}
document.querySelectorAll('[data-view]').forEach((node) => node.addEventListener('click', () => setView(node.dataset.view)));

function renderAgents() {
  const fingerprint = JSON.stringify([state.agents, state.cliProfiles]);
  if (fingerprint === agentFingerprint) return;
  agentFingerprint = fingerprint;
  $('#nav-agent-count').textContent = state.agents.length;
  const select = $('#lead-agent');
  const previous = select.value;
  const sorted = [...state.agents].sort((a, b) => b.tier - a.tier);
  select.innerHTML = sorted.length ? sorted.map((agent) => `<option value="${esc(agent.id)}" ${agent.configured ? '' : 'disabled'}>${esc(agent.name)} · ${esc(agent.model)}${agent.configured ? '' : '（未就绪）'}</option>`).join('') : '<option value="">请先添加 Agent</option>';
  if (state.agents.some((agent) => agent.id === previous && agent.configured)) select.value = previous;
  updateLeadDescription();
  $('#team-preview').innerHTML = sorted.slice(0, 5).map((agent) => `<div class="team-member"><span class="avatar avatar-${esc(agent.tier)}">${initials(agent.name)}</span><div><strong>${esc(agent.name)}</strong><small>${esc(agent.model)}</small></div><span class="tier-tag">L${esc(agent.tier)}</span></div>`).join('') || '<p class="muted">还没有 Agent，前往管理页添加。</p>';
  const ready = state.agents.filter((agent) => agent.configured).length;
  const apis = state.agents.filter((agent) => agent.provider === 'openai-compatible').length;
  const clis = state.agents.filter((agent) => agent.provider === 'cli').length;
  $('#agent-stats').innerHTML = [[state.agents.length,'队伍成员'],[ready,'已配置就绪'],[apis,'API Agent'],[clis,'本机 CLI']].map(([count,label]) => `<div class="stat-block"><strong>${count}</strong><span>${label}</span></div>`).join('');
  $('#agent-grid').innerHTML = sorted.map((agent) => `<article class="agent-card"><div class="agent-card-top"><span class="avatar avatar-large avatar-${esc(agent.tier)}">${initials(agent.name)}</span><span class="provider-tag ${agent.provider === 'demo' ? 'is-demo' : ''}">${esc(providerNames[agent.provider] || agent.provider)}</span></div><h2>${esc(agent.name)}</h2><div class="agent-model">${esc(agent.model)}</div><div class="agent-level"><span>L${esc(agent.tier)} · ${esc(tierNames[agent.tier])}</span><span class="ready-state ${agent.configured ? '' : 'not-ready'}">${agent.configured ? '已配置' : '未就绪'}</span></div><div class="skill-tags">${(agent.skills || []).map((skill) => `<span>${esc(skill)}</span>`).join('')}</div><div class="agent-endpoint">${esc(agent.provider === 'cli' ? `模板：${agent.cliProfile || '未设置'}` : agent.provider === 'demo' ? '本地模拟 · 不消耗模型 API' : agent.baseUrl || '未设置端点')}</div><div class="agent-card-bottom"><small>${agent.provider === 'openai-compatible' ? `密钥变量：${esc(agent.apiKeyEnv || '未设置')}` : agent.provider === 'demo' ? '用于体验编排与纠错流程' : '使用受信任的服务器命令模板'}</small><button class="text-button danger-text delete-agent" data-agent-id="${esc(agent.id)}" aria-label="删除 ${esc(agent.name)}">删除</button></div></article>`).join('') || '<div class="empty-panel"><h2>组建你的第一支队伍</h2><p>添加一个主导模型和几个专长不同的执行模型。</p></div>';
  const cliSelect = $('#agent-cli-profile');
  const prevCli = cliSelect.value;
  cliSelect.innerHTML = '<option value="">请选择已有配置</option>' + state.cliProfiles.map((profile) => `<option value="${esc(profile.id)}" ${profile.available ? '' : 'disabled'}>${esc(profile.name)}${profile.available ? '' : '（不可用）'}</option>`).join('');
  if (state.cliProfiles.some((profile) => profile.id === prevCli && profile.available)) cliSelect.value = prevCli;
  if (cliDiscovery.profileId && !state.cliProfiles.some((profile) => profile.id === cliDiscovery.profileId && profile.available)) resetCliDiscovery('所选配置已不可用，请重新选择 Agent 程序。');
  updateCliHelp();
  renderChat();
}
function updateLeadDescription() {
  const agent = state.agents.find((item) => item.id === $('#lead-agent').value);
  $('#lead-description').textContent = agent ? `L${agent.tier} · ${tierNames[agent.tier]}能力 · ${agent.provider === 'demo' ? '演示模式，产出为模拟内容' : '真实模型调用，按服务商规则计费'}` : '请添加一个可用的主导 Agent。';
  $('#demo-failure-field').hidden = agent?.provider !== 'demo';
  if (agent?.provider !== 'demo') $('#demo-failure').checked = false;
  renderChat();
}
$('#lead-agent').addEventListener('change', updateLeadDescription);

function currentRun() { return newConversation ? null : state.runs.find((item) => item.id === selectedRunId); }
function chatBusy(run) { return Boolean(run?.chatBusy || chatSubmissions.has(run?.id || 'new') || creating); }
function chatAgents(run) {
  const lead = run ? agentFor(run.leadAgentId, run) : state.agents.find((agent) => agent.id === $('#lead-agent').value);
  const snapshotIds = run ? new Set((run.agentSnapshots || []).map((agent) => agent.id)) : null;
  return state.agents.filter((agent) => agent.configured && (agent.provider === 'demo') === (lead?.provider === 'demo') && (!snapshotIds || snapshotIds.has(agent.id)));
}
function renderChat() {
  const run = currentRun();
  const contextKey = run?.id || 'new';
  const textarea = $('#chat-message');
  textarea.maxLength = run ? 6000 : 12000;
  const contextChanged = chatContextKey !== contextKey;
  if (contextChanged) {
    if (chatContextKey) chatDrafts.set(chatContextKey, textarea.value);
    chatContextKey = contextKey;
    textarea.value = chatDrafts.get(contextKey) || '';
  }
  const lead = run ? agentFor(run.leadAgentId, run) : state.agents.find((agent) => agent.id === $('#lead-agent').value);
  const busy = chatBusy(run);
  const writable = !run || run.status === 'awaiting_approval';
  const available = serviceConnected && Boolean(run || lead?.configured);
  const canWrite = available && writable && !busy;
  const newLabel = lead ? `${lead.name} · ${lead.model}` : '请先在协作设置中选择主导 Agent';
  $('#chat-lead-label').textContent = newLabel;
  $('#chat-state').textContent = busy ? (creating ? '正在创建' : '调整分工中') : run ? statusNames[run.status] || run.status : '新对话';
  $('#chat-panel').setAttribute('aria-busy', String(busy));
  $('#chat-input-label').textContent = !run ? '告诉主导你的目标与分工要求' : run.status === 'awaiting_approval' ? '继续对话，指定任务交给谁' : '协作对话记录';
  textarea.readOnly = !canWrite;
  textarea.placeholder = !available ? '请先连接服务并添加可用的 Agent。' : busy ? '主导正在处理，请稍候…' : !run ? '例如：比较两种方案，计算交给 @OpenCode CLI，整理交给 @Qoder CLI，最后由主导复核。' : run.status === 'awaiting_approval' ? '例如：把计算任务交给 @OpenCode CLI，整理交给 @Qoder CLI，其他保持不变。' : run.status === 'planning' ? '主导正在规划，完成后可在这里调整分工。' : run.status === 'running' ? '团队正在执行。完成后可新建协作，开始新的对话。' : '本次协作已结束。点击「新建协作」开始新的对话。';
  const help = !serviceConnected ? '本地服务未连接，正在自动重连。' : busy ? '主导正在处理你的消息，完成后可继续调整。' : !run ? 'Enter 发送 · Shift + Enter 换行\n先规划，确认分工后再执行。' : run.status === 'awaiting_approval' ? 'Enter 发送 · Shift + Enter 换行\n修改分工后，仍需点击下方「确认模型，开始执行」。' : run.status === 'planning' ? '正在规划任务，请稍候。规划完成后可继续指定分工。' : run.status === 'running' ? '当前执行中，分工已锁定。新需求请点击「新建协作」。' : '本次对话已结束。点击「新建协作」发送新的目标。';
  $('#chat-help').textContent = help;
  $('#chat-send').disabled = !canWrite || !textarea.value.trim();
  $('#chat-send').innerHTML = busy ? `<span>${creating ? '正在创建…' : '正在发送…'}</span><span class="spinner" aria-hidden="true"></span>` : `<span>${run ? '发送指令' : '发送并规划'}</span><span aria-hidden="true">↑</span>`;
  const error = chatRequestErrors.get(contextKey) || run?.chatError || '';
  $('#chat-error').textContent = error;
  $('#chat-error').hidden = !error;

  const agents = chatAgents(run);
  const chipsFingerprint = JSON.stringify([agents, canWrite, lead?.id]);
  if (chipsFingerprint !== chatChipsFingerprint) {
    chatChipsFingerprint = chipsFingerprint;
    $('#chat-agent-chips').innerHTML = agents.length ? agents.map((agent) => `<button type="button" class="chat-agent-chip" data-mention-agent="${esc(agent.id)}" ${canWrite ? '' : 'disabled'} title="${esc(`指定 ${agent.name} · ${agent.model}`)}"><span>@${esc(agent.name)}</span><small>${esc(agent.model)}</small>${agent.id === lead?.id ? '<b>主导</b>' : ''}</button>`).join('') : '<span class="chat-no-agents">添加并选择主导后，可在这里选择执行 Agent。</span>';
  }
  const messages = Array.isArray(run?.messages) && run.messages.length ? run.messages : run ? [{role:'user',content:run.goal,time:run.createdAt}] : [];
  const messageFingerprint = JSON.stringify([contextKey, messages, busy, run?.status, lead?.name]);
  if (messageFingerprint !== chatMessagesFingerprint) {
    chatMessagesFingerprint = messageFingerprint;
    const log = $('#chat-messages');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 72;
    log.innerHTML = messages.length ? messages.map((message) => `<article class="chat-message chat-message-${message.role === 'user' ? 'user' : 'assistant'}"><div class="chat-message-meta"><strong>${esc(message.role === 'user' ? '你' : lead?.name || '主导 Agent')}</strong>${message.time ? `<time>${esc(dateLabel(message.time))}</time>` : ''}</div><div class="chat-message-content">${esc(message.content)}</div></article>`).join('') : '<div class="chat-empty"><span aria-hidden="true">↗</span><h3>把目标和分工，一起告诉主导。</h3><p>你可以直接指定「某项任务交给 @Agent」，<br>也可以先让主导规划，再通过对话调整。</p></div>';
    if (busy || run?.status === 'planning') log.insertAdjacentHTML('beforeend', `<div class="chat-working" role="status"><span class="spinner" aria-hidden="true"></span>${creating ? '正在创建协作…' : run?.status === 'planning' ? '主导正在拆解目标、规划任务…' : '主导正在理解要求、调整分工…'}</div>`);
    if (contextChanged || nearBottom) log.scrollTop = log.scrollHeight;
  }
}
function rememberRun(run) {
  const index = state.runs.findIndex((item) => item.id === run.id);
  if (index >= 0) state.runs[index] = run;
  else state.runs.unshift(run);
}
function startNewConversation() {
  if (creating) return;
  newConversation = true;
  selectedRunId = null;
  setView('workbench');
  renderRuns(true);
  $('#chat-panel').scrollIntoView({behavior:'smooth',block:'start'});
  $('#chat-message').focus({preventScroll:true});
}
$('#chat-agent-chips').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mention-agent]');
  const textarea = $('#chat-message');
  if (!button || textarea.readOnly) return;
  const agents = chatAgents(currentRun());
  const agent = agents.find((item) => item.id === button.dataset.mentionAgent);
  if (!agent) return;
  const sameName = agents.filter((item) => item.name.trim().toLowerCase() === agent.name.trim().toLowerCase()).length > 1;
  const mention = `@${agent.name}（${agent.model}）`;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const prefix = start > 0 && !/[\s，,;；。:：]$/.test(textarea.value.slice(0,start)) ? ' ' : '';
  const suffix = end < textarea.value.length && /^\s/.test(textarea.value.slice(end)) ? '' : ' ';
  const insertion = prefix + mention + suffix;
  if (textarea.value.length - (end - start) + insertion.length > textarea.maxLength) { toast('消息太长，请缩短后再插入 Agent。', true); return; }
  textarea.setRangeText(insertion,start,end,'end');
  chatDrafts.set(chatContextKey, textarea.value);
  if (sameName) toast('队伍中有同名 Agent，已同时插入模型名称以便区分。');
  textarea.focus({preventScroll:true});
  renderChat();
});
$('#chat-message').addEventListener('input', () => {
  chatDrafts.set(chatContextKey || 'new', $('#chat-message').value);
  chatRequestErrors.delete(chatContextKey || 'new');
  renderChat();
});
$('#chat-message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!$('#chat-send').disabled) $('#chat-form').requestSubmit();
  }
});
$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const run = currentRun();
  const contextKey = run?.id || 'new';
  const message = $('#chat-message').value.trim();
  if (!message || chatBusy(run) || !serviceConnected || (run && run.status !== 'awaiting_approval')) return;
  if (!run && !$('#run-form').reportValidity()) return;
  chatRequestErrors.delete(contextKey);
  chatSubmissions.add(contextKey);
  if (!run) creating = true;
  renderRuns(true);
  try {
    const result = run
      ? await api(`/api/runs/${encodeURIComponent(run.id)}/chat`, {method:'POST',body:JSON.stringify({message})})
      : await api('/api/runs', {method:'POST',body:JSON.stringify({goal:message,leadAgentId:$('#lead-agent').value,maxCalls:Number($('#max-calls').value),concurrency:Number($('#concurrency').value),demoFailure:$('#demo-failure').checked})});
    chatDrafts.delete(contextKey);
    if (chatContextKey === contextKey) $('#chat-message').value = '';
    rememberRun(result);
    if (!run && (newConversation || !selectedRunId)) { selectedRunId = result.id; newConversation = false; }
    renderRuns(true);
  } catch (error) {
    chatRequestErrors.set(contextKey, error.message);
    if (chatContextKey !== contextKey) toast(error.message, true);
  } finally {
    chatSubmissions.delete(contextKey);
    if (!run) creating = false;
    renderRuns(true);
  }
});

function emptyWorkspace() {
  return `<section class="panel welcome-panel"><div class="welcome-label"><span class="status-dot"></span>协作，从一个清晰的目标开始</div><h2>一个目标。<br>一支各有所长的队伍。</h2><p>主导 Agent 拆解任务、设定验收标准。<br>你确认执行模型后，团队开始协作。</p><div class="orchestration"><div class="leader-node"><span class="node-icon">✧</span><div><strong>主导 Agent</strong><small>规划 · 难题 · 最终整合</small></div><span class="node-label">LEAD</span></div><div class="branch-lines"><span></span><span></span><span></span></div><div class="worker-nodes"><div><span class="worker-icon violet">◇</span><strong>高阶模型</strong><small>复杂推理</small></div><div><span class="worker-icon blue">▤</span><strong>均衡模型</strong><small>常规实现</small></div><div><span class="worker-icon sage">⌁</span><strong>轻量模型</strong><small>明确的小任务</small></div></div><div class="review-node"><span>✓</span> 主导复核验收 <i>·</i> 失败修正 / 升级处理</div></div><div class="welcome-bottom"><span>01 明确目标</span><span>02 确认分工</span><span>03 查看交付</span></div></section><section class="principles"><article><span>↗</span><h3>先匹配，再委派</h3><p>能力等级与技能共同约束分工。</p></article><article><span>◎</span><h3>每一步，可追溯</h3><p>查看调用、尝试和逐项复核意见。</p></article><article><span>⌘</span><h3>API 与 CLI</h3><p>在同一工作台调度两类 Agent。</p></article></section>`;
}
function taskCard(task, run, index) {
  const isApproval = run.status === 'awaiting_approval';
  const isLeadOnly = task.complexity === 3 || task.risk === 'high';
  const candidates = eligibleAgents(task, run);
  const key = `${run.id}:${task.id}`;
  let assigned = assignments.get(key) || task.agentId || task.suggestedAgentId;
  if (isApproval && !candidates.some((agent) => agent.id === assigned)) assigned = candidates[0]?.id || '';
  if (isApproval) assignments.set(key, assigned);
  const currentAgent = agentFor(task.agentId || assigned, run);
  const deps = (task.dependencies || []).map((id) => { const position = run.tasks.findIndex((item) => item.id === id); return position >= 0 ? `T${String(position + 1).padStart(2,'0')}` : id; });
  const review = task.review;
  const selection = isApproval ? `<div class="assignment-row"><label for="assign-${esc(index)}">${isLeadOnly ? '主导专属任务' : '选择执行模型'}</label><select id="assign-${esc(index)}" data-assignment="${esc(task.id)}" ${isLeadOnly || chatBusy(run) ? 'disabled' : ''}>${candidates.length ? candidates.map((agent) => `<option value="${esc(agent.id)}" ${agent.id === assigned ? 'selected' : ''}>${esc(agent.name)} · ${esc(agent.model)}${agent.id === run.leadAgentId ? '（主导）' : ''}</option>`).join('') : '<option value="">无符合条件的模型</option>'}</select></div>` : `<div class="task-assignee"><span class="avatar tiny avatar-${esc(currentAgent?.tier || 1)}">${initials(currentAgent?.name)}</span><span>${esc(currentAgent?.name || '待分配')}</span>${currentAgent ? `<small>${esc(currentAgent.model)}</small>` : ''}<span class="attempt-count">${(task.attempts || []).length ? `${task.attempts.length} 次记录` : ''}</span></div>`;
  return `<article class="task-card task-${esc(task.status)}"><div class="task-top"><span class="task-index">T${String(index + 1).padStart(2,'0')}</span><div class="task-title"><h3>${esc(task.title)}</h3><div class="task-meta"><span class="complexity complexity-${esc(task.complexity)}">L${esc(task.complexity)} · ${esc(tierNames[task.complexity])}</span><span>${esc(riskNames[task.risk] || task.risk)}</span>${isLeadOnly ? '<span class="lead-only">主导处理</span>' : ''}</div></div>${badge(task.status)}</div><p class="task-description">${esc(task.description)}</p><div class="task-tags">${(task.requiredSkills || []).map((skill) => `<span>${esc(skill)}</span>`).join('')}${deps.length ? `<span class="dependency">依赖 ${esc(deps.join(' / '))}</span>` : '<span class="dependency">无前置依赖</span>'}</div>${selection}${task.routingReason ? `<p class="routing-reason">${esc(task.routingReason)}</p>` : ''}<details class="task-detail" data-detail-key="${esc(key)}" ${openDetails.has(key) ? 'open' : ''}><summary>验收标准与执行记录 <span>＋</span></summary><div class="detail-body"><h4>验收标准</h4><ul class="acceptance-list">${(task.acceptance || []).map((criterion) => `<li>${esc(criterion)}</li>`).join('')}</ul>${task.output ? `<h4>任务产出</h4><pre class="output-text">${esc(task.output)}</pre>` : ''}${review ? `<div class="review-result ${review.passed ? 'review-passed' : 'review-failed'}"><h4>${review.passed ? '✓ 通过主导复核' : '↻ 复核未通过'}</h4><p>${esc(review.feedback)}</p>${(review.criteria || []).map((criterion) => `<div class="criterion"><span>${criterion.passed ? '✓' : '×'}</span><div><strong>${esc(criterion.criterion)}</strong><small>${esc(criterion.evidence)}</small></div></div>`).join('')}</div>` : ''}${task.error ? `<p class="inline-error">${esc(task.error)}</p>` : ''}${(task.attempts || []).length ? `<h4>调用记录</h4><div class="attempt-list">${task.attempts.map((attempt) => `<div class="attempt"><div><strong>${esc(({execute:'执行',review:'复核',repair:'修正',takeover:'主导接管'})[attempt.phase] || attempt.phase)}</strong><span>${esc(agentFor(attempt.agentId, run)?.name || attempt.agentId)}</span><time>${esc(dateLabel(attempt.startedAt))}</time></div>${attempt.error ? `<p class="inline-error">${esc(attempt.error)}</p>` : ''}${attempt.output ? `<pre class="output-text">${esc(typeof attempt.output === 'string' ? attempt.output : JSON.stringify(attempt.output, null, 2))}</pre>` : ''}${attempt.review?.feedback ? `<p>${esc(attempt.review.feedback)}</p>` : ''}</div>`).join('')}</div>` : ''}</div></details></article>`;
}
function renderRuns(force = false) {
  if (!newConversation && !selectedRunId && state.runs.length) selectedRunId = state.runs[0].id;
  const run = currentRun();
  renderChat();
  for (const task of run?.tasks || []) {
    const key = `${run.id}:${task.id}`;
    const previous = suggestedAssignments.get(key);
    const revision = task.routingRevision;
    if (previous && (revision !== undefined ? previous.revision !== revision : previous.agentId !== task.suggestedAgentId)) assignments.delete(key);
    suggestedAssignments.set(key, {revision, agentId:task.suggestedAgentId});
  }
  const fingerprint = JSON.stringify([state.runs, selectedRunId, newConversation, state.agents, [...chatSubmissions], creating]);
  if (!force && fingerprint === runFingerprint) return;
  runFingerprint = fingerprint;
  $('#run-tabs').innerHTML = (newConversation ? '<span class="run-tab selected new-conversation-tab">＋ 新对话</span>' : '') + state.runs.map((item) => `<button class="run-tab ${item.id === selectedRunId ? 'selected' : ''}" data-run-id="${esc(item.id)}" title="${esc(item.goal)}"><span class="run-tab-dot run-dot-${esc(item.status)}"></span><span>${esc(item.goal)}</span></button>`).join('');
  if (!run) { $('#run-content').innerHTML = emptyWorkspace(); return; }
  const lead = agentFor(run.leadAgentId, run);
  const tasks = run.tasks || [];
  const completed = tasks.filter((task) => task.status === 'passed').length;
  const percentage = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  const awaiting = run.status === 'awaiting_approval';
  const canApprove = awaiting && !chatBusy(run) && tasks.length && tasks.every((task) => eligibleAgents(task, run).length);
  $('#run-content').innerHTML = `<section class="panel run-overview"><div class="run-overview-top"><span class="eyebrow">PROJECT ${lead?.provider === 'demo' ? '<b class="demo-tag">演示项目</b>' : '<b class="real-tag">真实模型</b>'}</span>${badge(run.status)}</div><h2>${esc(run.goal)}</h2><div class="run-byline"><span class="avatar tiny avatar-3">${initials(lead?.name)}</span><span>主导：${esc(lead?.name || '未知 Agent')}</span><time>${esc(dateLabel(run.createdAt, true))}</time></div><div class="run-metrics"><div><small>任务进度</small><strong>${completed}<em> / ${tasks.length}</em></strong></div><div><small>模型调用</small><strong>${esc(run.callsUsed || 0)}<em> / ${esc(run.maxCalls)}</em></strong></div><div><small>并行上限</small><strong>${esc(run.concurrency)}<em> 个任务</em></strong></div></div><div class="progress-track"><progress max="100" value="${percentage}" aria-label="已通过复核的任务比例">${percentage}%</progress></div><div class="run-actions"><a class="text-button" href="/api/runs/${encodeURIComponent(run.id)}/export" download>↓ 导出记录</a>${activeStatuses.has(run.status) ? '<button class="text-button danger-text" id="cancel-run">停止项目</button>' : ''}</div></section>${run.error ? `<div class="notice notice-error"><strong>项目需要关注</strong><p>${esc(run.error)}</p></div>` : ''}${run.status === 'planning' ? '<div class="notice planning-notice"><span class="spinner"></span><div><strong>主导 Agent 正在制定计划</strong><p>拆解任务、明确依赖，并为每项任务制定验收标准。</p></div></div>' : ''}${awaiting ? `<section class="approval-banner"><span class="approval-icon">◎</span><div><div class="eyebrow">YOUR DECISION</div><h3>计划已准备好，由你确认模型</h3><p>${esc(run.question || '这些任务分别使用哪个模型？请在下方确认或调整执行 Agent。')}</p><small>仅列出能力与技能匹配的同类 Agent；L3 或高风险任务固定交给主导。</small></div></section>` : ''}${tasks.length ? `<div class="section-title task-section-heading"><h2>任务编排 <span class="count">${tasks.length}</span></h2><span class="muted">按前置依赖推进</span></div><div class="task-list">${tasks.map((task,index) => taskCard(task,run,index)).join('')}</div>` : ''}${awaiting ? `<div class="approval-footer"><p>${chatBusy(run) ? '分工调整中，请等待主导回复后确认。' : canApprove ? '确认后将按当前分工执行，并由主导逐项复核。' : '部分任务没有合格候选。补充合适的 Agent 后，请重新发起规划。'}</p><button class="button button-primary" id="approve-run" ${canApprove ? '' : 'disabled'}>确认模型，开始执行 <span>→</span></button></div>` : ''}${run.summary ? `<section class="panel summary-panel"><div class="section-title"><div><span class="eyebrow">PROJECT DELIVERY</span><h2>项目交付</h2></div><span class="square-icon">✓</span></div>${lead?.provider === 'demo' ? '<p class="demo-disclaimer">演示内容 · 用于展示协作流程，请勿视为真实模型产出。</p>' : ''}<pre class="summary-text">${esc(run.summary)}</pre></section>` : ''}${(run.events || []).length ? `<section class="panel events-panel"><div class="section-title"><h2>协作时间线</h2><span class="muted">${run.events.length > 20 ? '最近 20 条 · 完整记录可导出' : `${run.events.length} 条记录`}</span></div><ol class="event-list">${[...run.events].slice(-20).reverse().map((event) => `<li><span class="event-dot"></span><div><p>${esc(event.message)}</p><time>${esc(dateLabel(event.time))}</time></div></li>`).join('')}</ol></section>` : ''}`;
  $('#run-content').querySelectorAll('details[data-detail-key]').forEach((details) => details.addEventListener('toggle', () => { if (details.open) openDetails.add(details.dataset.detailKey); else openDetails.delete(details.dataset.detailKey); }));
}

$('#run-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-run-id]');
  if (!button) return;
  selectedRunId = button.dataset.runId;
  newConversation = false;
  renderRuns(true);
});
$('#run-content').addEventListener('change', (event) => {
  const select = event.target.closest('[data-assignment]');
  if (select && !chatBusy(currentRun())) assignments.set(`${selectedRunId}:${select.dataset.assignment}`, select.value);
});
$('#run-content').addEventListener('click', async (event) => {
  const button = event.target.closest('#approve-run, #cancel-run');
  if (!button) return;
  const run = state.runs.find((item) => item.id === selectedRunId);
  if (!run) return;
  if (button.id === 'approve-run' && chatBusy(run)) return;
  button.disabled = true;
  try {
    if (button.id === 'approve-run') {
      await api(`/api/runs/${encodeURIComponent(run.id)}/approve`, {method:'POST',body:JSON.stringify({assignments:run.tasks.map((task) => ({taskId:task.id,agentId:assignments.get(`${run.id}:${task.id}`)}))})});
      toast('分工已确认，团队开始执行。');
    } else {
      await api(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {method:'POST',body:'{}'});
      toast('项目已停止。');
    }
    await refresh();
  } catch (error) { toast(error.message, true); button.disabled = false; }
});
$('#new-run-button').addEventListener('click', startNewConversation);
$('#run-form').addEventListener('submit', (event) => { event.preventDefault(); $('#chat-message').focus(); });

function updateAgentFields() {
  const provider = $('#agent-provider').value;
  const isCli = provider === 'cli';
  $('#api-agent-fields').hidden = provider !== 'openai-compatible';
  $('#cli-agent-fields').hidden = !isCli;
  $('#manual-model-field').hidden = isCli;
  $('#model-tier-row').classList.toggle('cli-mode', isCli);
  $('#agent-model').disabled = isCli;
  $('#agent-model').required = !isCli;
  $('#agent-url').required = provider === 'openai-compatible';
  $('#agent-key-env').required = false;
  $('#agent-url').disabled = provider !== 'openai-compatible';
  $('#agent-key-env').disabled = provider !== 'openai-compatible';
  $('#agent-cli-profile').disabled = !isCli || agentSaving;
  $('#agent-cli-profile').required = false;
  $('#agent-cli-model').disabled = !isCli || cliDiscovery.loading || !cliDiscovery.models.length || agentSaving;
  $('#agent-cli-model').required = isCli;
  $('#pick-cli-file').disabled = !isCli || cliDiscovery.loading || agentSaving;
  $('#agent-provider').disabled = agentSaving;
  $('#agent-model').placeholder = provider === 'demo' ? '例如：demo-reasoner' : '服务支持的模型 ID';
  $('#save-agent').disabled = agentSaving || (isCli && !validCliChoice());
}
function validCliChoice() {
  return !cliDiscovery.loading && Boolean(cliDiscovery.selectionId || cliDiscovery.profileId) && cliDiscovery.models.some((model) => model.id === $('#agent-cli-model').value);
}
function resetCliDiscovery(message = '选择程序后，将在下方显示模型列表。') {
  cliRequestVersion += 1;
  cliRequestController?.abort();
  cliRequestController = null;
  cliDiscovery = {selectionId:'', profileId:'', path:'', models:[], loading:false, message, warnings:[], error:false};
  $('#agent-cli-profile').value = '';
  renderCliDiscovery();
}
function renderCliDiscovery() {
  const select = $('#agent-cli-model');
  select.innerHTML = `<option value="">${cliDiscovery.loading ? '正在加载模型…' : cliDiscovery.models.length ? '请选择使用的模型' : '请先选择 Agent 程序'}</option>` + cliDiscovery.models.map((model) => `<option value="${esc(model.id)}">${esc(model.name || model.id)}${model.name && model.name !== model.id ? ` · ${esc(model.id)}` : ''}</option>`).join('');
  $('#cli-selected-path').textContent = cliDiscovery.path;
  $('#cli-selected-path').hidden = !cliDiscovery.path;
  $('#cli-discovery-status').textContent = cliDiscovery.message;
  $('#cli-discovery-status').classList.toggle('inline-error', cliDiscovery.error);
  $('#cli-agent-fields').setAttribute('aria-busy', String(cliDiscovery.loading));
  $('#pick-cli-file').textContent = cliDiscovery.loading ? '等待选择与加载…' : '选择本地文件…';
  $('#cancel-cli-discovery').hidden = !cliDiscovery.loading;
  $('#cli-discovery-warnings').textContent = cliDiscovery.warnings.join('\n');
  $('#cli-discovery-warnings').hidden = !cliDiscovery.warnings.length;
  $('#cli-model-description').textContent = '';
  updateAgentFields();
}
async function discoverCliModels(profileId = '') {
  resetCliDiscovery(profileId ? '正在读取所选 Agent 的模型列表…' : '请在 Windows 文件窗口中选择 Agent');
  const requestVersion = cliRequestVersion;
  const dialogVersion = agentDialogVersion;
  const controller = new AbortController();
  cliRequestController = controller;
  cliDiscovery.loading = true;
  cliDiscovery.profileId = profileId;
  $('#agent-cli-profile').value = profileId;
  $('#agent-form-error').textContent = '';
  updateCliHelp();
  renderCliDiscovery();
  const isCurrent = () => requestVersion === cliRequestVersion && dialogVersion === agentDialogVersion && $('#agent-dialog').open && $('#agent-provider').value === 'cli';
  try {
    const result = await api(profileId ? `/api/cli/profiles/${encodeURIComponent(profileId)}/models` : '/api/cli/pick-file', profileId ? {signal:controller.signal} : {method:'POST',body:'{}',signal:controller.signal});
    if (!isCurrent()) return;
    if (result.cancelled) { resetCliDiscovery('已取消文件选择。请重新选择 Agent 程序。'); return; }
    const seenIds = new Set();
    const models = (Array.isArray(result.models) ? result.models : []).filter((model) => model && typeof model.id === 'string' && model.id.trim() && !seenIds.has(model.id) && seenIds.add(model.id));
    if (!profileId && !result.selectionId) throw new Error('未能识别所选程序，请重新选择。');
    cliDiscovery = {selectionId:profileId ? '' : result.selectionId,profileId,path:result.path || state.cliProfiles.find((profile) => profile.id === profileId)?.name || '',models,loading:false,message:models.length ? `已加载 ${models.length} 个模型，请选择本次使用的模型。${result.source ? ` 来源：${result.source}` : ''}` : '未发现可用模型。请确认程序已登录或配置模型后重新选择。',warnings:Array.isArray(result.warnings) ? result.warnings.map(String) : [],error:!models.length};
    if (result.name && !$('#agent-name').value.trim()) $('#agent-name').value = result.name;
    renderCliDiscovery();
  } catch (error) {
    if (!isCurrent()) return;
    resetCliDiscovery(`加载失败：${error.message}`);
    cliDiscovery.error = true;
    renderCliDiscovery();
  } finally {
    if (cliRequestController === controller) cliRequestController = null;
  }
}
function updateCliHelp() {
  const profile = state.cliProfiles.find((item) => item.id === $('#agent-cli-profile').value);
  $('#cli-profile-help').textContent = profile?.detail || (state.cliProfiles.length ? '选择配置后，自动读取该 Agent 的模型列表。' : '暂无已有配置，可直接从文件选择 Agent。');
}
$('#agent-provider').addEventListener('change', () => { resetCliDiscovery(); $('#agent-form-error').textContent = ''; updateCliHelp(); });
$('#agent-cli-profile').addEventListener('change', () => { const profileId = $('#agent-cli-profile').value; if (profileId) discoverCliModels(profileId); else { resetCliDiscovery(); updateCliHelp(); } });
$('#pick-cli-file').addEventListener('click', () => discoverCliModels());
$('#cancel-cli-discovery').addEventListener('click', () => resetCliDiscovery('已取消文件选择。请重新选择 Agent 程序。'));
$('#agent-cli-model').addEventListener('change', () => { $('#cli-model-description').textContent = cliDiscovery.models.find((model) => model.id === $('#agent-cli-model').value)?.description || ''; updateAgentFields(); });
$('#add-agent-button').addEventListener('click', () => { agentDialogVersion += 1; $('#agent-form').reset(); $('#agent-form-error').textContent = ''; $('#cli-existing-options').open = false; resetCliDiscovery(); updateCliHelp(); $('#agent-dialog').showModal(); });
$('#agent-dialog').addEventListener('close', () => { agentDialogVersion += 1; resetCliDiscovery(); });
$('#agent-dialog').addEventListener('cancel', () => resetCliDiscovery());
['#close-agent-dialog','#cancel-agent-dialog'].forEach((selector) => $(selector).addEventListener('click', () => $('#agent-dialog').close()));
$('#agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (agentSaving) return;
  $('#agent-form-error').textContent = '';
  const provider = $('#agent-provider').value;
  if (provider === 'cli' && !validCliChoice()) { $('#agent-form-error').textContent = '请先选择 Agent 程序，再从加载的列表中选择模型。'; return; }
  const dialogVersion = agentDialogVersion;
  const agent = {name:$('#agent-name').value.trim(),provider,model:provider === 'cli' ? $('#agent-cli-model').value : $('#agent-model').value.trim(),tier:Number($('#agent-tier').value),skills:$('#agent-skills').value.split(/[,，\s]+/).map((skill) => skill.trim()).filter(Boolean)};
  if (provider === 'openai-compatible') { agent.baseUrl = $('#agent-url').value.trim(); agent.apiKeyEnv = $('#agent-key-env').value.trim(); }
  if (provider === 'cli') { if (cliDiscovery.selectionId) agent.cliSelectionId = cliDiscovery.selectionId; else agent.cliProfile = cliDiscovery.profileId; }
  agentSaving = true;
  updateAgentFields();
  try { await api('/api/agents', {method:'POST',body:JSON.stringify(agent)}); if (dialogVersion === agentDialogVersion) $('#agent-dialog').close(); await refresh(); toast('Agent 已加入队伍。'); }
  catch (error) { if (dialogVersion === agentDialogVersion) $('#agent-form-error').textContent = error.message; else toast(error.message, true); }
  finally { agentSaving = false; updateAgentFields(); }
});
$('#agent-grid').addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-agent');
  if (!button) return;
  const agent = state.agents.find((item) => item.id === button.dataset.agentId);
  if (!agent || !confirm(`从队伍中删除“${agent.name}”？历史项目记录会保留。`)) return;
  button.disabled = true;
  try { await api(`/api/agents/${encodeURIComponent(agent.id)}`, {method:'DELETE'}); await refresh(); toast('Agent 已删除。'); }
  catch (error) { toast(error.message, true); button.disabled = false; }
});
let refreshInFlight = null;
async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const next = await api('/api/state');
    state.agents = next.agents || [];
    state.runs = [...(next.runs || [])].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    state.cliProfiles = next.cliProfiles || [];
    serviceConnected = true;
    $('#connection-dot').classList.remove('offline');
    $('#connection-label').innerHTML = '本地服务已连接<small>LOCAL WORKSPACE</small>';
    renderAgents();
    renderRuns();
  })();
  try { await refreshInFlight; } finally { refreshInFlight = null; }
}
async function poll() {
  try { await refresh(); }
  catch (error) { serviceConnected = false; $('#connection-dot').classList.add('offline'); $('#connection-label').innerHTML = '服务连接中断<small>正在自动重连</small>'; if (!agentFingerprint) $('#lead-description').textContent = error.message; renderChat(); }
  finally { setTimeout(poll, 1000); }
}
$('#run-content').innerHTML = emptyWorkspace();
renderChat();
poll();
