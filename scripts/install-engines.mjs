import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipEntries, extractEntry } from '../companion/notability-import.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const downloads = [
  { file: 'vendor/rnnoise/cb.rnnn', url: 'https://raw.githubusercontent.com/richardpl/arnndn-models/0fda24c46d78f0207d820bb970fbe85c1971b39c/cb.rnnn', sha256: 'f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9' },
  { file: 'vendor/rnnoise/std.rnnn', url: 'https://raw.githubusercontent.com/richardpl/arnndn-models/0fda24c46d78f0207d820bb970fbe85c1971b39c/std.rnnn', sha256: '6b8943dc4a9b6b24425873992a44f29c0577503276456af46a8854774faeb294' },
  { file: 'vendor/deepfilternet/deep-filter.exe', url: 'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe', sha256: '75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915' },
  { file: 'vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz', url: 'https://raw.githubusercontent.com/Rikorose/DeepFilterNet/v0.5.6/models/DeepFilterNet3_onnx.tar.gz', sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616' },
  // Silero voice-activity model: lets Whisper skip silence instead of inventing text there.
  { file: 'vendor/whisper/LICENSE', url: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/LICENSE', sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d' },
  { file: 'vendor/whisper/ggml-silero-v6.2.0.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin', sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' },
];
// whisper.cpp program bundles (ZIPs). Only the CLI and its libraries are extracted.
export const bundles = [
  { dir: 'vendor/whisper/cpu', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  // Vulkan (AMD/NVIDIA/Intel GPU) build of the same whisper.cpp version, produced by
  // .github/workflows/whisper-vulkan.yml. Optional: the CPU bundle is used until it is pinned.
  { dir: 'vendor/whisper/vulkan', url: process.env.NOTAKILLITE_WHISPER_VULKAN_URL || 'https://github.com/saud-creator/notakillite/releases/download/whisper-vulkan-b5454/whisper-vulkan-x64.zip', sha256: process.env.NOTAKILLITE_WHISPER_VULKAN_SHA256 || '', optional: true },
];
const keep = name => /^(whisper-cli\.exe|whisper\.dll|ggml[\w-]*\.dll|vulkan-1\.dll|LICENSE[\w.-]*)$/i.test(name);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stampFile = bundle => path.join(root, bundle.dir, '.bundle-sha256');

async function bundleInstalled(bundle) {
  try { return (await readFile(stampFile(bundle), 'utf8')).trim() === bundle.sha256 && !!await readFile(path.join(root, bundle.dir, 'whisper-cli.exe')); } catch { return false; }
}

export async function verifyEngines() {
  for (const artifact of downloads) {
    const filename = path.join(root, artifact.file);
    const bytes = await readFile(filename);
    if (sha256(bytes) !== artifact.sha256) throw new Error(`${artifact.file} does not match the pinned release.`);
  }
  for (const bundle of bundles) if (!bundle.optional && !await bundleInstalled(bundle)) throw new Error(`${bundle.dir} is missing. Run npm run install:engines.`);
  for (const file of ['vendor/rnnoise/LICENSE', 'vendor/rnnoise/MODEL-README.md', 'vendor/rnnoise/TRAINING-README.md', 'vendor/deepfilternet/LICENSE', 'vendor/deepfilternet/LICENSE-APACHE', 'vendor/deepfilternet/LICENSE-MIT']) await readFile(path.join(root, file));
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function installBundle(bundle) {
  if (await bundleInstalled(bundle)) return 'present';
  if (!bundle.sha256) return 'not pinned';
  const bytes = await download(bundle.url);
  if (sha256(bytes) !== bundle.sha256) throw new Error(`Download checksum mismatch: ${bundle.url}`);
  const target = path.join(root, bundle.dir), staging = `${target}.partial`, archive = `${target}.zip`;
  await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
  await writeFile(archive, bytes);
  try {
    for (const entry of await zipEntries(archive)) {
      const name = path.posix.basename(entry.name);
      if (keep(name)) await extractEntry(archive, entry, path.join(staging, name));
    }
    await writeFile(path.join(staging, '.bundle-sha256'), bundle.sha256);
    await rm(target, { recursive: true, force: true }); await rename(staging, target);
  } finally { await rm(archive, { force: true }); await rm(staging, { recursive: true, force: true }); }
  return 'installed';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const artifact of downloads) {
    const filename = path.join(root, artifact.file);
    let bytes;
    try { bytes = await readFile(filename); } catch {}
    if (bytes && sha256(bytes) === artifact.sha256) continue;
    if (process.argv.includes('--verify')) throw new Error(`Missing or modified engine: ${artifact.file}`);
    bytes = await download(artifact.url);
    if (sha256(bytes) !== artifact.sha256) throw new Error(`Download checksum mismatch: ${artifact.file}`);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
  }
  if (process.platform === 'win32') for (const bundle of bundles) console.log(`${bundle.dir}: ${await installBundle(bundle)}`);
  await verifyEngines();
  console.log('RNNoise, DeepFilterNet3 and whisper.cpp verified against pinned SHA-256 hashes.');
}
