import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = path.join(root, 'release');
const stage = path.join(release, 'Notakillite');
await mkdir(release, { recursive: true });
const relative = path.relative(release, path.resolve(stage));
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid packaging directory.');
await rm(stage, { recursive: true, force: true });
await mkdir(stage);
for (const filename of ['extension', 'companion', 'vendor', 'scripts', 'tests', 'package.json', 'package-lock.json', 'Start Notakillite.cmd', 'README.md', 'VERIFICATION.md']) {
  await cp(path.join(root, filename), path.join(stage, filename), { recursive: true });
}
await mkdir(path.join(stage, 'research'));
for (const filename of ['REA-NOTES.md', 'NOTABILITY-ADAPTER.md', 'rea-summary.json', 'node-LICENSE', 'deepfilternet-enhance_wav.rs']) await cp(path.join(root, 'research', filename), path.join(stage, 'research', filename));
const archive = path.join(release, 'Notakillite.zip');
const result = spawnSync('tar.exe', ['-a', '-c', '-f', archive, '-C', release, 'Notakillite'], { windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Could not create the release archive.');
console.log(`Packaged ${archive}`);
console.log('Browser profiles, recordings, credentials, and node_modules are excluded.');
