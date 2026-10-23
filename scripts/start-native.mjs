import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const exe = fileURLToPath(new URL('../release/Notakillite.exe', import.meta.url));
try { await access(exe); } catch { throw new Error('Build the desktop app first with npm run build:exe.'); }
const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('spawn', () => child.unref());
