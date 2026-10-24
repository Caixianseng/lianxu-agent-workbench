import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNativePicker } from '../src/native-picker.mjs';

const ROOT = 'C:\\agent workbench';
const BINARY = `${ROOT}\\bin\\NativePicker.exe`;
const SOURCE = `${ROOT}\\scripts\\NativePicker.cs`;
const COMPILER64 = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const COMPILER32 = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
const selected = 'C:\\Users\\tester\\Agent Files\\codex.exe';

function fixture({ files = { [BINARY]: 20, [SOURCE]: 10 }, behavior, options = {} } = {}) {
  const calls = [];
  const madeDirectories = [];
  const children = [];
  const fs = {
    async stat(file) {
      if (!Object.hasOwn(files, file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, mtimeMs: files[file] };
    },
    async mkdir(directory) { madeDirectories.push(directory); },
  };
  const spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.pid = 500 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killCalls = [];
    child.kill = signal => { child.killCalls.push(signal); queueMicrotask(() => child.emit('close', null)); return true; };
    children.push(child);
    calls.push({ command, args, options: spawnOptions });
    queueMicrotask(() => {
      if (behavior) behavior(child, command, args, files);
      else if (command === BINARY) { child.stdout.write(JSON.stringify({ path: selected })); child.emit('close', 0); }
      else { files[BINARY] = 30; child.stdout.write('compile complete'); child.emit('close', 0); }
    });
    return child;
  };
  const picker = createNativePicker({ root: ROOT, platform: 'win32', env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\tester', PRIVATE_API_KEY: 'must-not-inherit' }, fs, spawnImpl, killGraceMs: 10, ...options });
  return { picker, calls, children, files, madeDirectories };
}

test('fresh picker runs fixed executable without shell or browser-supplied arguments', async () => {
  const f = fixture();
  assert.equal(await f.picker.pickNativeAgentFile(), selected);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, BINARY);
  assert.deepEqual(f.calls[0].args, []);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.windowsHide, false);
  assert.equal(f.calls[0].options.env.PRIVATE_API_KEY, undefined);
  assert.equal(f.children[0].listenerCount('close'), 0);
  assert.equal(f.children[0].stdout.listenerCount('data'), 0);
});

test('missing or stale binary compiles through fixed Framework flags before opening', async () => {
  for (const binaryInfo of [undefined, 1]) {
    const files = { [SOURCE]: 10, [COMPILER64]: 1 };
    if (binaryInfo !== undefined) files[BINARY] = binaryInfo;
    const f = fixture({ files });
    assert.equal(await f.picker.pickNativeAgentFile(), selected);
    assert.deepEqual(f.calls.map(call => call.command), [COMPILER64, BINARY]);
    assert.equal(f.calls[0].options.windowsHide, true);
    assert.equal(f.calls[1].options.windowsHide, false);
    assert.deepEqual(f.calls[0].args, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll', `/out:${BINARY}`, SOURCE]);
    assert.deepEqual(f.madeDirectories, [`${ROOT}\\bin`]);
  }
});

test('Framework32 is used when Framework64 compiler is unavailable', async () => {
  const f = fixture({ files: { [SOURCE]: 10, [COMPILER32]: 1 } });
  await f.picker.pickNativeAgentFile();
  assert.equal(f.calls[0].command, COMPILER32);
});

test('concurrent callers share a single compilation', async () => {
  const f = fixture({ files: { [SOURCE]: 10, [COMPILER64]: 1 } });
  const result = await Promise.all([f.picker.pickNativeAgentFile(), f.picker.pickNativeAgentFile()]);
  assert.deepEqual(result, [selected, selected]);
  assert.equal(f.calls.filter(call => call.command === COMPILER64).length, 1);
});

test('dialog cancel returns null while malformed or relative outputs reject safely', async () => {
  const f = fixture({ behavior(child) { child.stdout.write('{"cancelled":true}'); child.emit('close', 0); } });
  assert.equal(await f.picker.pickNativeAgentFile(), null);
  for (const output of ['secret-private-invalid-json', '[]', '{"path":"relative.exe"}', '{"cancelled":true,"path":"C:/bad.exe"}']) {
    const bad = fixture({ behavior(child) { child.stdout.write(output); child.emit('close', 0); } });
    await assert.rejects(bad.picker.pickNativeAgentFile(), error => error.status === 400 && !error.message.includes('secret-private'));
  }
});

test('pre-abort prevents spawning and in-flight abort kills only its own child', async () => {
  const early = fixture();
  const pre = new AbortController(); pre.abort();
  await assert.rejects(early.picker.pickNativeAgentFile({ signal: pre.signal }), { name: 'AbortError' });
  assert.equal(early.calls.length, 0);
  const f = fixture({ behavior() {} });
  const controller = new AbortController();
  const pending = f.picker.pickNativeAgentFile({ signal: controller.signal });
  while (!f.children.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.children[0].killCalls, ['SIGKILL']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.children[0].listenerCount('close'), 0);
});

test('timeout terminates only its child, including a short fallback if close never arrives', async () => {
  const f = fixture({ behavior(child) { child.kill = signal => { child.killCalls.push(signal); return true; }; } });
  await assert.rejects(f.picker.pickNativeAgentFile({ timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.deepEqual(f.children[0].killCalls, ['SIGKILL']);
  assert.equal(f.children[0].stdout.destroyed, true);
  assert.equal(f.children[0].listenerCount('close'), 0);
});

test('stdout and stderr are bounded and upstream diagnostic contents are never exposed', async () => {
  for (const channel of ['stdout', 'stderr']) {
    const f = fixture({ behavior(child) { child[channel].write('private-secret-'.repeat(2000)); } });
    await assert.rejects(f.picker.pickNativeAgentFile(), error => /限制/.test(error.message) && !error.message.includes('private-secret'));
    assert.deepEqual(f.children[0].killCalls, ['SIGKILL']);
  }
  const failed = fixture({ behavior(child) { child.stderr.write('private-secret'); child.emit('close', 7); } });
  await assert.rejects(failed.picker.pickNativeAgentFile(), error => /退出码 7/.test(error.message) && !error.message.includes('private-secret'));
});

test('unsupported platform, missing compiler and spawn failure produce clear errors without fallback', async () => {
  const other = fixture({ options: { platform: 'linux' } });
  await assert.rejects(other.picker.pickNativeAgentFile(), /仅支持 Windows/);
  assert.equal(other.calls.length, 0);
  const missing = fixture({ files: { [SOURCE]: 1 } });
  await assert.rejects(missing.picker.pickNativeAgentFile(), /未找到.*编译器/);
  assert.equal(missing.calls.length, 0);
  const spawnFailure = fixture({ behavior(child) { child.emit('error', new Error('secret-spawn-detail')); } });
  await assert.rejects(spawnFailure.picker.pickNativeAgentFile(), error => /无法启动/.test(error.message) && !error.message.includes('secret-spawn-detail'));
});
