import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const activeStatuses = new Set(['planning', 'awaiting_approval', 'running']);
export function initialState() {
  const skills = ['general', 'coding', 'analysis', 'writing', 'testing'];
  return { version: 1, agents: [
    { id: 'demo-lead', name: 'Atlas · 主导', provider: 'demo', model: 'demo-reasoner', tier: 3, skills: [...skills, 'planning'] },
    { id: 'demo-builder', name: 'Nova · 执行', provider: 'demo', model: 'demo-balanced', tier: 2, skills: [...skills] },
    { id: 'demo-light', name: 'Spark · 轻量', provider: 'demo', model: 'demo-fast', tier: 1, skills: [...skills] }
  ], runs: [] };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : initialState();
    if (this.state.version !== 1 || !Array.isArray(this.state.agents) || !Array.isArray(this.state.runs)) throw new Error('状态文件格式无效，请保留原文件后检查。');
    // A restarted process cannot attest that an interrupted request completed.
    for (const run of this.state.runs) {
      if (!Array.isArray(run.messages)) run.messages = [{ id: randomUUID(), role: 'user', content: run.goal, time: run.createdAt || new Date().toISOString() }];
      if (run.chatBusy) {
        run.chatError = '服务重启打断了上轮聊天，任务分配未继续更新。请检查当前建议后重新发送。';
        if (run.messages.length < 100) run.messages.push({ id: randomUUID(), role: 'assistant', content: run.chatError, time: new Date().toISOString() });
      }
      run.chatBusy = false;
      run.chatError ||= '';
      run.routingRevision ||= 0;
      if (['planning', 'running'].includes(run.status)) {
        run.status = 'interrupted';
        run.error = '服务重启打断了运行。请新建运行；已确认的历史产物保留。';
        for (const task of run.tasks) if (!['passed', 'needs_attention', 'blocked'].includes(task.status)) task.status = 'cancelled';
      }
    }
    this.save();
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
  }
}
