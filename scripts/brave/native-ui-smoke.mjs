import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = process.cwd();
const stages = (await readdir(path.join(root, 'release'))).filter(name => /^brave-payload-\d+$/.test(name)).sort();
const app = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : path.join(root, 'release', stages.at(-1));
const directory = path.join(root, '.local', 'native-ui-qa'); await mkdir(directory, { recursive: true });
const notes = Array.from({ length: 1144 }, (_, index) => ({ id: `note-${index}`, title: index === 0 ? 'Anatomy of the Anterior Abdominal Wall' : index === 1 ? 'محاضرة الجهاز الهضمي' : `Lecture ${index + 1} · course notes`, hasRecordings: index % 4 !== 3, createdAt: index, updatedAt: index + 1, workspaceId: 'workspace', folderId: 'mid', path: [{ id: 'level', title: 'LEVEL 5' }, { id: 'git', title: 'GIT' }, { id: 'mid', title: 'Mid Lec' }], recordings: index === 0 ? [{ id: 'r-1', name: 'Lecture recording', duration: 2514, available: true }, { id: 'r-2', name: 'Review and questions', duration: 380, available: true }] : [] }));
const state = { version: '0.7.0', connection: 'Connected', connectionCode: 'CONNECTED', detail: 'Your library follows Notability’s folders and saved sort order.', lastSync: new Date().toISOString(), revision: 42, notes,
  library: { accountId: 'workspace', sort: { mode: 'created', matched: true }, workspaces: [{ id: 'workspace', title: 'My Library', noteIds: [], children: [{ id: 'level', title: 'LEVEL 5', noteIds: [], children: [{ id: 'git', title: 'GIT', noteIds: [], children: [{ id: 'mid', title: 'Mid Lec', noteIds: notes.map(n => n.id), children: [] }, { id: 'practical', title: 'Practical', noteIds: [], children: [] }] }, { id: 'cardiology', title: 'Cardiology', noteIds: [], children: [] }] }, { id: 'level4', title: 'LEVEL 4', noteIds: [], children: [] }] }] },
  preferences: { engine: 'deepfilter', strength: 'balanced', splitMinutes: 20, audioOnly: false, folder: '', search: '', windowWidth: 1240, windowHeight: 860 }, engines: { classic: true, rnnoise: true, deepfilter: true, hybrid: true },
  jobs: [{ id: 'fixture-output', title: 'Sample lecture · audio cleanup', recordingName: 'Lecture recording', status: 'done', phase: 'Ready for AI', options: { engine: 'deepfilter' }, fraction: 1, files: [{ name: 'lecture.mp3', path: path.join(root, '.local', 'engine-probe', 'deepfilter', 'lecture.mp3') }] }],
};
const scenes = [
  { name: 'native-workspace', theme: 'dark', width: 1380, height: 860 },
  { name: 'native-light', theme: 'light', width: 1380, height: 860 },
  { name: 'native-compact', theme: 'dark', width: 800, height: 640, inspector: true },
  { name: 'native-welcome', theme: 'dark', width: 750, height: 520, welcome: true },
  { name: 'native-welcome-wide', theme: 'light', width: 1380, height: 860, welcome: true },
  { name: 'native-transcript-settings', theme: 'dark', width: 1380, height: 860, scroll: true },
  { name: 'native-transcript-light', theme: 'light', width: 1380, height: 860, scroll: true },
];
const captures = [];
for (const scene of scenes) {
  const view = structuredClone(state);
  Object.assign(view.preferences, { theme: scene.theme, windowWidth: scene.width, windowHeight: scene.height });
  view.transcription = { installed: true, gpuBuild: true, models: { turbo: true, 'large-v3': false } };
  Object.assign(view.preferences, { transcribe: true, transcriber: 'local', language: 'auto', model: 'turbo', queueExpanded: true });
  view.jobs = view.jobs.map(job => ({ ...job, options: { ...job.options, transcribe: true, transcriber: 'local' }, transcriptPath: 'C:/fixture/01 - Sample lecture.md', phase: 'Ready for AI · 6,240 words' }));
  view.previewInspector = !!scene.inspector; view.previewScrollInspector = !!scene.scroll;
  if (scene.welcome) { view.notes = []; view.library = {}; view.jobs = []; view.connection = 'Set up Brave'; view.connectionCode = 'CONNECTOR_SETUP_REQUIRED'; view.detail = 'Connect your usual Brave profile once. Future launches reuse its saved Notability session.'; }
  const fixture = path.join(directory, scene.name + '.json'); await writeFile(fixture, JSON.stringify(view));
  const screenshot = path.join(directory, scene.name + '.png');
  const child = spawn(path.join(app, 'Notakillite.Desktop.exe'), ['--data-dir', path.join(directory, 'data-' + scene.name), '--preview-fixture', fixture, '--capture-to', screenshot, '--capture-and-exit'], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; child.stdout.on('data', bytes => { diagnostics += bytes; }); child.stderr.on('data', bytes => { diagnostics += bytes; });
  const exit = await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => { child.kill(); reject(new Error('Native UI capture timed out.')); }, 30000).unref())]);
  assert.equal(exit[0], 0, diagnostics || 'Native app must exit cleanly after capturing its real WPF view.');
  assert.ok((await stat(screenshot)).size > 10000);
  captures.push({ scene: scene.name, theme: scene.theme, width: scene.width, height: scene.height, screenshot });
}
const report = { nativeWpf: 'passed', notes: notes.length, nestedFolders: 'passed', captures, cleanShutdown: 'passed', realAccount: false };
await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
