/**
 * 跨平台客户端双端打包与正式发版编排入口（支持 macOS / Windows）。
 *
 * 子命令：
 *   prepare         <version> [--title <summary>] [--notes-file <path>]
 *   test            [--ref <branch_or_sha>] [--watch]
 *   ship            <version> [--resume] [--retrigger] [--timeout-minutes <min>]
 *   gitee           <vX.Y.Z> [--run-id <id>] [--local]
 *   verify          <vX.Y.Z>
 *   ci-tauri-build  --target <triple> --config <path> [--release]
 *   ci-win-sign-hash --src <exe> --dest <exe> [--sign]
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateReleaseMetadata, validateTag } from './release-workflow.mjs';
import { syncAllVersionFiles } from './sync-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_GH_REPO = 'HuangguaOrg/huanggua-ai-canvas';
const DEFAULT_GITEE_REPO = 'xiang834740239/huanggua-aiagent';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function normalizeVersion(raw) {
  if (!raw) throw new Error('请提供版本号（如 0.11.14 或 v0.11.14）');
  const trimmed = raw.trim().replace(/^v/, '');
  if (!SEMVER.test(trimmed)) throw new Error(`无效语义化版本号：${raw}`);
  return trimmed;
}

function normalizeTag(raw) {
  return validateTag(`v${normalizeVersion(raw)}`);
}

function execText(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function ghJson(args) {
  const out = execText('gh', args);
  return out ? JSON.parse(out) : null;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export function expectedGitHubReleaseAssets(version) {
  const ver = normalizeVersion(version);
  return [
    `HuangGuaAI-${ver}-macos-arm64.dmg`,
    `HuangGuaAI-${ver}-macos-arm64.dmg.sha256`,
    `HuangGuaAI-${ver}-windows-x64-legacy-setup.exe`,
    `HuangGuaAI-${ver}-windows-x64-legacy-setup.exe.sha256`,
    `HuangGuaAI-${ver}-windows-x64-setup.exe`,
    `HuangGuaAI-${ver}-windows-x64-setup.exe.sha256`,
    `HuangGuaAI-${ver}-windows-x64-setup.exe.sig`,
  ];
}

export function readLocalReleaseFiles(root = ROOT) {
  return {
    package: readFileSync(resolve(root, 'package.json'), 'utf-8'),
    tauri: readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf-8'),
    npmLock: readFileSync(resolve(root, 'package-lock.json'), 'utf-8'),
    cargo: readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf-8'),
    cargoLock: readFileSync(resolve(root, 'src-tauri/Cargo.lock'), 'utf-8'),
    title: readFileSync(resolve(root, '.github/release-title.txt'), 'utf-8'),
    notes: readFileSync(resolve(root, '.release-notes.md'), 'utf-8'),
  };
}

function runPrepare(positionals, values) {
  const version = normalizeVersion(positionals[0]);
  const tag = `v${version}`;
  if (values.title) {
    const summary = values.title.trim().replace(/^黄瓜 AI 画布\s+v\d+\.\d+\.\d+\s*-\s*/, '');
    if (!summary) throw new Error('--title 不能为空');
    writeFileSync(resolve(ROOT, '.github/release-title.txt'), `黄瓜 AI 画布 ${tag} - ${summary}\n`, 'utf-8');
  }
  if (values['notes-file']) {
    const notesContent = readFileSync(resolve(process.cwd(), values['notes-file']), 'utf-8');
    writeFileSync(resolve(ROOT, '.release-notes.md'), notesContent.endsWith('\n') ? notesContent : `${notesContent}\n`, 'utf-8');
  }
  const synced = syncAllVersionFiles(ROOT, version);
  const validated = validateReleaseMetadata(tag, readLocalReleaseFiles(ROOT));
  console.log(JSON.stringify({
    ok: true,
    action: 'prepare',
    tag: validated.tag,
    version: validated.version,
    title: validated.title,
    changedFiles: synced.changed,
  }, null, 2));
}

async function pollWorkflowRun(repo, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLine = '';
  while (Date.now() < deadline) {
    const run = ghJson([
      'run', 'view', String(runId),
      '--repo', repo,
      '--json', 'databaseId,status,conclusion,url,jobs',
    ]);
    const summary = (run.jobs || []).map((j) => `${j.name}=${j.conclusion || j.status}`).join(', ');
    if (summary !== lastLine) {
      console.log(`[${new Date().toISOString()}] Run #${runId} (${run.status}): ${summary}`);
      lastLine = summary;
    }
    if (run.status === 'completed') return run;
    await sleep(20_000);
  }
  throw new Error(`等待工作流 #${runId} 超时`);
}

async function findRecentDispatchedRun(repo, workflowFile, startedAfterMs, matcher) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const runs = ghJson([
      'run', 'list',
      '--repo', repo,
      '--workflow', workflowFile,
      '--limit', '10',
      '--json', 'databaseId,event,headBranch,headSha,displayTitle,status,conclusion,createdAt,url',
    ]) || [];
    const matched = runs.find((r) => Date.parse(r.createdAt) >= startedAfterMs - 15_000 && matcher(r));
    if (matched) return matched;
    await sleep(5_000);
  }
  throw new Error(`未能在调度后定位 ${workflowFile} 的运行记录`);
}

async function runTestBuild(values) {
  const repo = values.repo || DEFAULT_GH_REPO;
  const ref = values.ref || execText('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const startedAt = Date.now();
  execFileSync('gh', [
    'workflow', 'run', 'release.yml',
    '--repo', repo,
    '--ref', 'main',
    '--field', 'mode=test',
    '--field', `target_ref=${ref}`,
  ], { cwd: ROOT, stdio: 'inherit' });

  const dispatched = await findRecentDispatchedRun(
    repo,
    'release.yml',
    startedAt,
    (r) => r.event === 'workflow_dispatch' && r.displayTitle.includes('双端测试包'),
  );
  console.log(`已触发双端测试包构建：${dispatched.url}`);
  if (!values.watch) return;

  const timeoutMs = Number(values['timeout-minutes'] || 75) * 60_000;
  const finalRun = await pollWorkflowRun(repo, dispatched.databaseId, timeoutMs);
  if (finalRun.conclusion !== 'success') {
    throw new Error(`双端测试包构建失败（conclusion=${finalRun.conclusion}）：${finalRun.url}`);
  }
  const artifactsResp = ghJson(['api', `repos/${repo}/actions/runs/${finalRun.databaseId}/artifacts`]);
  const testArtifacts = (artifactsResp?.artifacts || [])
    .filter((a) => a.name.startsWith('test-windows-') || a.name.startsWith('test-macos-'))
    .map((a) => ({ name: a.name, sizeBytes: a.size_in_bytes }));
  console.log(JSON.stringify({
    ok: true,
    action: 'test',
    runId: finalRun.databaseId,
    url: finalRun.url,
    artifacts: testArtifacts,
    downloadCommand: `gh run download ${finalRun.databaseId} --repo ${repo} ${testArtifacts.map((a) => `-n ${a.name}`).join(' ')}`,
  }, null, 2));
}

export async function verifyPublicRelease(tagInput, { ghRepo = DEFAULT_GH_REPO, giteeRepo = DEFAULT_GITEE_REPO } = {}) {
  const tag = normalizeTag(tagInput);
  const version = tag.slice(1);
  const release = ghJson([
    'release', 'view', tag,
    '--repo', ghRepo,
    '--json', 'tagName,name,isDraft,isPrerelease,publishedAt,url,assets',
  ]);
  if (!release || release.isDraft || release.isPrerelease) {
    throw new Error(`GitHub Release ${tag} 未公开或状态异常`);
  }
  const byName = new Map((release.assets || []).map((a) => [a.name, a]));
  const expected = expectedGitHubReleaseAssets(version);
  for (const name of expected) {
    const asset = byName.get(name);
    if (!asset || !asset.size || asset.size <= 0) {
      throw new Error(`GitHub Release ${tag} 缺少有效资产：${name}`);
    }
  }

  let giteeFeed = null;
  let feedUrlUsed = '';
  for (const branch of ['master', 'main']) {
    const url = `https://gitee.com/${giteeRepo}/raw/${branch}/latest.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'HuangGuaAI-ReleaseVerify/1.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      giteeFeed = await res.json();
      feedUrlUsed = url;
      break;
    }
  }
  if (!giteeFeed) throw new Error('无法读取 Gitee 公开 latest.json');
  if (giteeFeed.version !== version) {
    throw new Error(`Gitee latest.json 版本为 ${giteeFeed.version}，预期为 ${version}`);
  }
  for (const platformKey of ['windows-x86_64', 'darwin-aarch64']) {
    const entry = giteeFeed.platforms?.[platformKey];
    if (!entry?.url?.startsWith(`https://gitee.com/${giteeRepo}/releases/download/${tag}/`) || !entry?.signature) {
      throw new Error(`Gitee latest.json 平台 ${platformKey} 字段缺失或地址不匹配`);
    }
    const probe = await fetch(entry.url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'User-Agent': 'HuangGuaAI-ReleaseVerify/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (probe.status !== 200 && probe.status !== 206) {
      throw new Error(`Gitee 附件不可达（HTTP ${probe.status}）：${entry.url}`);
    }
    await probe.body?.cancel();
  }

  return {
    ok: true,
    tag,
    version,
    githubReleaseUrl: release.url,
    publishedAt: release.publishedAt,
    githubAssets: expected,
    giteeFeedUrl: feedUrlUsed,
    giteePlatforms: {
      'windows-x86_64': giteeFeed.platforms['windows-x86_64'].url,
      'darwin-aarch64': giteeFeed.platforms['darwin-aarch64'].url,
    },
  };
}

async function runCloudGiteeSync(tagInput, values) {
  const repo = values.repo || DEFAULT_GH_REPO;
  const tag = normalizeTag(tagInput);
  const timeoutMs = Number(values['timeout-minutes'] || 45) * 60_000;
  const startedAt = Date.now();
  const ghArgs = [
    'workflow', 'run', 'release.yml',
    '--repo', repo,
    '--ref', 'main',
    '--field', 'mode=gitee',
    '--field', `tag=${tag}`,
  ];
  if (values['run-id']) {
    ghArgs.push('--field', `source_run_id=${values['run-id']}`);
  }
  execFileSync('gh', ghArgs, { cwd: ROOT, stdio: 'inherit' });
  const dispatched = await findRecentDispatchedRun(
    repo,
    'release.yml',
    startedAt,
    (r) => r.event === 'workflow_dispatch' && r.displayTitle.includes(`(${tag})`) && r.displayTitle.includes('Gitee'),
  );
  console.log(`正在监控云端 Gitee 热更同步工作流：${dispatched.url}`);
  const completed = await pollWorkflowRun(repo, dispatched.databaseId, timeoutMs);
  if (completed.conclusion !== 'success') {
    throw new Error(`云端同步 Gitee 失败（conclusion=${completed.conclusion}）：${dispatched.url}`);
  }
}

function runLocalGiteeFallback(tagInput, values) {
  const repo = values.repo || DEFAULT_GH_REPO;
  const tag = normalizeTag(tagInput);
  let runId = values['run-id'];
  let sha = '';
  if (!runId) {
    const runs = ghJson([
      'run', 'list',
      '--repo', repo,
      '--workflow', 'release.yml',
      '--limit', '15',
      '--json', 'databaseId,displayTitle,status,conclusion',
    ]) || [];
    const targetRun = runs.find((r) => r.displayTitle.includes(tag) && !r.displayTitle.startsWith('调度'));
    if (!targetRun) throw new Error(`未找到 ${tag} 的 Release 工作流运行记录`);
    runId = String(targetRun.databaseId);
  }
  const tagRef = ghJson(['api', `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`]);
  sha = tagRef?.object?.sha;
  if (!sha) throw new Error(`无法解析标签 ${tag} 的提交 SHA`);

  const tmp = mkdtempSync(join(tmpdir(), 'huanggua-gitee-fallback-'));
  try {
    const winDir = join(tmp, 'win');
    const macDir = join(tmp, 'mac');
    execFileSync('gh', ['run', 'download', String(runId), '--repo', repo, '-n', `windows-gitee-update-${sha}`, '-D', winDir], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    execFileSync('gh', ['run', 'download', String(runId), '--repo', repo, '-n', `macos-gitee-update-arm64-${sha}`, '-D', macDir], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const pyBin = process.platform === 'win32' ? 'python' : 'python3';
    const res = spawnSync(pyBin, [
      '-u',
      resolve(ROOT, 'scripts/publish-gitee-update.py'),
      '--dir', winDir,
      '--macos-dir', macDir,
      '--verify-public-feed',
    ], { cwd: ROOT, stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`本地补传 Gitee 失败（exit=${res.status}）`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runShip(positionals, values) {
  const repo = values.repo || DEFAULT_GH_REPO;
  const version = normalizeVersion(positionals[0]);
  const tag = `v${version}`;
  const timeoutMs = Number(values['timeout-minutes'] || 90) * 60_000;

  validateReleaseMetadata(tag, readLocalReleaseFiles(ROOT));
  const dirty = execText('git', ['status', '--porcelain']);
  if (dirty) throw new Error('工作区存在未提交修改，请先提交合并后再执行正式发版');

  execFileSync('git', ['fetch', 'origin', 'main', '--tags'], { cwd: ROOT, stdio: 'inherit' });
  const headSha = execText('git', ['rev-parse', 'HEAD']);
  const originMainSha = execText('git', ['rev-parse', 'origin/main']);
  if (headSha !== originMainSha) {
    throw new Error(`当前 HEAD (${headSha.slice(0, 7)}) 与 origin/main (${originMainSha.slice(0, 7)}) 不一致，请先将发版准备提交合入 main`);
  }

  let tagExistsRemotely = false;
  try {
    const remoteTag = execText('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
    tagExistsRemotely = Boolean(remoteTag);
  } catch {
    tagExistsRemotely = false;
  }

  const startedAt = Date.now();
  if (!tagExistsRemotely) {
    execFileSync('git', ['tag', tag, headSha], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: ROOT, stdio: 'inherit' });
    console.log(`已推送正式版本标签 ${tag} -> ${headSha}`);
  } else if (values.retrigger) {
    let alreadyPublished = false;
    try {
      const existingRel = ghJson(['release', 'view', tag, '--repo', repo, '--json', 'isDraft']);
      alreadyPublished = Boolean(existingRel && !existingRel.isDraft);
    } catch {
      alreadyPublished = false;
    }
    if (alreadyPublished) {
      throw new Error(`GitHub Release ${tag} 已公开，禁止重复触发发布工作流`);
    }
    execFileSync('gh', [
      'workflow', 'run', 'release.yml',
      '--repo', repo,
      '--ref', 'main',
      '--field', 'mode=release',
      '--field', `tag=${tag}`,
    ], { cwd: ROOT, stdio: 'inherit' });
    console.log(`已为未公开标签 ${tag} 重新触发默认分支统一发布流水线`);
  } else if (!values.resume) {
    throw new Error(`远端标签 ${tag} 已存在；如需监控运行中的任务请加 --resume，如未公开需重跑默认分支工作流请加 --retrigger`);
  } else {
    console.log(`远端标签 ${tag} 已存在，进入续跑监控模式...`);
  }

  const releaseRun = await findRecentDispatchedRun(
    repo,
    'release.yml',
    values.resume && !values.retrigger ? Date.now() - 6 * 3600_000 : startedAt,
    (r) => r.event === 'workflow_dispatch' && r.displayTitle.includes(tag),
  );
  console.log(`正在监控统一发布流水线：${releaseRun.url}`);
  const completed = await pollWorkflowRun(repo, releaseRun.databaseId, timeoutMs);
  const finalizeOk = (completed.jobs || []).some((j) => j.name === 'Publish GitHub Release' && j.conclusion === 'success');
  const giteeOk = (completed.jobs || []).some((j) => j.name === 'Publish Gitee update & latest.json' && j.conclusion === 'success');
  if (completed.conclusion !== 'success' || !finalizeOk || !giteeOk) {
    if (finalizeOk && !giteeOk) {
      throw new Error(
        `GitHub Release 已公开，但云端上传 Gitee 未完成（${completed.url}）。可直接执行本地免编译兜底：npm run release:gitee -- ${tag} --run-id ${completed.databaseId}`,
      );
    }
    throw new Error(`发布流水线未完整通过（conclusion=${completed.conclusion}, finalize=${finalizeOk}, gitee=${giteeOk}）：${completed.url}`);
  }

  const receipt = await verifyPublicRelease(tag, { ghRepo: repo });
  console.log(JSON.stringify(receipt, null, 2));
}

function runCiTauriBuild(values) {
  const target = values.target;
  const configPath = values.config;
  const isRelease = Boolean(values.release);
  if (!target || !configPath) throw new Error('ci-tauri-build 需要 --target 与 --config');

  const cfg = JSON.parse(readFileSync(resolve(ROOT, configPath), 'utf-8'));
  if (!isRelease) {
    cfg.bundle = { ...cfg.bundle, createUpdaterArtifacts: false };
  }
  const activeDir = resolve(ROOT, 'src-tauri/target');
  mkdirSync(activeDir, { recursive: true });
  const activeCfgPath = join(activeDir, `tauri-active-${target}.config.json`);
  writeFileSync(activeCfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');

  const env = { ...process.env };
  if (isRelease) {
    // 保留空字符串密码，规避 Windows PowerShell 将空环境变量删除导致交互阻塞的问题
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
  } else {
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }

  const args = [resolve(ROOT, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', target, '--config', activeCfgPath];
  if (values.bundles) args.push('--bundles', values.bundles);
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`tauri build 失败（exit=${res.status ?? 1}）`);
}

function runCiWinSignHash(values) {
  const src = values.src ? resolve(process.cwd(), values.src) : '';
  const dest = values.dest ? resolve(process.cwd(), values.dest) : '';
  if (!src || !dest) throw new Error('ci-win-sign-hash 需要 --src 与 --dest');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);

  if (values.sign) {
    const pw = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
    const res = spawnSync(
      process.execPath,
      [resolve(ROOT, 'node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign', '-p', pw, dest],
      { cwd: ROOT, env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pw }, stdio: 'inherit' },
    );
    if (res.status !== 0) throw new Error(`tauri signer sign 失败（exit=${res.status ?? 1}）`);
  }

  const digest = createHash('sha256').update(readFileSync(dest)).digest('hex');
  writeFileSync(`${dest}.sha256`, `${digest}  ${basename(dest)}\n`, 'utf-8');
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      'notes-file': { type: 'string' },
      ref: { type: 'string' },
      repo: { type: 'string' },
      watch: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      retrigger: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      'run-id': { type: 'string' },
      'timeout-minutes': { type: 'string' },
      target: { type: 'string' },
      config: { type: 'string' },
      bundles: { type: 'string' },
      release: { type: 'boolean', default: false },
      src: { type: 'string' },
      dest: { type: 'string' },
      sign: { type: 'boolean', default: false },
    },
  });
  const [subcommand, ...rest] = positionals;
  if (subcommand === 'prepare') {
    runPrepare(rest, values);
  } else if (subcommand === 'test') {
    await runTestBuild(values);
  } else if (subcommand === 'ship') {
    await runShip(rest, values);
  } else if (subcommand === 'gitee') {
    if (values.local) {
      runLocalGiteeFallback(rest[0], values);
    } else {
      await runCloudGiteeSync(rest[0], values);
    }
    const receipt = await verifyPublicRelease(rest[0], { ghRepo: values.repo || DEFAULT_GH_REPO });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (subcommand === 'verify') {
    const receipt = await verifyPublicRelease(rest[0], { ghRepo: values.repo || DEFAULT_GH_REPO });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (subcommand === 'ci-tauri-build') {
    runCiTauriBuild(values);
  } else if (subcommand === 'ci-win-sign-hash') {
    runCiWinSignHash(values);
  } else {
    throw new Error('用法: node scripts/release-client.mjs <prepare|test|ship|gitee|verify> [args]');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
