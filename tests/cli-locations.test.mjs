import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLocalCli } from '../src/cli-locations.mjs';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const marker = 'DISCOVERY FIXTURE: NOT EXECUTABLE; DO NOT LAUNCH';

async function fixture(t) {
  const root = await mkdtemp(path.join(testsDirectory, '.cli-locations-test-'));
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(testsDirectory));
    assert.ok(path.basename(target).startsWith('.cli-locations-test-'));
    await rm(target, { recursive: true, force: true });
  });
  async function file(...parts) {
    const result = path.join(root, ...parts);
    await mkdir(path.dirname(result), { recursive: true });
    await writeFile(result, marker);
    return result;
  }
  const locate = (kind, options = {}) => findLocalCli(kind, { root, env: {}, ...options });
  return { root, file, locate };
}

test('selected CLI is preferred and discovery only reads the fixture', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('chosen', 'opencode-cli.exe');
  await f.file('path', 'opencode.exe');
  const before = await readdir(path.dirname(selectedPath));
  assert.deepEqual(f.locate('opencode', { selectedPath, env: { PATH: path.join(f.root, 'path') } }), {
    command: selectedPath, prefix: [], desktop: false,
  });
  assert.equal(await readFile(selectedPath, 'utf8'), marker);
  assert.deepEqual(await readdir(path.dirname(selectedPath)), before);
});

test('OpenCode.exe without an Electron marker is a direct CLI', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('direct', 'OpenCode.exe');
  assert.deepEqual(f.locate('opencode', { selectedPath }), { command: selectedPath, prefix: [], desktop: false });
});

test('OpenCode desktop resolves its resources/opencode-cli.exe before PATH', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('desktop', 'OpenCode.exe');
  await f.file('desktop', 'resources', 'app.asar');
  const cli = await f.file('desktop', 'resources', 'opencode-cli.exe');
  await f.file('bin', 'opencode.exe');
  assert.deepEqual(f.locate('opencode', { selectedPath, env: { PATH: path.join(f.root, 'bin') } }), {
    command: cli, prefix: [], desktop: true,
  });
});

test('OpenCode desktop supports resources/bin/opencode.exe', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('desktop', 'OpenCode.exe');
  await f.file('desktop', 'resources', 'app.asar');
  const cli = await f.file('desktop', 'resources', 'bin', 'opencode.exe');
  assert.deepEqual(f.locate('opencode', { selectedPath }), { command: cli, prefix: [], desktop: true });
});

test('OpenCode resolves the npm binary under a PATH directory with case-insensitive env keys', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('desktop', 'OpenCode.exe');
  await f.file('desktop', 'resources', 'app.asar');
  const cli = await f.file('node js', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const env = { pAtH: `"${path.join(f.root, 'missing')}";"${path.join(f.root, 'node js')}"` };
  assert.deepEqual(f.locate('opencode', { selectedPath, env }), { command: cli, prefix: [], desktop: true });
});

test('PATH lookup skips Electron OpenCode and does not return it when no CLI exists', async t => {
  const f = await fixture(t);
  await f.file('desktop', 'opencode.exe');
  await f.file('desktop', 'resources', 'app.asar');
  const desktopPath = path.join(f.root, 'desktop');
  assert.equal(f.locate('opencode', { env: { PATH: desktopPath } }), null);
  const cli = await f.file('bin', 'opencode.exe');
  assert.deepEqual(f.locate('opencode', { env: { PATH: [desktopPath, path.join(f.root, 'bin')].join(path.delimiter) } }), {
    command: cli, prefix: [], desktop: false,
  });
});

test('Qoder desktop entry points resolve qodercli.exe from PATH', async t => {
  const f = await fixture(t);
  const cli = await f.file('bin', 'qodercli.exe');
  for (const name of ['Qoder Launcher.exe', 'Qoder.exe']) {
    const selectedPath = await f.file('desktop', name);
    assert.deepEqual(f.locate('qoder', { selectedPath, env: { Path: path.join(f.root, 'bin') } }), {
      command: cli, prefix: [], desktop: true,
    });
  }
});

test('selected Qoder CLI is returned directly with a case-insensitive name', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('bin', 'QoderCLI.exe');
  assert.deepEqual(f.locate('qoder', { selectedPath }), { command: selectedPath, prefix: [], desktop: false });
});

test('Qoder checks fixed user-profile and HOME installation locations', async t => {
  const locations = [
    { parts: ['.qoder', 'bin', 'qodercli', 'qodercli.exe'], key: 'uSeRpRoFiLe' },
    { parts: ['.qoder', 'bin', 'qodercli.exe'], key: 'USERPROFILE' },
    { parts: ['.local', 'bin', 'qodercli.exe'], key: 'hOmE' },
  ];
  for (const { parts, key } of locations) {
    await t.test(parts.join('/'), async t => {
      const f = await fixture(t);
      const selectedPath = await f.file('desktop', 'Qoder.exe');
      const cli = await f.file('home', ...parts);
      assert.deepEqual(f.locate('qoder', { selectedPath, env: { [key]: path.join(f.root, 'home') } }), {
        command: cli, prefix: [], desktop: true,
      });
    });
  }
});

test('Qoder falls back to its exact repository-local official npm bundle', async t => {
  const f = await fixture(t);
  const selectedPath = await f.file('desktop', 'Qoder Launcher.exe');
  const entry = await f.file('data', 'runtime', 'qoder', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js');
  assert.deepEqual(f.locate('qoder', { selectedPath }), {
    command: process.execPath, prefix: [entry], desktop: true,
  });
  assert.deepEqual(f.locate('qoder'), { command: process.execPath, prefix: [entry], desktop: false });
  const cli = await f.file('bin', 'qodercli.exe');
  assert.equal(f.locate('qoder', { selectedPath, env: { PATH: path.join(f.root, 'bin') } }).command, cli);
});

test('shell shims, directories, and desktop-only installs cannot become commands', async t => {
  const f = await fixture(t);
  for (const name of ['opencode.cmd', 'opencode.ps1', 'qodercli.cmd', 'qodercli.ps1']) await f.file('bin', name);
  await mkdir(path.join(f.root, 'bin', 'opencode.exe'));
  await f.file('desktop', 'Qoder.exe');
  await f.file('desktop', 'OpenCode.exe');
  await f.file('desktop', 'resources', 'app.asar');
  const env = { PATH: path.join(f.root, 'bin') };
  assert.equal(f.locate('opencode', { env, selectedPath: path.join(f.root, 'bin', 'opencode.cmd') }), null);
  assert.equal(f.locate('qoder', { env, selectedPath: path.join(f.root, 'bin', 'qodercli.ps1') }), null);
  assert.equal(f.locate('opencode', { env, selectedPath: path.join(f.root, 'desktop', 'OpenCode.exe') }), null);
  assert.equal(f.locate('qoder', { env, selectedPath: path.join(f.root, 'desktop', 'Qoder.exe') }), null);
});

test('lookup does not recurse into arbitrary home data or relative PATH directories', async t => {
  const f = await fixture(t);
  await f.file('home', 'Downloads', 'unrelated', 'qodercli.exe');
  await f.file('home', '.qoder', 'unrelated', 'qodercli.exe');
  await f.file('arbitrary', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  assert.equal(f.locate('qoder', { env: { HOME: path.join(f.root, 'home'), PATH: '.;relative-bin' } }), null);
  assert.equal(f.locate('opencode', { env: { PATH: '.;relative-bin' } }), null);
  assert.equal(f.locate('unsupported'), null);
  assert.equal(f.locate('__proto__'), null);
});

test('a CLI-named symlink resolving to a known desktop executable is rejected', async t => {
  const f = await fixture(t);
  const desktop = await f.file('desktop', 'Qoder.exe');
  const selectedPath = path.join(f.root, 'qodercli.exe');
  try { await symlink(desktop, selectedPath, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('File symlinks are unavailable in this environment'); return; }
    throw error;
  }
  assert.equal(f.locate('qoder', { selectedPath }), null);
});
