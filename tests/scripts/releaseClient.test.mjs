/** 验证跨平台发版准备脚本对五份版本文件及增量 CI 豁免规则的兼容性。 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isVersionOnlyReleaseChange } from '../../scripts/ci-affected-scope.mjs';
import { expectedGitHubReleaseAssets, readLocalReleaseFiles } from '../../scripts/release-client.mjs';
import { validateReleaseMetadata } from '../../scripts/release-workflow.mjs';
import { syncAllVersionFiles } from '../../scripts/sync-version.js';

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncAllVersionFiles 与发布元数据校验', () => {
  it('一次性同步五份版本资料与多语种 README 徽章，且满足增量门禁仅版本变更判定', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-client-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'src-tauri'), { recursive: true });
    mkdirSync(join(root, '.github'), { recursive: true });

    const initialFiles = {
      'package.json': '{\n  "name": "huanggua-ai",\n  "version": "0.11.13"\n}\n',
      'package-lock.json': JSON.stringify({
        name: 'huanggua-ai',
        version: '0.11.13',
        lockfileVersion: 3,
        packages: {
          '': { name: 'huanggua-ai', version: '0.11.13' },
          'node_modules/foo': { version: '1.0.0' },
        },
      }, null, 2) + '\n',
      'src-tauri/tauri.conf.json': '{\n  "productName": "黄瓜 AI 画布",\n  "version": "0.11.13"\n}\n',
      'src-tauri/Cargo.toml': '[package]\nname = "huanggua-ai"\nversion = "0.11.13"\nedition = "2021"\n\n[dependencies]\nserde = "1.0.0"\n',
      'src-tauri/Cargo.lock': 'version = 4\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "huanggua-ai"\nversion = "0.11.13"\n',
      'README.md': '![Version](https://img.shields.io/badge/version-0.11.13-6366f1)\n',
      'README.en.md': '![Version](https://img.shields.io/badge/version-0.11.10-6366f1)\n',
      '.github/release-title.txt': '黄瓜 AI 画布 v0.11.14 - 双端统一自动发布\n',
      '.release-notes.md': '# 黄瓜 AI 画布 v0.11.14\n\n- 支持双端统一自动发布。\n',
    };

    for (const [relPath, content] of Object.entries(initialFiles)) {
      writeFileSync(join(root, relPath), content, 'utf-8');
    }

    const res = syncAllVersionFiles(root, '0.11.14', () => {});
    expect(res.version).toBe('0.11.14');
    expect(res.changed).toEqual([
      'package.json',
      'package-lock.json',
      'src-tauri/tauri.conf.json',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'README.md',
      'README.en.md',
    ]);

    const validated = validateReleaseMetadata('v0.11.14', readLocalReleaseFiles(root));
    expect(validated.version).toBe('0.11.14');

    for (const metaPath of [
      'package.json',
      'package-lock.json',
      'src-tauri/tauri.conf.json',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
    ]) {
      const after = readFileSync(join(root, metaPath), 'utf-8');
      expect(isVersionOnlyReleaseChange({
        status: 'M',
        path: metaPath,
        before: initialFiles[metaPath],
        after,
      })).toBe(true);
    }

    expect(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf-8')).packages['node_modules/foo'].version).toBe('1.0.0');
    expect(readFileSync(join(root, 'README.en.md'), 'utf-8')).toContain('version-0.11.14-6366f1');
    expect(expectedGitHubReleaseAssets('0.11.14')).toHaveLength(7);
  });
});
