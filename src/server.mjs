import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { Engine, InputError, validateAgent } from './engine.mjs';
import { getCliProfiles } from './providers.mjs';
import { discoverCliFile, discoverProfileModels, registerCliProfile } from './cli-catalog.mjs';
import { pickNativeAgentFile } from './native-picker.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new InputError('请求必须使用 application/json', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw new InputError('请求体过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('JSON 格式错误'); }
}
function markdown(run) {
  const lines = ['# Agent 协同运行报告', '', `目标：${run.goal}`, '', `状态：${run.status}`, `模型调用：${run.callsUsed} / ${run.maxCalls}`, '', '> 本报告包含模型生成的产物与模型审查记录。审查通过不代表代码已执行、测试通过或事实已核验。演示模式输出为预设示例。', '', '## 主导汇总', '', run.summary || run.error || '尚未生成汇总'];
  if (run.messages?.length) {
    lines.push('', '## 与主导的对话');
    for (const message of run.messages) {
      lines.push('', `### ${message.role === 'user' ? '用户' : '主导'} · ${message.time}`, '', message.content);
      for (const change of message.assignments || []) {
        const task = run.tasks.find(t => t.id === change.taskId), agent = run.agentSnapshots.find(a => a.id === change.agentId);
        lines.push('', `分工建议：${task?.title || change.taskId} → ${agent?.name || change.agentId} · ${agent?.model || ''}（仍需确认）`);
      }
    }
  }
  for (const task of run.tasks) {
    lines.push('', `## ${task.title}`, '', `状态：${task.status}`, `验收：${task.acceptance.join('；')}`, '', task.output || task.error || '暂无已通过的产物');
    for (const [i, a] of task.attempts.entries()) {
      const agent = run.agentSnapshots.find(x => x.id === a.agentId);
      lines.push('', `### 尝试 ${i + 1} · ${agent?.name ?? a.agentId} · ${agent?.model ?? ''}`, '', a.output || a.error || '无产物', '', `审查：${a.review ? JSON.stringify(a.review, null, 2) : '未完成'}`);
    }
  }
  lines.push('', '## 事件记录', '', ...run.events.map(e => `- ${e.time} ${e.message}`));
  return lines.join('\n');
}

export function createApp({ store = new Store(join(root, 'data/state.json')), provider, profiles = getCliProfiles, pickFile = pickNativeAgentFile, cliCatalog = { discoverFile: discoverCliFile, discoverProfile: discoverProfileModels, registerProfile: registerCliProfile } } = {}) {
  const engine = new Engine(store, provider);
  const selections = new Map();
  let pickerController = null;
  const requireModel = (catalog, model) => {
    if (!Array.isArray(catalog.models) || !catalog.models.some(m => m.id === model)) throw new InputError('请从该 Agent 已加载的模型列表中选择模型。');
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw new InputError('仅允许本机访问', 403);
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) throw new InputError('拒绝跨站请求', 403);
      const path = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && mime[path]) {
        res.writeHead(200, { 'Content-Type': mime[path][1] }); res.end(readFileSync(join(root, 'public', mime[path][0]))); return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        const cliProfiles = await profiles();
        const agents = engine.state.agents.map(a => ({ ...a, configured: a.provider === 'demo' || (a.provider === 'cli' ? cliProfiles.some(p => p.id === a.cliProfile && p.available) : !a.apiKeyEnv || Boolean(process.env[a.apiKeyEnv])) }));
        json(res, 200, { agents, runs: engine.state.runs, cliProfiles }); return;
      }
      if (req.method === 'POST' && path === '/api/cli/pick-file') {
        const input = await body(req);
        if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw new InputError('请通过 Windows 文件窗口选择 Agent。');
        if (pickerController) throw new InputError('文件选择窗口已打开，请先完成或取消当前选择。', 409);
        const controller = new AbortController();
        pickerController = controller;
        const abort = () => controller.abort();
        res.on('close', abort);
        try {
          const selectedPath = await pickFile({ signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return;
          if (!selectedPath) { json(res, 200, { cancelled: true }); return; }
          const discovery = await cliCatalog.discoverFile(selectedPath, { signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return;
          for (const [key, record] of selections) if (record.expiresAt <= Date.now()) selections.delete(key);
          if (selections.size >= 32) selections.delete(selections.keys().next().value);
          const selectionId = randomUUID();
          selections.set(selectionId, { discovery, expiresAt: Date.now() + 30 * 60 * 1000, busy: false, consumed: false });
          json(res, 200, { selectionId, path: discovery.path, kind: discovery.kind, name: discovery.name, models: discovery.models, source: discovery.source, updatedAt: discovery.updatedAt, warnings: discovery.warnings || [] }); return;
        } catch (error) {
          if (!controller.signal.aborted && !res.destroyed) throw error;
          return;
        } finally {
          res.removeListener('close', abort);
          if (pickerController === controller) pickerController = null;
        }
      }
      const modelsMatch = /^\/api\/cli\/profiles\/([\w-]+)\/models$/.exec(path);
      if (req.method === 'GET' && modelsMatch) {
        const discovery = await cliCatalog.discoverProfile(modelsMatch[1]);
        json(res, 200, { models: discovery.models, source: discovery.source, updatedAt: discovery.updatedAt, warnings: discovery.warnings || [], path: discovery.path, name: discovery.name }); return;
      }
      if (req.method === 'POST' && path === '/api/agents') {
        const data = await body(req);
        if (data?.provider === 'cli') {
          if (['path', 'filePath', 'cliPath', 'command', 'args', 'profile'].some(key => Object.hasOwn(data, key))) throw new InputError('不能直接提交程序路径或命令，请从 Windows 文件窗口选择。');
          if (data.cliSelectionId) {
            if (data.cliProfile) throw new InputError('文件选择与已有 CLI 配置只能选择一种。');
            const selection = selections.get(data.cliSelectionId);
            if (!selection || selection.expiresAt <= Date.now()) throw new InputError('文件选择已失效，请重新选择 Agent 文件。');
            if (selection.busy || selection.consumed) throw new InputError('此文件选择已提交，请等待结果或重新选择。', 409);
            requireModel(selection.discovery, data.model);
            const candidate = { ...data, cliProfile: selection.discovery.profile.id };
            validateAgent(candidate);
            selection.busy = true;
            try {
              await cliCatalog.registerProfile(selection.discovery.profile);
              const agent = engine.addAgent(candidate);
              selection.consumed = true;
              json(res, 201, agent); return;
            } finally { selection.busy = false; }
          }
          if (!(await profiles()).some(p => p.id === data.cliProfile && p.available)) throw new InputError('CLI 配置不存在或程序不可用');
          requireModel(await cliCatalog.discoverProfile(data.cliProfile), data.model);
        }
        json(res, 201, engine.addAgent(data)); return;
      }
      const agentMatch = /^\/api\/agents\/([\w-]+)$/.exec(path);
      if (req.method === 'DELETE' && agentMatch) { engine.removeAgent(agentMatch[1]); json(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && path === '/api/runs') { json(res, 201, engine.createRun(await body(req))); return; }
      const chatMatch = /^\/api\/runs\/([\w-]+)\/chat$/.exec(path);
      if (req.method === 'POST' && chatMatch) { json(res, 202, engine.chat(chatMatch[1], await body(req))); return; }
      const runMatch = /^\/api\/runs\/([\w-]+)\/(approve|cancel|export)$/.exec(path);
      if (runMatch) {
        const [, id, action] = runMatch;
        if (req.method === 'POST' && action === 'approve') { json(res, 200, engine.approve(id, await body(req))); return; }
        if (req.method === 'POST' && action === 'cancel') { await body(req); json(res, 200, engine.cancel(id)); return; }
        if (req.method === 'GET' && action === 'export') {
          const report = markdown(engine.getRun(id));
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="agent-run-${id}.md"` }); res.end(report); return;
        }
      }
      throw new InputError('接口不存在', 404);
    } catch (error) { if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : '服务内部错误，请检查服务终端' }); else res.end(); if (!error.status) console.error(error); }
  });
  return { server, engine, cancelPicker: () => pickerController?.abort() };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
  const { server, engine, cancelPicker } = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`Agent Workbench: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
  const shutdown = () => { cancelPicker(); for (const c of engine.controllers.values()) c.abort(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
