/** Fail closed before packaging an incomplete or upstream-bound desktop. */
import { readFile, lstat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const fail = (message) => { throw new Error(`黄瓜客户端发布检查：${message}`); };
async function digest(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}
if (config.identifier !== 'com.huanggua.canvas' || config.productName !== '黄瓜 AI 画布' || config.mainBinaryName !== 'HuangGuaAI') fail('产品标识无效');
const installerHook = await readFile(path.join(root, 'src-tauri/windows/nsis-hooks.nsh'), 'utf8');
if (config.bundle.publisher !== 'Huanggua AI'
  || !installerHook.includes('"Software\\Huanggua AI\\$(^Name)"')
  || !installerHook.includes('StrCmp $2 "Huanggua AI" 0 wix_check_next')
  || !installerHook.includes('"$LOCALAPPDATA\\com.huanggua.canvas\\director-desk"')
  || !installerHook.includes('"$LOCALAPPDATA\\com.huanggua.canvas\\huanggua-studio-runtime"')
  || !installerHook.includes('RMDir /r "$INSTDIR\\huanggua-studio"')
  || installerHook.includes('com.aicanvas.app')) fail('Windows 安装与更新标识不一致');
const expectedEndpoints = [
  'https://gitee.com/xiang834740239/huanggua-aiagent/raw/master/latest.json',
  'https://gitee.com/xiang834740239/huanggua-aiagent/raw/main/latest.json',
];
const updater = config.plugins.updater;
if (!updater.pubkey || JSON.stringify(updater.endpoints) !== JSON.stringify(expectedEndpoints)) fail('更新渠道未配置为指定的黄瓜 AI Gitee 仓库');
const bundle = path.join(root, 'src-tauri/resources/huanggua-studio');
const director = JSON.parse(await readFile(path.join(root, 'scripts/director-desk-release.json'), 'utf8'));
const directorArchive = await readFile(path.join(root, 'src-tauri/resources/director-desk.tar.gz')).catch(() => fail('缺少离线导演台组件'));
if (createHash('sha256').update(directorArchive).digest('hex') !== director.sha256) fail('离线导演台组件校验失败');
const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8').catch(() => fail('请先准备短剧运行时，不能发布仅开发机可用的安装包')));
if (manifest.schemaVersion !== 1 || manifest.platform !== 'windows-x86_64' || !manifest.files) fail('运行时清单无效');
async function verifyInventory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) fail('运行时不能包含链接');
    if (entry.isDirectory()) await verifyInventory(path.join(directory, entry.name), name + '/');
    else if (!entry.isFile() || name !== 'manifest.json' && !Object.hasOwn(manifest.files, name)) fail(`存在未登记的运行时文件：${name}`);
  }
}
await verifyInventory(bundle);
for (const required of ['engine/server/app.py', 'engine/huanggua-models.json', 'python/python.exe', 'python/Lib/site-packages/claude_agent_sdk/_bundled/claude.exe', 'git/usr/bin/bash.exe', 'git/cmd/git.exe']) {
  if (!manifest.files[required]) fail(`缺少运行时依赖 ${required}`);
}
// 与 package-studio-runtime.py 的精简规则一致：火山 SDK 只保留 Ark 运行时的导入闭包。
const volcengineKeep = new Set(['volcenginesdkcore', 'volcenginesdkark', 'volcenginesdkarkruntime']);
const unpruned = Object.keys(manifest.files).find((name) => {
  if (name.startsWith('python/tcl/') || name.startsWith('python/include/')) return true;
  const match = /^python\/Lib\/site-packages\/(volcenginesdk[^/]*)\//.exec(name);
  return match && !volcengineKeep.has(match[1].split('.')[0]);
});
if (unpruned) fail(`运行时未精简，请运行 python scripts/package-studio-runtime.py --prune-existing：${unpruned}`);
for (const [name, hash] of Object.entries(manifest.files)) {
  if (name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some((part) => !part || part === '..' || part === '.') || !/^[a-f0-9]{64}$/.test(hash)) fail('运行时清单路径或摘要无效');
  let current = bundle;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('运行时不能包含链接');
  }
  if (await digest(current) !== hash) fail(`运行时文件与清单不符：${name}`);
}
// 安装包只携带单个归档；主程序会把归档与清单摘要编译进去并在首次使用时逐文件校验。
const resources = config.bundle.resources;
if (resources['resources/huanggua-studio.zip'] !== 'huanggua-studio.zip' || resources['resources/huanggua-studio.json'] !== 'huanggua-studio.json'
  || Object.keys(resources).some((source) => source.startsWith('resources/huanggua-studio/'))) fail('短剧运行时必须以单个归档随包分发');
const sidecar = JSON.parse(await readFile(path.join(root, 'src-tauri/resources/huanggua-studio.json'), 'utf8').catch(() => fail('请先运行 npm run release:pack 生成短剧运行时归档')));
const archive = path.join(root, 'src-tauri/resources/huanggua-studio.zip');
const archiveStat = await lstat(archive).catch(() => fail('缺少短剧运行时归档'));
if (sidecar.schemaVersion !== 1 || sidecar.archive !== 'huanggua-studio.zip' || sidecar.files !== Object.keys(manifest.files).length
  || sidecar.manifestSha256 !== await digest(path.join(bundle, 'manifest.json'))
  || !archiveStat.isFile() || sidecar.size !== archiveStat.size || sidecar.sha256 !== await digest(archive)) fail('短剧运行时归档与清单不一致，请重新运行 npm run release:pack');
console.log(`黄瓜客户端发布预检通过：${Object.keys(manifest.files).length} 个运行时文件已校验，归档 ${sidecar.size} 字节。签名密钥、安装升级及线上更新仍需发布验收。`);
