import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { APP_VERSION, EXTENSION_ID } from '../core/connector-info.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyEngines } from './install-engines.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (process.platform !== 'win32' || process.arch !== 'x64' || nodeMajor !== 24) {
  throw new Error(`Building the Windows x64 package requires Windows x64 Node.js 24.x (found ${process.platform}/${process.arch} Node.js ${process.versions.node}).`);
}
await verifyEngines();
const connectorManifest = JSON.parse(await readFile(path.join(root, 'brave-connector', 'manifest.json'), 'utf8'));
const derivedId = [...createHash('sha256').update(Buffer.from(connectorManifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
if (derivedId !== EXTENSION_ID || connectorManifest.version !== APP_VERSION) throw new Error('The stable Brave connector identity or version is inconsistent.');
const version = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'package.json'),'utf8')).version;
const release = path.join(root, 'release');
const stage = path.join(release, `brave-payload-${Date.now()}`);
const relative = path.relative(release, path.resolve(stage));
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe staging path.');
await mkdir(release, { recursive: true });
try { await stat(path.join(release, 'Notakillite-v0.3.0.exe')); } catch { try { await cp(path.join(release, 'Notakillite.exe'), path.join(release, 'Notakillite-v0.3.0.exe')); } catch {} }
try { await stat(path.join(release, 'Notakillite-v0.4.0.exe')); } catch { try { await cp(path.join(release, 'Notakillite.exe'), path.join(release, 'Notakillite-v0.4.0.exe')); } catch {} }
await rm(stage, { recursive: true, force: true });
await mkdir(stage);
// Windows' own bsdtar writes ZIPs; a Unix tar earlier on PATH (Git Bash) cannot.
const windowsTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
function run(program, args, extraEnv = {}) {
  const result = spawnSync(program, args, { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(program)} failed (${result.status}).`);
}
// Prefer the pinned SDK in .tools/dotnet; otherwise use the installed .NET SDK (CI, fresh clones).
const pinnedDotnet = path.join(root, '.tools', 'dotnet');
const dotnetRoot = existsSync(path.join(pinnedDotnet, 'dotnet.exe')) ? pinnedDotnet : process.env.DOTNET_ROOT || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet');
const pinned = dotnetRoot === pinnedDotnet;
run(path.join(dotnetRoot, 'dotnet.exe'), ['publish', path.join(root, 'desktop', 'Notakillite.Desktop.csproj'), '-c', 'Release', `-p:Version=${version}`, ...(pinned ? ['--no-restore'] : []), '--nologo', '-o', stage], { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', ...(pinned ? { DOTNET_CLI_HOME: path.join(root, '.tools', 'dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools', 'nuget') } : {}) });
for (const name of ['core', 'companion', 'vendor', 'package.json', 'README.md', 'VERIFICATION.md']) await cp(path.join(root, name), path.join(stage, name), { recursive: true });
await cp(path.join(root, 'brave-connector'), path.join(stage, 'brave-connector'), { recursive: true });
await cp(path.join(root, 'core', 'notability-adapter.js'), path.join(stage, 'brave-connector', 'adapter.js'));
run('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${path.join(stage, 'Notakillite.NativeHost.exe')}`, path.join(root, 'scripts', 'NativeMessagingHost.cs')]);
run(windowsTar, ['-a', '-c', '-f', path.join(release, 'Notakillite-Brave-Connector.zip'), '-C', path.join(stage, 'brave-connector'), '.']);
await mkdir(path.join(stage, 'runtime'));
await cp(process.execPath, path.join(stage, 'runtime', 'node.exe'));
await cp(path.join(root, 'research', 'node-LICENSE'), path.join(stage, 'runtime', 'LICENSE'));
await cp(path.join(dotnetRoot, 'LICENSE.txt'), path.join(stage, 'DOTNET-LICENSE.txt'));
await cp(path.join(dotnetRoot, 'ThirdPartyNotices.txt'), path.join(stage, 'DOTNET-ThirdPartyNotices.txt'));
const binary = path.join(stage, 'node_modules', 'ffmpeg-static');
await mkdir(binary, { recursive: true });
for (const name of ['index.js', 'package.json', 'ffmpeg.exe', 'LICENSE', 'ffmpeg.exe.LICENSE', 'ffmpeg.exe.README', 'README.md']) await cp(path.join(root, 'node_modules', 'ffmpeg-static', name), path.join(binary, name));
for (const module of ['pdfjs-dist', '@napi-rs']) await cp(path.join(root,'node_modules',module),path.join(stage,'node_modules',module),{recursive:true});
await cp(path.join(root, 'node_modules', 'playwright-core'), path.join(stage, 'node_modules', 'playwright-core'), { recursive: true });
const payload = path.join(release, 'brave-payload.zip');
run(windowsTar, ['-a', '-c', '-f', payload, '-C', stage, '.']);
const executable = path.join(release, 'Notakillite.exe');
run('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', `/resource:${payload},Notakillite.Payload.zip`, `/out:${executable}`, path.join(root, 'scripts', 'WindowsLauncher.cs')]);
console.log(JSON.stringify({ executable, bytes: (await stat(executable)).size, version: APP_VERSION, nativeWpf: true, braveOnly: true, browserExtensionRequired: true, stableExtensionId: EXTENSION_ID, includesAccountData: false }));
