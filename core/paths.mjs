import path from 'node:path';
import { mkdir } from 'node:fs/promises';
export function pathsFor(dataRoot) {
  const root = path.resolve(dataRoot || process.env.NOTAKILLITE_DATA_DIR || path.join(process.env.LOCALAPPDATA || process.cwd(), 'Notakillite'));
  return { root, profile: path.join(root, 'browser', 'brave'), data: path.join(root, 'data'), temp: path.join(root, 'temp'), exports: path.join(root, 'exports'), logs: path.join(root, 'logs'), models: path.join(root, 'models') };
}
export async function preparePaths(paths) { for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true }); }
export function isInside(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
