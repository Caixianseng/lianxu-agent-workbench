import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_STDOUT = 16 * 1024;
const MAX_STDERR = 4 * 1024;
const ENV_NAMES = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'username', 'userdomain']);

function failure(message, name = 'Error') { return Object.assign(new Error(message), { status: 400, name }); }
function abortError() { return failure('已取消系统文件选择', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

/** All inputs here are server-side dependency injection, never browser command arguments. */
export function createNativePicker({ root = ROOT, platform = process.platform, env = process.env, spawnImpl = spawn, fs = { mkdir, stat }, compilerTimeoutMs = 30000, killGraceMs = 1000 } = {}) {
  const binary = path.win32.resolve(root, 'bin', 'NativePicker.exe');
  const source = path.win32.resolve(root, 'scripts', 'NativePicker.cs');
  const systemRootKey = Object.keys(env).find(key => key.toLowerCase() === 'systemroot');
  const windowsRoot = env[systemRootKey] || 'C:\\Windows';
  const environment = Object.fromEntries(Object.entries(env).filter(([key, value]) => ENV_NAMES.has(key.toLowerCase()) && typeof value === 'string'));
  let compiling;

  function runChild(executable, args, { signal, timeoutMs, label, visible = false }) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      let child;
      // The picker is an explicitly requested WinExe UI. SW_HIDE suppresses its
      // initial form and Shown event; only the background compiler stays hidden.
      try { child = spawnImpl(executable, args, { shell: false, windowsHide: !visible, cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(failure(`${label}无法启动，请检查本机权限`)); return; }
      let done = false;
      let stopError;
      let output = [];
      let outputBytes = 0;
      let diagnosticBytes = 0;
      let timer;
      let killTimer;

      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        child.removeListener('close', onClose);
        child.removeListener('error', onError);
        child.stdout?.removeListener('data', onOutput);
        child.stderr?.removeListener('data', onDiagnostic);
        child.stdout?.removeListener('error', onStreamError);
        child.stderr?.removeListener('error', onStreamError);
        output = [];
        error ? reject(error) : resolve(value);
      };
      const stop = error => {
        if (done || stopError) return;
        stopError = error;
        clearTimeout(timer);
        // Only this invocation's compiler or picker is terminated; never kill by name.
        try { child.kill('SIGKILL'); } catch { /* The close event or bounded fallback completes cleanup. */ }
        if (!done) killTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(stopError);
        }, killGraceMs);
      };
      const onAbort = () => stop(abortError());
      const onError = () => finish(stopError || failure(`${label}无法启动，请检查程序文件和本机权限`));
      const onStreamError = () => stop(failure(`${label}输出管道读取失败`));
      const onOutput = chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_STDOUT) stop(failure(`${label}输出超过 16 KiB 限制`));
        else if (!stopError) output.push(Buffer.from(chunk));
      };
      const onDiagnostic = chunk => {
        diagnosticBytes += chunk.length;
        // Diagnostic bodies are never returned or logged: they may contain private paths or keys.
        if (diagnosticBytes > MAX_STDERR) stop(failure(`${label}诊断输出超过大小限制`));
      };
      const onClose = code => {
        if (stopError) finish(stopError);
        else if (code !== 0) finish(failure(`${label}失败（退出码 ${Number.isInteger(code) ? code : '未知'}），请检查本机环境`));
        else finish(null, Buffer.concat(output).toString('utf8'));
      };
      child.once('error', onError);
      child.once('close', onClose);
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onDiagnostic);
      child.stdout?.on('error', onStreamError);
      child.stderr?.on('error', onStreamError);
      timer = setTimeout(() => stop(failure(`${label}超时，请重新打开系统文件窗口`, 'TimeoutError')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function fileInfo(file) {
    try {
      const info = await fs.stat(file);
      return info.isFile() ? info : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('无法读取系统文件选择器文件，请检查目录权限');
    }
  }

  function waitForBuild(promise, signal) {
    checkAbort(signal);
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
      if (signal.aborted) onAbort();
    });
  }

  async function ensureBinary(signal, timeoutMs) {
    if (compiling) return waitForBuild(compiling, signal);
    const work = async () => {
      const [binaryInfo, sourceInfo] = await Promise.all([fileInfo(binary), fileInfo(source)]);
      checkAbort(signal);
      if (binaryInfo && (!sourceInfo || binaryInfo.mtimeMs >= sourceInfo.mtimeMs)) return;
      if (!sourceInfo) throw failure('缺少 scripts/NativePicker.cs，无法构建系统文件选择器');
      const candidates = ['Framework64', 'Framework'].map(folder => path.win32.join(windowsRoot, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'));
      let compiler;
      for (const candidate of candidates) if (await fileInfo(candidate)) { compiler = candidate; break; }
      if (!compiler) throw failure('未找到 Windows .NET Framework C# 编译器，无法打开系统文件选择器');
      checkAbort(signal);
      try { await fs.mkdir(path.win32.dirname(binary), { recursive: true }); }
      catch { throw failure('无法创建系统文件选择器的 bin 目录，请检查写入权限'); }
      await runChild(compiler, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll', `/out:${binary}`, source], { signal, timeoutMs: Math.min(timeoutMs, compilerTimeoutMs), label: '文件选择器编译' });
      if (!(await fileInfo(binary))) throw failure('编译器未生成 bin/NativePicker.exe，请检查本机编译环境');
    };
    compiling = work();
    try { return await compiling; } finally { compiling = undefined; }
  }

  async function pickNativeAgentFile({ signal, timeoutMs = 300000 } = {}) {
    if (platform !== 'win32') throw failure('系统文件选择窗口目前仅支持 Windows；请在 Windows 本机运行服务');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000) throw failure('文件选择窗口超时时间无效');
    checkAbort(signal);
    const started = Date.now();
    await ensureBinary(signal, timeoutMs);
    checkAbort(signal);
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw failure('系统文件选择超时，请重新打开窗口', 'TimeoutError');
    const output = await runChild(binary, [], { signal, timeoutMs: remaining, label: '系统文件选择', visible: true });
    checkAbort(signal);
    let data;
    try { data = JSON.parse(output.trim().replace(/^\uFEFF/, '')); }
    catch { throw failure('系统文件窗口返回了无效结果，请重新选择文件'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('系统文件窗口返回了无效结果');
    if (data.cancelled === true && data.path === undefined) return null;
    if (data.cancelled === undefined && typeof data.path === 'string' && data.path.length <= 4096 && !/[\0\r\n]/.test(data.path) && path.win32.isAbsolute(data.path) && (/^[a-z]:[\\/]/i.test(data.path) || /^\\\\[^\\]+\\[^\\]+/.test(data.path))) return data.path;
    throw failure('系统文件窗口没有返回有效的绝对文件路径');
  }

  return { pickNativeAgentFile };
}

const defaultPicker = createNativePicker();
export const pickNativeAgentFile = (...args) => defaultPicker.pickNativeAgentFile(...args);
