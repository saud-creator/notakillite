import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Store } from '../../core/store.mjs';

const root = process.cwd(), directory = path.join(root, '.local', 'packaged-upgrades-' + Date.now());
await mkdir(directory, { recursive: true });
const stages = [];
for (const name of (await readdir(path.join(root, 'release'))).filter(name => /^brave-payload-\d+$/.test(name)).sort()) {
  try { await stat(path.join(root, 'release', name, 'Notakillite.NativeHost.exe')); stages.push(name); } catch { /* Exclude the retired private-pipe payloads. */ }
}
assert.ok(stages.length >= 3, 'Three distinct native program payloads are required.');
const builds = [stages[0], stages[1], stages.at(-1)];
const database = path.join(root, '.local', 'bridge-native-qa', 'data');
async function command(executable, args) {
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output); return output;
}
function saved() {
  const store = new Store(database);
  try { return { binding: store.get('braveBinding'), preferences: store.get('preferences'), jobs: store.jobs() }; }
  finally { store.close(); }
}
const results = []; let identity, previous;
for (const [index, build] of builds.entries()) {
  const label = ['A', 'B', 'C'][index], executable = path.join(directory, `Notakillite-${label}.exe`);
  if (index < 2) {
    const payload = path.join(directory, `payload-${label}.zip`);
    await command('tar.exe', ['-a', '-c', '-f', payload, '-C', path.join(root, 'release', build), '.']);
    await command('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', `/resource:${payload},Notakillite.Payload.zip`, `/out:${executable}`, path.join(root, 'scripts', 'WindowsLauncher.cs')]);
  } else {
    const { copyFile } = await import('node:fs/promises'); await copyFile(path.join(root, 'release', 'Notakillite.exe'), executable);
  }
  const installation = path.join(directory, `installation-${label}`);
  await command(executable, ['--verify-only', '--extract-to', installation]);
  const app = (await readFile(path.join(installation, 'verification.txt'), 'utf8')).trim().split(/\r?\n/).at(-1);
  const output = await command(process.execPath, [path.join(root, 'scripts', 'brave', 'native-bridge-smoke.mjs'), '--stage', app, ...(index === 2 ? ['--original'] : ['--legacy-recording-retry'])]);
  const nativeReport = JSON.parse(output.trim().split(/\r?\n/).at(-1)), state = saved();
  identity ||= state.binding.profileId;
  assert.equal(state.binding.profileId, identity); assert.equal(state.binding.verifiedAccountId, 'qa-account');
  if (previous) {
    assert.equal(state.preferences.theme, previous.preferences.theme);
    assert.equal(state.preferences.outputPath, previous.preferences.outputPath);
    for (const job of previous.jobs.filter(job => job.status === 'done')) {
      const retained = state.jobs.find(item => item.id === job.id); assert.ok(retained && retained.status === 'done');
      for (const file of retained.files) assert.ok((await stat(file.path)).size > 0);
    }
    assert.equal(state.jobs.filter(job => job.status === 'done').length, previous.jobs.filter(job => job.status === 'done').length + 1);
  }
  const digest = createHash('sha256').update(await readFile(executable)).digest('hex');
  results.push({ build: label, stage: build, sha256: digest, bytes: (await stat(executable)).size, extractedApp: app, ...nativeReport });
  if (index === 0) {
    const store = new Store(database);
    try { store.set('preferences', { ...state.preferences, theme: 'light', outputPath: path.join(root, '.local', 'bridge-native-qa', 'exports-upgrade') }); }
    finally { store.close(); }
  }
  previous = saved();
  console.log(JSON.stringify({ build: label, result: 'passed', persistentProfileId: identity, completedJobs: nativeReport.completedJobs }));
}
assert.equal(new Set(results.map(build => build.sha256)).size, 3);
const report = { result: 'passed', scope: 'Synthetic Brave profile and account only; no real sign-in or Windows reboot', distinctPackagedBuilds: 3, browserClosedBetweenBuilds: true, retained: ['connector identity', 'profile pairing', 'synthetic persistent cookie and local storage', 'verified synthetic account reference', 'theme', 'export location', 'completed job history and files'], results };
await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result: 'passed', distinctPackagedBuilds: 3, report: path.join(directory, 'verification.json') }));
