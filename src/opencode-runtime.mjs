import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../data/runtime/', import.meta.url));

export function parseJsonc(source) {
  let result = '', quoted = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; result += '\n'; }
    else if (char === '/' && next === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i++; result += ' '; }
    else result += char;
  }
  let cleaned = ''; quoted = false; escaped = false;
  for (let i = 0; i < result.length; i++) {
    const char = result[i];
    if (quoted) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; cleaned += char; }
    else if (!(char === ',' && /^[\s]*[}\]]/.test(result.slice(i + 1)))) cleaned += char;
  }
  return JSON.parse(cleaned.replace(/^\uFEFF/, ''));
}

/** Preserve connection settings in memory, while excluding user tools/agents/hooks. */
export async function prepareOpenCodeRuntime(env, { readEnv = process.env } = {}) {
  const home = readEnv.USERPROFILE || readEnv.HOME;
  const configRoot = readEnv.XDG_CONFIG_HOME || (home && path.join(home, '.config'));
  const files = configRoot ? ['config.json', 'opencode.json', 'opencode.jsonc'].map(name => path.join(configRoot, 'opencode', name)) : [];
  if (readEnv.OPENCODE_CONFIG) files.push(readEnv.OPENCODE_CONFIG);
  const connection = {};
  for (const file of files) {
    let source;
    try {
      if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('config too large');
      source = await readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') continue; throw new Error('无法读取 OpenCode 服务商配置'); }
    let value;
    try { value = parseJsonc(source); } catch { throw new Error('OpenCode 服务商配置 JSON/JSONC 无法解析'); }
    if (value.provider && typeof value.provider === 'object' && !Array.isArray(value.provider)) connection.provider = { ...(connection.provider || {}), ...value.provider };
    for (const key of ['enabled_providers', 'disabled_providers']) if (Array.isArray(value[key])) connection[key] = value[key];
  }
  const secrets = [];
  const collect = (value, key = '') => {
    if (typeof value === 'string') {
      if (/(key|token|secret|password|credential)/i.test(key) && value.length >= 6) secrets.push(value);
      for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (typeof readEnv[match[1]] === 'string') {
        env[match[1]] = readEnv[match[1]];
        if (readEnv[match[1]].length >= 6) secrets.push(readEnv[match[1]]);
      }
    } else if (Array.isArray(value)) value.forEach(item => collect(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => collect(item, name));
  };
  collect(connection);
  await mkdir(ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(ROOT, 'opencode-run-'));
  env.XDG_CONFIG_HOME = directory;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...connection, plugin: [], mcp: {}, permission: { '*': 'deny' }, agent: { workbench: { mode: 'primary', permission: { '*': 'deny' }, tools: {} } }, share: 'disabled', autoupdate: false });
  return { secrets, cleanup: async () => {
    const relative = path.relative(ROOT, directory);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) await rm(directory, { recursive: true, force: true });
  } };
}
