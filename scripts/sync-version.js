/**
 * 从 package.json 读取版本号，同步到：
 * - src-tauri/tauri.conf.json (version)
 * - package-lock.json (version 与 packages[""].version)
 * - src-tauri/Cargo.toml ([package] version)
 * - src-tauri/Cargo.lock ([[package]] name = "huanggua-ai" version)
 * - README.md / README.en.md / README.ja.md / README.ko.md 的版本 badge
 * 用法: node scripts/sync-version.js [--version X.Y.Z]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(__dirname, '..');
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function writeIfChanged(filePath, current, next, label, logger) {
  if (next !== current) {
    writeFileSync(filePath, next, 'utf-8');
    logger?.(`${label} synced to ${filePath}`);
    return true;
  }
  return false;
}

export function syncAllVersionFiles(root = defaultRoot, targetVersion = undefined, logger = console.log) {
  const pkgPath = resolve(root, 'package.json');
  const pkgRaw = readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  const version = targetVersion ?? pkg.version;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`Invalid semantic version: ${String(version)}`);
  }

  const changed = [];

  if (pkg.version !== version) {
    const nextPkgRaw = pkgRaw.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${version}"`);
    if (JSON.parse(nextPkgRaw).version !== version) {
      throw new Error('Failed to update version in package.json');
    }
    if (writeIfChanged(pkgPath, pkgRaw, nextPkgRaw, 'package.json', logger)) changed.push('package.json');
  }

  const lockPath = resolve(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lockRaw = readFileSync(lockPath, 'utf-8');
    const lockObj = JSON.parse(lockRaw);
    if (lockObj.version !== version || lockObj.packages?.['']?.version !== version) {
      let nextLockRaw = lockRaw.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${version}"`);
      nextLockRaw = nextLockRaw.replace(
        /("packages"\s*:\s*\{\s*""\s*:\s*\{[\s\S]*?\n\s*"version"\s*:\s*)"[^"]+"/,
        `$1"${version}"`,
      );
      const verified = JSON.parse(nextLockRaw);
      if (verified.version !== version || verified.packages?.['']?.version !== version) {
        throw new Error('Failed to update root application version in package-lock.json');
      }
      if (writeIfChanged(lockPath, lockRaw, nextLockRaw, 'package-lock.json', logger)) changed.push('package-lock.json');
    }
  }

  const tauriPath = resolve(root, 'src-tauri', 'tauri.conf.json');
  if (existsSync(tauriPath)) {
    const tauriRaw = readFileSync(tauriPath, 'utf-8');
    const tauriObj = JSON.parse(tauriRaw);
    if (tauriObj.version !== version) {
      const nextTauriRaw = tauriRaw.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${version}"`);
      if (JSON.parse(nextTauriRaw).version !== version) {
        throw new Error('Failed to update version in src-tauri/tauri.conf.json');
      }
      if (writeIfChanged(tauriPath, tauriRaw, nextTauriRaw, 'src-tauri/tauri.conf.json', logger)) {
        changed.push('src-tauri/tauri.conf.json');
      }
    }
  }

  const cargoPath = resolve(root, 'src-tauri', 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const cargoRaw = readFileSync(cargoPath, 'utf-8');
    const nextCargoRaw = cargoRaw.replace(
      /(^\[package\][ \t]*\r?\n[\s\S]*?^version[ \t]*=[ \t]*")([^"]+)(")/m,
      `$1${version}$3`,
    );
    if (writeIfChanged(cargoPath, cargoRaw, nextCargoRaw, 'src-tauri/Cargo.toml', logger)) {
      changed.push('src-tauri/Cargo.toml');
    }
  }

  const cargoLockPath = resolve(root, 'src-tauri', 'Cargo.lock');
  if (existsSync(cargoLockPath)) {
    const cargoLockRaw = readFileSync(cargoLockPath, 'utf-8');
    const nextCargoLockRaw = cargoLockRaw.replace(
      /(^\[\[package\]\][ \t]*\r?\nname[ \t]*=[ \t]*"huanggua-ai"[ \t]*\r?\nversion[ \t]*=[ \t]*")([^"]+)(")/m,
      `$1${version}$3`,
    );
    if (writeIfChanged(cargoLockPath, cargoLockRaw, nextCargoLockRaw, 'src-tauri/Cargo.lock', logger)) {
      changed.push('src-tauri/Cargo.lock');
    }
  }

  for (const readmeName of ['README.md', 'README.en.md', 'README.ja.md', 'README.ko.md']) {
    const readmePath = resolve(root, readmeName);
    if (!existsSync(readmePath)) continue;
    const readmeRaw = readFileSync(readmePath, 'utf-8');
    const badgePattern = /version-\d+\.\d+\.\d+-6366f1/g;
    if (badgePattern.test(readmeRaw)) {
      const nextReadmeRaw = readmeRaw.replace(badgePattern, `version-${version}-6366f1`);
      if (writeIfChanged(readmePath, readmeRaw, nextReadmeRaw, readmeName, logger)) changed.push(readmeName);
    }
  }

  return { version, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flagIndex = process.argv.indexOf('--version');
  const explicit = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  const result = syncAllVersionFiles(defaultRoot, explicit, (msg) => console.log(msg));
  if (result.changed.length === 0) {
    console.log(`All version files already match ${result.version}.`);
  }
}
