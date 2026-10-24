import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBuiltinCliProfile, readCliProfileDefinitions, resolveCliExecutable, validateCliProfile } from './providers.mjs';
import { findLocalCli } from './cli-locations.mjs';
import { readCliModels } from './cli-models.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'cli-profiles.json');
const MODEL_ENV_NAMES = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
const writes = new Map();
function bad(message) { const error = new Error(message); error.status = 400; return error; }
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);

async function readJson(file, label, optional = false) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw bad(`${label}必须是小于 2 MiB 的普通文件`);
    const value = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!ownObject(value)) throw bad(`${label}必须包含 JSON 对象`);
    return { value, mtime: info.mtime.toISOString() };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.status) throw error;
    throw bad(`无法读取${label}，请检查文件是否存在、权限及 JSON 格式`);
  }
}

function modelRows(values, strict = false) {
  if (!Array.isArray(values) || values.length > 500) {
    if (strict) throw bad('模型清单 models 必须是最多 500 项的数组');
    return [];
  }
  const models = [];
  const seen = new Set();
  for (const value of values) {
    const rawId = typeof value === 'string' ? value : value?.id;
    const id = typeof rawId === 'string' ? rawId.trim() : rawId;
    if (typeof id !== 'string' || !id || id.length > 160 || /[\r\n\0*]/.test(id) || id.startsWith('-')) {
      if (strict) throw bad('模型清单包含无效模型 ID');
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof value?.name === 'string' && value.name.trim() ? value.name.slice(0, 160) : id;
    const description = typeof value?.description === 'string' ? value.description.slice(0, 800) : undefined;
    models.push({ id, name, ...(description ? { description } : {}) });
  }
  if (strict && models.length === 0) throw bad('模型清单至少需要一个明确的模型 ID');
  return models;
}

function localId(kind, file) {
  const normalized = process.platform === 'win32' ? file.toLowerCase() : file;
  return `local-${kind}-${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

/** Discovery does not run GUI apps or inference; recognized CLIs may list models. */
export function createCliCatalog({ env = process.env, configPath = DEFAULT_CONFIG, now = () => Date.now(), locateCli = findLocalCli, readModels = readCliModels } = {}) {
  const home = env.USERPROFILE || env.HOME;
  const codexHome = env.CODEX_HOME || (home ? path.join(home, '.codex') : undefined);
  const claudeHome = env.CLAUDE_CONFIG_DIR || (home ? path.join(home, '.claude') : undefined);
  const discoveredProfiles = new WeakMap();

  async function codexModels() {
    const warnings = ['模型来自 Codex 本地缓存，可能已过期或属于之前登录的账号；实际可用性由调用时的账号权限决定。'];
    if (!codexHome) return { models: [], source: '未找到 Codex 用户目录', warnings };
    const file = path.join(codexHome, 'models_cache.json');
    let cache;
    try { cache = await readJson(file, 'Codex 模型缓存', true); }
    catch { return { models: [], source: 'Codex 本地模型缓存', warnings: [...warnings, '本地模型缓存无法解析，请先在 Codex 中登录并刷新模型列表。'] }; }
    if (!cache) return { models: [], source: '未找到 Codex 模型缓存', warnings: [...warnings, '请先打开 Codex 并登录，让 CLI/桌面端生成模型缓存，再重新加载。'] };
    const values = Array.isArray(cache.value.models) ? cache.value.models.filter(item => ownObject(item) && (item.visibility === 'list' || item.visibility === undefined)).map(item => ({ id: item.slug || item.id, name: item.display_name || item.name, description: item.description })) : [];
    const updatedAt = Number.isFinite(Date.parse(cache.value.fetched_at)) ? new Date(cache.value.fetched_at).toISOString() : cache.mtime;
    if (now() - Date.parse(updatedAt) > 24 * 60 * 60 * 1000) warnings.push('缓存超过 24 小时；建议在 Codex 中刷新后重新加载。');
    const models = modelRows(values);
    if (!models.length) warnings.push('缓存中没有可展示的模型；请刷新 Codex 模型列表。');
    return { models, source: `Codex 本地缓存：${file}`, updatedAt, warnings };
  }

  async function claudeModels() {
    const values = [];
    const sources = [];
    const warnings = ['这里只列出本机明确配置的模型，不代表账号所有可用模型，也未验证授权。'];
    let updatedAt;
    if (claudeHome) {
      const file = path.join(claudeHome, 'settings.json');
      let settings;
      try { settings = await readJson(file, 'Claude 模型设置', true); }
      catch { warnings.push('Claude settings.json 无法解析，请检查本地设置。'); }
      if (settings) {
        if (typeof settings.value.model === 'string') values.push(settings.value.model);
        if (Array.isArray(settings.value.availableModels)) values.push(...settings.value.availableModels);
        for (const key of MODEL_ENV_NAMES) if (typeof settings.value.env?.[key] === 'string') values.push(settings.value.env[key]);
        sources.push(file);
        updatedAt = settings.mtime;
      }
    }
    for (const key of MODEL_ENV_NAMES) if (typeof env[key] === 'string' && env[key]) { values.push(env[key]); sources.push(key); }
    const models = modelRows(values);
    if (!models.length) warnings.push('未发现明确模型。可先在 Claude Code 中选择模型并保存，或选择包含 models 的本地 JSON 清单。');
    return { models, source: sources.length ? `Claude 本地配置：${sources.join('、')}` : '未找到 Claude 明确模型配置', ...(updatedAt ? { updatedAt } : {}), warnings };
  }

  async function modelsFor(profile, { signal } = {}) {
    const kind = profile.catalogKind || (profile.id === 'codex' ? 'codex' : profile.id === 'claude' ? 'claude' : null);
    if (kind === 'codex') return codexModels();
    if (kind === 'claude') return claudeModels();
    if (kind === 'opencode' || kind === 'qoder') return readModels(kind, { command: profile.command, prefix: profile.cliPrefix || [] }, { env, signal });
    if (profile.catalogSourcePath) {
      const manifest = await readJson(profile.catalogSourcePath, 'CLI 模型清单');
      return { models: modelRows(manifest.value.models, true), source: `本地 JSON 清单：${profile.catalogSourcePath}`, updatedAt: manifest.mtime, warnings: ['模型由本地清单声明，未在线验证授权。'] };
    }
    const models = modelRows(profile.models);
    return { models, source: '本地 CLI 配置', warnings: models.length ? ['模型由本地配置声明，未在线验证授权。'] : ['此 CLI 配置未声明 models；请选择带模型清单的 JSON 文件或在本地配置中补充。'] };
  }

  async function discoverCliFile(filePath, { signal } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') || filePath.length > 4096) throw bad('请选择本机文件的绝对路径');
    const file = path.resolve(filePath);
    let info;
    try { info = await stat(file); } catch { throw bad('所选文件不存在或无法读取'); }
    if (!info.isFile()) throw bad('请选择 CLI 可执行文件或 JSON 清单，不能选择目录');
    if (/\.(cmd|bat|ps1)$/i.test(file)) throw bad('不执行 shell 启动脚本。请选择原生 .exe，或用 JSON 清单指定 node 可执行文件与 JS 入口。');
    let profile;
    let kind;
    let catalog;
    if (/\.json$/i.test(file)) {
      const manifest = await readJson(file, 'CLI 模型清单');
      const value = manifest.value;
      const definition = ownObject(value.profile) ? value.profile : value;
      if (typeof definition.command !== 'string' || !definition.command.trim()) throw bad('JSON 清单需要 command、args、outputFormat 和 models');
      const command = path.resolve(path.dirname(file), definition.command);
      if (!(await resolveCliExecutable(command, env))) throw bad('清单 command 未指向可用的原生可执行文件；Windows 请使用 .exe');
      profile = { id: localId('manifest', file), name: typeof value.name === 'string' ? value.name : definition.name, command, args: definition.args, outputFormat: definition.outputFormat, envAllowList: definition.envAllowList || [], catalogKind: 'manifest', catalogSourcePath: file, models: modelRows(value.models, true) };
      if (definition.timeoutMs !== undefined) profile.timeoutMs = definition.timeoutMs;
      if (definition.cwd !== undefined) {
        if (typeof definition.cwd !== 'string') throw bad('清单 cwd 必须为路径字符串');
        profile.cwd = path.resolve(path.dirname(file), definition.cwd);
      }
      try { validateCliProfile(profile); } catch (error) { throw bad(error.message); }
      if (profile.name.length > 160 || profile.args.length > 128 || profile.args.some(arg => arg.length > 8192)) throw bad('清单名称或参数超过大小限制');
      kind = 'manifest';
      catalog = { models: profile.models, source: `本地 JSON 清单：${file}`, updatedAt: manifest.mtime, warnings: ['此清单包含可信本地程序及固定参数；添加后将按其配置执行，请确认来源可信。', '模型由本地清单声明，未在线验证授权。'] };
    } else {
      const basename = path.basename(file).toLowerCase();
      if (['codex.exe', 'codex'].includes(basename)) kind = 'codex';
      else if (['claude.exe', 'claude'].includes(basename)) kind = 'claude';
      else if (['opencode.exe', 'opencode-cli.exe', 'opencode'].includes(basename)) kind = 'opencode';
      else if (['qoder launcher.exe', 'qoder.exe', 'qodercli.exe', 'qoder', 'qodercli'].includes(basename)) kind = 'qoder';
      else throw bad('无法识别该程序的模型协议。支持 Codex、Claude、OpenCode、Qoder，或带 models 的 JSON 清单。');
      if (!(await resolveCliExecutable(file, env))) throw bad('所选文件不是可用的原生可执行文件');
      const location = ['opencode', 'qoder'].includes(kind) ? await locateCli(kind, { env, selectedPath: file }) : { command: file, prefix: [] };
      if (!location) throw bad(`${kind === 'opencode' ? 'OpenCode' : 'Qoder'} 桌面程序已识别，但未找到对应 CLI。请安装官方 CLI 后重新选择；桌面启动器不能直接执行任务。`);
      profile = { ...makeBuiltinCliProfile(kind, location.command), id: localId(kind, file), catalogKind: kind };
      if (location.prefix?.length) { profile.cliPrefix = location.prefix; profile.args.unshift(...location.prefix); }
      delete profile.builtin;
      catalog = await modelsFor(profile, { signal });
      if (location.desktop) catalog.warnings.unshift(`已识别桌面程序，自动定位到命令行入口：${location.command}${location.prefix?.length ? ` · ${location.prefix[0]}` : ''}`);
      catalog.warnings.push('按 CLI 文件名识别适配器，未验证发布者签名；请确认所选文件为可信的官方 CLI。');
    }
    discoveredProfiles.set(profile, JSON.stringify(profile));
    return { profile, kind, name: profile.name, path: file, ...catalog };
  }

  async function discoverProfileModels(profileId) {
    if (typeof profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profileId)) throw bad('CLI 配置 ID 无效');
    let profiles;
    try { profiles = await readCliProfileDefinitions({ env, configPath }); } catch (error) { throw bad(error.message); }
    const profile = profiles.find(item => item.id === profileId);
    if (!profile) throw bad('所选 CLI 配置不存在');
    const executable = profile.enabled === false ? undefined : await resolveCliExecutable(profile.command, env);
    const catalog = await modelsFor(profile);
    if (!executable) catalog.warnings.push('此 CLI 当前不可执行；安装或修正本地路径后才能运行。');
    return { profileId: profile.id, kind: profile.catalogKind || (profile.builtin ? profile.id : 'manifest'), name: profile.name, path: executable || profile.command, available: !!executable, ...catalog };
  }

  async function registerCliProfile(profile) {
    // Only an untouched profile produced by this server-side discovery can be registered.
    // The HTTP layer keeps it server-side; accepting arbitrary browser argv is prohibited.
    if (!profile || discoveredProfiles.get(profile) !== JSON.stringify(profile)) throw bad('请先选择并识别本地文件，再添加 Agent；不能从网页直接提交命令配置');
    const operation = async () => {
      const existing = await readJson(configPath, 'CLI 配置', true);
      const config = existing?.value || { profiles: [] };
      if (!Array.isArray(config.profiles) || config.profiles.length > 32) throw bad('现有 CLI profiles 配置无效');
      const index = config.profiles.findIndex(item => item.id === profile.id);
      const stored = structuredClone(profile);
      if (index >= 0) config.profiles[index] = stored;
      else { if (config.profiles.length === 32) throw bad('最多保存 32 个本地 CLI 配置'); config.profiles.push(stored); }
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      try { await mkdir(path.dirname(configPath), { recursive: true }); await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, configPath); }
      catch { throw bad('无法保存本地 CLI 配置，请检查目录写入权限'); }
      finally { await unlink(temporary).catch(() => {}); }
      return stored;
    };
    const previous = writes.get(configPath) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    writes.set(configPath, pending);
    try { return await pending; } finally { if (writes.get(configPath) === pending) writes.delete(configPath); }
  }

  return { discoverCliFile, discoverProfileModels, registerCliProfile };
}

const defaultCatalog = createCliCatalog();
export const discoverCliFile = (...args) => defaultCatalog.discoverCliFile(...args);
export const discoverProfileModels = (...args) => defaultCatalog.discoverProfileModels(...args);
export const registerCliProfile = (...args) => defaultCatalog.registerCliProfile(...args);
