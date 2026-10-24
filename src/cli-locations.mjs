import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const directNames = {
  opencode: new Set(['opencode.exe', 'opencode-cli.exe', 'opencode', 'opencode-cli']),
  qoder: new Set(['qodercli.exe', 'qoder-cli.exe', 'qodercli', 'qoder-cli']),
};

function envValue(env, name) {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key && typeof env[key] === 'string' ? env[key] : '';
}

function unquote(value) {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = unquote(value);
  return path.isAbsolute(candidate) ? path.normalize(candidate) : null;
}

function isFile(candidate) {
  try { return statSync(candidate).isFile(); }
  catch { return false; }
}

function desktopAt(candidate) {
  const name = path.basename(candidate).toLowerCase();
  if (name === 'qoder.exe' || name === 'qoder launcher.exe') return true;
  return (name === 'opencode.exe' || name === 'opencode')
    && isFile(path.join(path.dirname(candidate), 'resources', 'app.asar'));
}

function isDesktop(candidate) {
  if (desktopAt(candidate)) return true;
  // A CLI-looking symlink must not resolve to a known desktop entry point.
  try { return desktopAt(realpathSync(candidate)); }
  catch { return false; }
}

function pathDirectories(env) {
  const value = envValue(env, 'PATH');
  const delimiter = value.includes(';') ? ';' : path.delimiter;
  return [...new Set(value.split(delimiter).map(absolutePath).filter(Boolean))];
}

/**
 * Locate a known CLI without launching or modifying any file.
 * `desktop` describes the selected entry point; `command` is always a CLI.
 * Only explicit installation locations are checked, never directory trees.
 */
export function findLocalCli(kind, { env = process.env, selectedPath, root = repositoryRoot } = {}) {
  if (!Object.hasOwn(directNames, kind)) return null;
  const selected = absolutePath(selectedPath);
  const desktop = Boolean(selected && isFile(selected) && isDesktop(selected));
  const candidates = [];

  if (selected && directNames[kind].has(path.basename(selected).toLowerCase())) {
    candidates.push(selected);
  }

  if (kind === 'opencode' && selected && desktop) {
    const installDirectory = path.dirname(selected);
    candidates.push(
      path.join(installDirectory, 'resources', 'opencode-cli.exe'),
      path.join(installDirectory, 'resources', 'bin', 'opencode.exe'),
    );
  }

  const directories = pathDirectories(env);
  if (kind === 'opencode') {
    for (const directory of directories) {
      candidates.push(
        path.join(directory, 'opencode.exe'),
        path.join(directory, 'opencode-cli.exe'),
        path.join(directory, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      );
      if (process.platform !== 'win32') candidates.push(path.join(directory, 'opencode'));
    }
  } else {
    for (const directory of directories) {
      candidates.push(path.join(directory, 'qodercli.exe'), path.join(directory, 'qoder-cli.exe'));
      if (process.platform !== 'win32') candidates.push(path.join(directory, 'qodercli'));
    }
    const home = absolutePath(envValue(env, 'USERPROFILE'))
      || absolutePath(envValue(env, 'HOME'))
      || absolutePath(envValue(env, 'HOMEDRIVE') + envValue(env, 'HOMEPATH'));
    if (home) {
      candidates.push(
        path.join(home, '.qoder', 'bin', 'qodercli', 'qodercli.exe'),
        path.join(home, '.qoder', 'bin', 'qodercli.exe'),
        path.join(home, '.local', 'bin', 'qodercli.exe'),
      );
      if (process.platform !== 'win32') {
        candidates.push(path.join(home, '.qoder', 'bin', 'qodercli'), path.join(home, '.local', 'bin', 'qodercli'));
      }
    }
  }

  for (const candidate of new Set(candidates)) {
    if (directNames[kind].has(path.basename(candidate).toLowerCase()) && isFile(candidate) && !isDesktop(candidate)) {
      return { command: candidate, prefix: [], desktop };
    }
  }

  if (kind === 'qoder') {
    const runtimeRoot = absolutePath(root);
    const entry = runtimeRoot && path.join(runtimeRoot, 'data', 'runtime', 'qoder', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js');
    if (entry && isFile(entry)) return { command: process.execPath, prefix: [entry], desktop };
  }
  return null;
}
