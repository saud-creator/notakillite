import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ConnectionError } from './connector-info.mjs';
import { EXTENSION_ID } from './connector-info.mjs';

export async function findRegularBrave(explicit) {
  const candidates = [explicit, process.env.NOTAKILLITE_BRAVE, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'), path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe')].filter(Boolean);
  for (const file of candidates) { try { await access(file); return file; } catch {} }
  throw new ConnectionError('BROWSER_MISSING', 'Install Brave Browser to connect. Local audio import is available without it.');
}
export async function regularProfiles(root = path.join(process.env.LOCALAPPDATA || '.', 'BraveSoftware/Brave-Browser/User Data')) {
  // Read only profile labels/directories, never authentication or encryption data.
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8')).profile; } catch {}
  const profiles = Object.entries(metadata?.info_cache || {}).filter(([directory]) => validProfileDirectory(directory)).map(([directory, item]) => ({ directory, label: String(item.name || directory), lastUsed: directory === metadata?.last_used }));
  return { root, profiles: profiles.length ? profiles : [{ directory: 'Default', label: 'Default', lastUsed: true }] };
}
export function validProfileDirectory(value) { return typeof value === 'string' && value.length <= 80 && /^[\w -]+$/.test(value) && value !== 'Guest Profile' && value !== 'System Profile'; }
export async function connectorInstallation(binding) {
  if (!validProfileDirectory(binding.profileDirectory) || !binding.userDataRoot) return 'unknown';
  let readable = false;
  for (const name of ['Secure Preferences', 'Preferences']) {
    try {
      // Inspect this extension's installation metadata only. Never return or persist other browser preferences.
      const preferences = JSON.parse(await readFile(path.join(binding.userDataRoot, binding.profileDirectory, name), 'utf8'));
      readable = true;
      const entry = preferences.extensions?.settings?.[EXTENSION_ID];
      if (!entry) continue;
      const reasons = entry.disable_reasons;
      return entry.state === 0 || entry.state === 2 || (Array.isArray(reasons) ? reasons.length > 0 : Number(reasons) > 0) ? 'disabled' : 'installed';
    } catch { /* A locked or unsupported metadata file is not evidence of an uninstalled connector. */ }
  }
  return readable ? 'missing' : 'unknown';
}
export async function openRegularBrave(binding, url) {
  if (!validProfileDirectory(binding.profileDirectory)) throw new ConnectionError('PROFILE_UNAVAILABLE', 'Choose your usual Brave profile in Settings.');
  const executable = await findRegularBrave(binding.executable);
  // Normal installed Brave, same profile; no automation, debugging, or custom user-data directory.
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [`--profile-directory=${binding.profileDirectory}`, url], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', () => reject(new ConnectionError('BROWSER_UNAVAILABLE', 'Brave could not open. Check its installation and try again.')));
  });
}
