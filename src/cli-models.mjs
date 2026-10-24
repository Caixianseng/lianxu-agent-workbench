import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const error = message => Object.assign(new Error(message), { status: 400 });
const modelId = value => typeof value === 'string' && value.length <= 160 && value.length > 0 && !/[\r\n\0*]/.test(value) && !value.startsWith('-');

export function parseModelListing(kind, output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (kind === 'opencode') return [...new Set(clean.split(/\r?\n/).map(line => line.trim()).filter(line => modelId(line) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/#-]+$/.test(line)))].map(id => ({ id, name: id }));
  // Official @qoder-ai/qodercli 1.1.77 formatModelListText emits MODEL, then
  // system display names or custom "display name (modelID)". Custom IDs over
  // 40 characters are truncated by the CLI and cannot be safely selected.
  let data;
  try { data = JSON.parse(clean); } catch { /* Plain table variants are handled below. */ }
  const found = [];
  const rows = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const row of value) rows(row); return; }
    const id = value.modelID || value.modelId || value.id || value.name;
    if (modelId(id)) found.push({ id, name: typeof value.name === 'string' ? value.name.slice(0, 160) : id });
    for (const key of ['models', 'default', 'new', 'custom', 'data', 'groups', 'items']) if (value[key]) rows(value[key]);
  };
  if (data) rows(data);
  if (!data) {
    const lines = clean.split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== 'MODEL') return [];
    for (const line of lines.slice(1)) {
      if (!line || /[…]/.test(line) || line.endsWith('...')) continue;
      const custom = /^(.*?) \(([^()]+)\)$/.exec(line);
      const id = custom ? custom[2] : line;
      if (modelId(id)) found.push({ id, name: custom ? custom[1] : id });
    }
  }
  return [...new Map(found.map(row => [row.id, row])).values()];
}

export async function readCliModels(kind, location, { env = process.env, signal } = {}) {
  const args = [...(location.prefix || []), ...(kind === 'opencode' ? ['models', '--pure'] : ['--list-models'])];
  const environment = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|ELECTRON_RUN_AS_NODE|OPENCODE_CONFIG_CONTENT)$/i.test(key)));
  let stdout;
  try {
    ({ stdout } = await exec(location.command, args, { env: environment, cwd: path.dirname(location.command), shell: false, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', signal }));
  } catch (cause) {
    if (signal?.aborted) throw cause;
    if (kind === 'qoder' && /not logged in|authenticate|please log.?in/i.test(String(cause.stderr || ''))) {
      return { models: [], source: 'Qoder CLI 当前账号', warnings: ['Qoder CLI 尚未登录。请双击项目 scripts\\login-qoder.cmd 完成官方登录，再重新选择 Qoder 程序；桌面启动器本身不能执行协同任务。'], loginRequired: true };
    }
    throw error(`${kind === 'opencode' ? 'OpenCode' : 'Qoder'} 模型列表读取失败，请检查 CLI 安装、网络及登录状态。`);
  }
  const models = parseModelListing(kind, stdout);
  if (models.length > 500) throw error('模型列表超过 500 项，请缩小 CLI 中的模型配置。');
  return { models, source: `${kind === 'opencode' ? 'OpenCode models' : 'Qoder --list-models'} 命令`, warnings: [kind === 'opencode' ? '模型来自 OpenCode 配置的服务商列表，具体权限和费用由该服务商决定。' : '模型来自 Qoder CLI 当前账号，执行权限以该账号为准。', ...(kind === 'qoder' && /…/.test(stdout) ? ['CLI 截断了部分自定义模型 ID，已跳过这些条目；可通过 JSON 清单提供完整模型 ID。'] : []), ...(!models.length ? ['CLI 未返回可识别的模型列表；请检查当前账号及模型配置。'] : [])] };
}
