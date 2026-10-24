import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, prepareOpenCodeRuntime } from '../src/opencode-runtime.mjs';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = path.resolve(testsDirectory, '..', 'data', 'runtime');

async function fixture(t) {
  const directory = await mkdtemp(path.join(testsDirectory, '.opencode-runtime-test-'));
  const home = path.join(directory, 'home');
  const config = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  await mkdir(path.dirname(config), { recursive: true });
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(testsDirectory));
    assert.ok(path.basename(target).startsWith('.opencode-runtime-test-'));
    await rm(target, { recursive: true, force: true });
  });
  async function prepare(value, { env = {}, readEnv = {} } = {}) {
    const source = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(config, source);
    // Supplying readEnv prevents discovery from using real process.env or user files.
    const runtime = await prepareOpenCodeRuntime(env, { readEnv: { USERPROFILE: home, ...readEnv } });
    t.after(() => runtime.cleanup());
    return { runtime, env, source, content: JSON.parse(env.OPENCODE_CONFIG_CONTENT) };
  }
  return { directory, home, config, prepare };
}

async function assertNoSecretsOnDisk(directory, secrets) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoSecretsOnDisk(file, secrets);
    else if (entry.isFile()) {
      const bytes = await readFile(file);
      for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, 'Runtime file must not contain secret material');
    }
  }
}

test('JSONC keeps quoted URL, comment markers, escaped quotes and commas intact', () => {
  const literals = {
    url: 'https://example.invalid/v1//literal?closing=,]&other=,}',
    commentMarkers: 'text /* keep this */ and // keep this too',
    escaped: 'a "quoted" value and \\backslash',
    commaText: 'a, b, } and , ] remain unchanged',
  };
  const source = '\uFEFF/* leading block comment */\n{\n'
    + `"literals": ${JSON.stringify(literals)}, // line comment\n`
    + '"list": [1, 2,],\n'
    + '/* another block comment */ "last": true,\n}\n';
  assert.deepEqual(parseJsonc(source), { literals, list: [1, 2], last: true });
});

test('JSONC removes trailing commas followed by comments', async t => {
  for (const [name, source, expected] of [
    ['object block comment', '{"value": 1, /* final entry */}', { value: 1 }],
    ['object line comment', '{"value": 1, // final entry\n}', { value: 1 }],
    ['array block comment', '[1, 2, /* final entry */]', [1, 2]],
    ['array line comment', '[1, 2, // final entry\n]', [1, 2]],
  ]) {
    await t.test(name, () => assert.deepEqual(parseJsonc(source), expected));
  }
});

test('JSONC rejects malformed JSON instead of silently changing its meaning', () => {
  assert.throws(() => parseJsonc('{"value": "unfinished}'), SyntaxError);
  assert.throws(() => parseJsonc('{"value": 1 /* comment */ 2}'), SyntaxError);
});

test('runtime preserves only connection configuration and replaces user tools, agents and permissions', async t => {
  const f = await fixture(t);
  const inlineKey = 'fixture-inline-api-key-not-real';
  const headerToken = 'fixture-inline-header-token-not-real';
  const provider = {
    custom: {
      name: 'Fixture provider',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://example.invalid/v1', apiKey: inlineKey, headers: { 'X-Access-Token': headerToken } },
      models: { 'fixture-model': { name: 'Fixture Model', limit: { context: 32000, output: 4096 } } },
    },
  };
  const value = {
    provider, enabled_providers: ['custom'], disabled_providers: ['disabled-fixture'],
    plugin: ['fixture-plugin-must-not-load'],
    mcp: { unsafe: { command: ['fixture-command-must-not-run'] } },
    agent: { personal: { prompt: 'fixture-agent-prompt-must-not-copy', tools: { shell: true } } },
    hooks: { postRun: 'fixture-hook-must-not-copy' },
    instructions: ['fixture-instructions-must-not-copy'],
    permission: { '*': 'allow' }, share: 'auto', autoupdate: true,
  };
  const { runtime, env, content, source } = await f.prepare(value, { env: { KEEP_EXISTING: 'preserved' } });
  assert.deepEqual(content.provider, provider);
  assert.deepEqual(content.enabled_providers, ['custom']);
  assert.deepEqual(content.disabled_providers, ['disabled-fixture']);
  assert.deepEqual(Object.keys(content).sort(), ['agent', 'autoupdate', 'disabled_providers', 'enabled_providers', 'mcp', 'permission', 'plugin', 'provider', 'share']);
  assert.deepEqual(content.plugin, []);
  assert.deepEqual(content.mcp, {});
  assert.deepEqual(content.permission, { '*': 'deny' });
  assert.deepEqual(content.agent, { workbench: { mode: 'primary', permission: { '*': 'deny' }, tools: {} } });
  assert.equal(content.share, 'disabled');
  assert.equal(content.autoupdate, false);
  for (const prohibited of ['fixture-plugin-must-not-load', 'fixture-command-must-not-run', 'fixture-agent-prompt-must-not-copy', 'fixture-hook-must-not-copy', 'fixture-instructions-must-not-copy']) {
    assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes(prohibited));
  }
  assert.equal(env.KEEP_EXISTING, 'preserved');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(path.dirname(env.XDG_CONFIG_HOME), runtimeDirectory);
  assert.match(path.basename(env.XDG_CONFIG_HOME), /^opencode-run-/);
  assert.notEqual(env.XDG_CONFIG_HOME, path.join(f.home, '.config'));
  assert.equal((await stat(env.XDG_CONFIG_HOME)).isDirectory(), true);
  assert.ok(runtime.secrets.includes(inlineKey));
  assert.ok(runtime.secrets.includes(headerToken));
  await assertNoSecretsOnDisk(env.XDG_CONFIG_HOME, [inlineKey, headerToken]);
  assert.equal(await readFile(f.config, 'utf8'), source);
});

test('referenced environment values are imported and secret values are returned for redaction', async t => {
  const f = await fixture(t);
  const apiKey = 'fixture-referenced-api-key-not-real';
  const token = 'fixture-referenced-header-token-not-real';
  const baseURL = 'https://fixture.invalid/v1';
  const value = {
    provider: {
      custom: {
        options: {
          apiKey: '{env:WORKBENCH_API_KEY}',
          baseURL: '{env:WORKBENCH_BASE_URL}',
          headers: { 'X-Access-Token': 'Bearer {env:WORKBENCH_TOKEN}' },
          missing: '{env:UNSET_FIXTURE_VALUE}',
        },
      },
    },
  };
  const { runtime, env, content } = await f.prepare(value, {
    readEnv: {
      WORKBENCH_API_KEY: apiKey,
      WORKBENCH_TOKEN: token,
      WORKBENCH_BASE_URL: baseURL,
      UNREFERENCED_SECRET: 'must-not-be-imported',
    },
  });
  assert.equal(env.WORKBENCH_API_KEY, apiKey);
  assert.equal(env.WORKBENCH_TOKEN, token);
  assert.equal(env.WORKBENCH_BASE_URL, baseURL);
  assert.equal(Object.hasOwn(env, 'UNREFERENCED_SECRET'), false);
  assert.equal(Object.hasOwn(env, 'UNSET_FIXTURE_VALUE'), false);
  assert.deepEqual(content.provider, value.provider);
  assert.ok(runtime.secrets.includes(apiKey), 'Resolved API key must be redacted, not only its {env:...} placeholder');
  assert.ok(runtime.secrets.includes(token), 'Resolved header token must be included in the redaction values');
  await assertNoSecretsOnDisk(env.XDG_CONFIG_HOME, [apiKey, token]);
});

test('explicit XDG config stays confined to the fixture and cleanup removes only the generated runtime', async t => {
  const f = await fixture(t);
  await writeFile(f.config, JSON.stringify({ provider: { unused: { name: 'Default home config must not be loaded' } } }));
  const configHome = path.join(f.directory, 'custom-xdg');
  const configFile = path.join(configHome, 'opencode', 'opencode.jsonc');
  await mkdir(path.dirname(configFile), { recursive: true });
  const source = '{ /* fixture only */ "provider": {"chosen": {"name":"Explicit config"}}, }';
  await writeFile(configFile, source);
  const env = {};
  const runtime = await prepareOpenCodeRuntime(env, { readEnv: { USERPROFILE: f.home, XDG_CONFIG_HOME: configHome } });
  t.after(() => runtime.cleanup());
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider, { chosen: { name: 'Explicit config' } });
  const generated = env.XDG_CONFIG_HOME;
  assert.equal(path.dirname(generated), runtimeDirectory);
  assert.notEqual(generated, configHome);
  await runtime.cleanup();
  await assert.rejects(stat(generated), { code: 'ENOENT' });
  await runtime.cleanup();
  assert.equal(await readFile(configFile, 'utf8'), source);
  assert.equal((await stat(f.config)).isFile(), true);
});

test('invalid fixture configuration fails without consulting real user configuration', async t => {
  const f = await fixture(t);
  await writeFile(f.config, '{invalid jsonc');
  await assert.rejects(
    prepareOpenCodeRuntime({}, { readEnv: { USERPROFILE: f.home } }),
    /JSON\/JSONC 无法解析/,
  );
});
