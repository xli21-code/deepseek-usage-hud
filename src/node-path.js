'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stableNodePath({ execPath = process.execPath, env = process.env, home = os.homedir(),
  executable = p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } } } = {}) {
  const override = env.DEEPSEEK_HUD_NODE?.trim();
  if (override) {
    const candidate = override.replace(/^~(?=\/|$)/, home);
    if (!path.isAbsolute(candidate) || !executable(candidate)) {
      throw new Error('DEEPSEEK_HUD_NODE must name an executable absolute path (a stable Node symlink or shim)');
    }
    return candidate; // Preserve the stable symlink, rather than realpath-ing it.
  }
  const candidates = [];
  const brew = execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  if (brew) {
    if (brew[2] === 'node') candidates.push(path.join(brew[1], 'bin/node'));
    candidates.push(path.join(brew[1], 'opt', brew[2], 'bin/node'));
  }
  const nvmRoot = env.NVM_DIR || path.join(home, '.nvm');
  if (execPath.startsWith(path.join(nvmRoot, 'versions/node') + path.sep) || execPath.includes('/.nvm/versions/node/')) {
    candidates.push(path.join(nvmRoot, 'current/bin/node'));
  }
  if (execPath.includes('/installs/nodejs/')) candidates.push(path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'shims/node'));
  if (env.VOLTA_HOME && execPath.startsWith(path.join(env.VOLTA_HOME, 'tools/'))) candidates.push(path.join(env.VOLTA_HOME, 'bin/node'));
  return candidates.find(executable) || execPath;
}

module.exports = { stableNodePath };
