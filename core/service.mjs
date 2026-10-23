import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { NativeConnector } from './native-connector.mjs';
import { APP_VERSION } from './connector-info.mjs';
import { Store } from './store.mjs';
import { pathsFor, preparePaths, isInside } from './paths.mjs';
import { availableEngines, requireEngine, settings, assets, ENGINE_NAMES, TRANSCRIPT_DEFAULTS } from '../companion/engines.mjs';
import { processAudio, runTool, safeName } from '../companion/audio.mjs';
import { expandImports, extractEntry, zipEntries } from '../companion/notability-import.mjs';
import { transcribeAudio } from '../companion/transcribe.mjs';
import { indexMarkdown, lectureMarkdown, wordCount } from '../companion/transcript-format.mjs';
import { ensureModel, whisperStatus, WHISPER_MODELS } from '../companion/whisper.mjs';

const terminal = ['done', 'cancelled', 'error', 'interrupted'];
const defaults = { engine: 'deepfilter', strength: 'balanced', splitMinutes: 0, audioOnly: false, search: '', folder: '', theme: 'dark', windowWidth: 1280, windowHeight: 860, selectedNote: '', expandedFolders: [], folderExpansionSaved: false, queueExpanded: false, ...TRANSCRIPT_DEFAULTS };
export class CoreService extends EventEmitter {
  constructor({ dataRoot, connector, browserOptions } = {}) {
    super(); this.paths = pathsFor(dataRoot); this.modelsDir = process.env.NOTAKILLITE_MODELS_DIR || this.paths.models; this.secrets = {}; this.options = { connector, browserOptions }; this.connection = 'Starting'; this.detail = ''; this.revision = 0;
  }
  async init() {
    await preparePaths(this.paths);
    this.store = new Store(this.paths.data);
    this.preferences = { ...defaults, ...this.store.get('preferences', {}) };
    this.library = this.store.get('library', { notes: [], library: { workspaces: [] } });
    this.lastSync = this.store.get('lastSync', null);
    await this.checkEngines();
    this.connector = this.options.connector || await new NativeConnector({ store: this.store, ...this.options.browserOptions, onDisconnect: () => { if (this.closing) return; this.connectionCode = 'CONNECTOR_UNAVAILABLE'; this.connection = this.library.notes.length ? 'Offline cache' : 'Connector unavailable'; this.detail = 'Brave disconnected. Your browser sign-in is retained. Reconnect to continue.'; this.changed(); } }).init();
    this.connector.on?.('command', command => this.emit('browserCommand', command));
    this.connector.on?.('attached', () => { setTimeout(() => { if (!this.closing) void this.refresh(); }, 50); });
    this.jobs = this.store.jobs();
    for (const job of this.jobs) {
      if (!terminal.includes(job.status)) {
        if (job.input && await exists(job.input)) { job.status = 'queued'; job.phase = 'Recovering verified local source'; }
        else { job.status = 'interrupted'; job.error = 'The recording download was interrupted. Select Retry to download it again.'; }
        this.store.saveJob(job);
      }
    }
    this.connection = this.library.notes.length ? 'Offline cache' : 'Not connected';
    this.detail = 'Connect to your saved Brave session. Local audio cleanup is available anytime.';
    this.timer = setInterval(() => { if (this.connector.context) void this.refresh().catch(() => {}); }, 5000);
    this.changed(); void this.pump(); return this;
  }
  snapshot() {
    return { version: APP_VERSION, connection: this.connection, connectionCode: this.connectionCode || '', detail: this.detail, lastSync: this.lastSync, revision: this.revision, notes: this.library.notes, library: this.library.library, jobs: this.jobs, preferences: this.preferences, engines: this.engines, engineErrors: this.engineErrors, transcription: { ...this.whisper, modelsPath: this.modelsDir, download: this.modelDownload || null }, browser: this.connector.info?.() || {}, profilePath: this.paths.profile, outputPath: this.preferences.outputPath || this.paths.exports };
  }
  async checkEngines() {
    this.engines = await availableEngines(); this.engineErrors = {};
    this.whisper = await whisperStatus(this.modelsDir);
    this.engines.whisper = this.whisper.installed; this.engines.groq = !!this.secrets.groqKey;
    if (!this.whisper.installed) this.engineErrors.whisper = 'Whisper is not installed in this build. Choose Groq, or install the latest Notakillite.';
    if (this.engines.deepfilter) { try { await runTool(assets.deepfilter, ['--version'], { timeout: 5000 }); } catch { this.engines.deepfilter = this.engines.hybrid = false; this.engineErrors.deepfilter = this.engineErrors.hybrid = 'DeepFilterNet3 could not start. Use Repair audio runtime to install or repair Microsoft Visual C++.'; } }
  }
  changed(libraryChanged = false) { if (libraryChanged) this.revision++; this.emit('state', this.snapshot()); }
  save(job, patch) { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); this.store.saveJob(job); this.changed(); }
  async connect(interactive = false) {
    this.connectionStartedAt = Date.now();
    this.connectionCode = 'CONNECTING'; this.connection = 'Connecting'; this.detail = 'Reconnecting to your usual Brave profile…'; this.changed();
    try { await this.connector.connect({ interactive }); await this.refresh(); }
    catch (error) { this.connectionFailure(error); }
    return this.snapshot();
  }
  connectionFailure(error) {
    this.connectionCode = error.code || 'SITE_UNAVAILABLE';
    if (this.connectionCode === 'ADAPTER_UNAVAILABLE' && Date.now() - (this.connectionStartedAt || 0) < 30000) { this.connectionCode = 'LIBRARY_LOADING'; this.connection = 'Loading library'; this.detail = 'Notability is loading its library. Keep its tab open; the app will reconnect automatically.'; this.changed(); return; }
    const states = { SIGN_IN_REQUIRED: 'Sign-in required', CONNECTOR_SETUP_REQUIRED: 'Set up Brave', CONNECTOR_UNAVAILABLE: 'Connector unavailable', BROWSER_MISSING: 'Brave not installed', PROFILE_MISMATCH: 'Choose your paired profile', ADAPTER_UNAVAILABLE: 'Integration incompatible', INTEGRATION_INCOMPATIBLE: 'Integration incompatible', LIBRARY_LOADING: 'Loading library', SITE_TIMEOUT: 'Notability unavailable', SITE_UNAVAILABLE: 'Notability unavailable' };
    this.connection = states[this.connectionCode] || 'Connection needs attention';
    if (this.library.notes.length && ['CONNECTOR_UNAVAILABLE', 'SITE_TIMEOUT', 'SITE_UNAVAILABLE'].includes(this.connectionCode)) this.connection = 'Offline cache';
    this.detail = error.message; this.changed();
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const state = await this.connector.state();
        this.connector.rememberAccount?.(state.library?.accountId);
        this.store.set('hasConnected', true);
        const previousAccount = this.library.library?.accountId;
        if (previousAccount && previousAccount !== state.library?.accountId) {
          this.preferences.folder = ''; this.preferences.search = ''; this.store.set('preferences', this.preferences);
          if (this.active && this.active.source === 'Notability' && this.active.accountId !== state.library?.accountId) this.abort?.abort();
        }
        const changed = JSON.stringify(state) !== JSON.stringify(this.library);
        this.library = state; this.lastSync = new Date().toISOString();
        this.connectionCode = state.online ? 'CONNECTED' : 'OFFLINE'; this.connection = state.online ? 'Connected' : 'Offline cache';
        this.detail = state.online ? 'Your library follows Notability’s folders and saved sort order.' : 'Showing the library cached by Notability. New recordings may need a connection.';
        this.store.set('library', state); this.store.set('lastSync', this.lastSync); this.changed(changed);
      } catch (error) {
        this.connectionFailure(error);
      }
      return this.snapshot();
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
  async load(noteId) {
    if (this.connection !== 'Connected' && this.connection !== 'Offline cache') throw new Error('Connect to Notability before loading recordings.');
    await this.connector.recordings(noteId); await this.refresh(); return this.snapshot();
  }
  async beginSignIn() {
    await this.connector.show(); return this.snapshot();
  }
  transcriptOptions(data) {
    const value = {};
    for (const key of Object.keys(TRANSCRIPT_DEFAULTS)) value[key] = data[key] ?? this.preferences[key] ?? TRANSCRIPT_DEFAULTS[key];
    return value;
  }
  async enqueue(data) {
    const options = settings({ clean: (data.engine || this.preferences.engine) !== 'none', engine: data.engine || this.preferences.engine, strength: data.strength || this.preferences.strength, splitMinutes: data.splitMinutes ?? this.preferences.splitMinutes, ...this.transcriptOptions(data) });
    await requireEngine(options.engine);
    if (options.engine !== 'none' && !this.engines[options.engine]) throw new Error(this.engineErrors[options.engine] || 'The selected audio engine is unavailable. Choose another preset or repair it in Settings.');
    if (options.transcribe && options.transcriber === 'local' && !this.engines.whisper) throw new Error(this.engineErrors.whisper || 'Whisper is not installed.');
    if (options.transcribe && options.transcriber === 'groq' && !this.secrets.groqKey) throw new Error('Add your free Groq API key in Settings, or switch the transcript engine to Whisper on this PC.');
    const files = Array.isArray(data.files) ? data.files : data.file ? [data.file] : null;
    const items = [];
    let note, accountId, batchName;
    if (files) {
      if (!files.length || files.length > 200 || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('Choose audio files or Notability notes from your computer.');
      for (const item of await expandImports(files)) items.push({ ...item, source: item.kind === 'archive' ? 'Notability file' : 'Local file' });
      if (!items.length) throw new Error('No audio was found. Choose audio files, Notability .note exports, or a folder that contains them.');
      const archives = new Set(items.map(item => item.archive || item.file));
      batchName = items.length === 1 || archives.size === 1 ? items[0].title : files.length === 1 ? path.basename(files[0]) : `${archives.size} lectures`;
    } else {
      const live = await this.connector.state();
      accountId = live.library?.accountId;
      note = live.notes.find(note => note.id === data.noteId);
      if (!note) throw new Error('This note is no longer available in the connected account.');
      const recordings = (await this.connector.recordings(note.id)).filter(record => (data.recordingIds || []).includes(record.id));
      if (!recordings.length) throw new Error('Select at least one recording.');
      for (const recording of recordings) items.push({ source: 'Notability', title: recordings.length > 1 ? `${note.title} - ${recording.name}` : note.title, recordingName: recording.name, recordingId: recording.id, duration: recording.duration });
      batchName = note.title;
    }
    if (this.jobs.filter(job => !terminal.includes(job.status)).length + items.length > 200) throw new Error('The export queue is full. Let the current jobs finish.');
    const now = new Date(), pad = value => String(value).padStart(2, '0');
    const batchId = randomUUID();
    const batchFolder = safeName(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())} - ${batchName}`);
    const ids = [];
    for (const [index, item] of items.entries()) {
      const id = randomUUID();
      const job = { id, status: 'queued', phase: 'Queued', source: item.source, localFile: item.file, archive: item.archive, entry: item.entry, accountId, noteId: note?.id, noteUpdatedAt: note?.updatedAt, recordingId: item.recordingId || '', title: item.title, recordingName: item.recordingName, duration: item.duration || 0, options, createdAt: now.toISOString(), fraction: 0, files: [], outputRoot: this.preferences.outputPath || this.paths.exports, batchId, batchFolder, batchTitle: batchName, batchSize: items.length, order: index + 1 };
      this.jobs.unshift(job); this.store.saveJob(job); ids.push(id);
    }
    this.changed(); void this.pump(); return { ids, batchId };
  }
  async pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = [...this.jobs].reverse().find(job => job.status === 'queued');
        if (!job || this.closing) break;
        this.active = job; this.abort = new AbortController();
        await this.run(job, this.abort.signal);
        this.active = undefined; this.abort = undefined;
      }
    } finally { this.pumping = false; }
  }
  async run(job, signal) {
    const directory = path.join(this.paths.temp, job.id);
    let staging;
    await mkdir(directory, { recursive: true });
    try {
      this.save(job, { status: 'running', phase: 'Checking audio', error: null, fraction: 0.01 });
      await mkdir(job.outputRoot, { recursive: true });
      const disk = await statfs(job.outputRoot).catch(() => null);
      const expected = Math.max(256 * 1024 ** 2, (job.duration || 0) * 48000 * 8 + 128 * 1024 ** 2);
      if (disk && disk.bavail * disk.bsize < expected) throw new Error('There is not enough free space for decoded audio. Choose another export folder or free disk space.');
      let input = job.input;
      if (!input || !await exists(input)) {
        input = path.join(directory, 'source.audio');
        const partial = path.join(directory, 'source.partial');
        await rm(partial, { force: true });
        if (job.source === 'Local file' || job.source === 'Notability file') {
          const sourceFile = job.archive || job.localFile;
          this.save(job, { phase: job.archive ? 'Opening Notability note' : 'Copying local audio', fraction: 0.02 });
          const file = await stat(sourceFile);
          if (job.localFingerprint && job.localFingerprint !== `${file.size}:${file.mtimeMs}`) throw new Error('The source file changed. Import the file again to export this version.');
          job.localFingerprint = `${file.size}:${file.mtimeMs}`;
          if (job.archive) {
            const entry = (await zipEntries(job.archive)).find(item => item.name === job.entry);
            if (!entry) throw new Error('This recording is no longer in the note file. Import the note again.');
            await extractEntry(job.archive, entry, partial, { signal });
          } else await copyFile(job.localFile, partial);
          const after = await stat(sourceFile);
          if (`${after.size}:${after.mtimeMs}` !== job.localFingerprint) throw new Error('The source file changed while being imported. Wait for it to finish saving, then import it again.');
        } else {
          const state = await this.connector.state();
          const current = state.notes.find(note => note.id === job.noteId);
          if (state.library?.accountId !== job.accountId || !current || String(current.updatedAt) !== String(job.noteUpdatedAt)) throw new Error('The account or note changed since this job was queued. Load the note and export it again.');
          this.save(job, { phase: 'Downloading from Notability', fraction: 0.02 });
          const capture = await this.connector.capture(job.noteId, job.recordingId, partial, { signal, onProgress: fraction => this.save(job, { phase: `Downloading ${Math.round(fraction * 100)}%`, fraction: fraction * 0.15 }) });
          job.mimeType = capture.mimeType;
        }
        signal.throwIfAborted(); await rename(partial, input); this.save(job, { input, phase: 'Source ready' });
      }
      signal.throwIfAborted();
      // Batches share one folder ("01 - Lecture.md", "02 - ..."); older single jobs keep their own folder.
      const batch = !!job.batchFolder;
      const destination = job.destination || (batch ? path.join(job.outputRoot, job.batchFolder) : path.join(job.outputRoot, `${safeName(job.title)} - ${safeName(job.recordingName)} - ${job.id.slice(0, 8)}`));
      if (!isInside(job.outputRoot, destination)) throw new Error('Invalid export destination.');
      await mkdir(destination, { recursive: true });
      if (!batch) {
        const marker = path.join(destination, '.notakillite-job.json');
        if (await exists(marker) && JSON.parse(await readFile(marker, 'utf8')).id !== job.id) throw new Error('The output folder belongs to another export.');
        await writeFile(marker, JSON.stringify({ id: job.id }));
      }
      this.save(job, { destination });
      const transcribe = !!job.options.transcribe, audioShare = transcribe ? 0.4 : 0.84;
      staging = path.join(destination, batch ? `.partial-${job.id.slice(0, 8)}` : '.partial');
      if (!isInside(destination, staging)) throw new Error('Invalid temporary export destination.');
      await rm(staging, { recursive: true, force: true }); await mkdir(staging);
      let manifest;
      if (job.options.engine === 'none' && job.options.splitMinutes === 0) {
        const ext = job.archive ? path.posix.extname(job.entry).slice(1).replace(/[^a-z0-9]/gi, '') : job.source === 'Local file' ? path.extname(job.localFile).slice(1).replace(/[^a-z0-9]/gi, '') : ({ 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg' }[job.mimeType?.split(';')[0]] || 'audio');
        const filename = `original.${ext || 'audio'}`;
        await copyFile(input, path.join(staging, filename)); signal.throwIfAborted();
        manifest = { title: job.title, recording: job.recordingName, noiseReductionEngine: 'none', files: [{ name: filename, bytes: (await stat(path.join(staging, filename))).size }] };
        await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } else {
        manifest = await processAudio({ ffmpeg, input, destination: staging, metadata: { title: job.title, recordingName: job.recordingName, source: job.source, ...job.options }, signal,
          onStage: stage => this.save(job, { phase: stage.phase, fraction: 0.15 + stage.fraction * audioShare }),
          onProgress: seconds => { job.processedSeconds = seconds; },
        });
        this.save(job, { phase: 'Verifying complete audio', fraction: 0.15 + audioShare });
        let decodedSeconds = 0;
        for (const file of manifest.files) {
          let seconds = 0;
          await runTool(ffmpeg, ['-v', 'error', '-nostdin', '-i', path.join(staging, file.name), '-map', '0:a:0', '-vn', '-f', 'null', '-', '-progress', 'pipe:1'], { signal, onProgress: value => { seconds = Math.max(seconds, value); } });
          decodedSeconds += seconds;
        }
        if (manifest.encodedSeconds > 0 && Math.abs(decodedSeconds - manifest.encodedSeconds) > Math.max(0.5, manifest.encodedSeconds * 0.001)) throw new Error('The exported audio duration did not match the completed encoding. Retry the export.');
      }
      signal.throwIfAborted();
      let transcript;
      if (transcribe) {
        const work = path.join(directory, 'transcribe');
        await rm(work, { recursive: true, force: true }); await mkdir(work);
        const cleaned = manifest.files.map(file => path.join(staging, file.name));
        const fromOriginal = job.options.transcribeFrom === 'original' || job.options.engine === 'none';
        const result = await transcribeAudio({ ffmpeg, inputs: fromOriginal ? [input] : cleaned, work, options: job.options, secrets: this.secrets, modelsDir: this.modelsDir, signal,
          onStage: stage => this.save(job, { phase: stage.phase, fraction: 0.6 + stage.fraction * 0.38 }) });
        await rm(work, { recursive: true, force: true });
        const sourceFile = job.archive ? path.basename(job.archive) : job.localFile ? path.basename(job.localFile) : 'Notability web library';
        const cleanup = `${ENGINE_NAMES[job.options.engine]}${fromOriginal && job.options.engine !== 'none' ? ' (transcribed from the original audio)' : ''}`;
        const markdown = lectureMarkdown({ title: job.title, recording: job.recordingName, sourceFile, duration: result.duration, cleanup, transcript: result, includePrompt: job.options.aiPrompt, number: batch ? job.order : undefined, total: batch ? job.batchSize : undefined });
        await writeFile(path.join(staging, 'transcript.md'), markdown, 'utf8');
        transcript = { engine: result.engine, model: result.model, device: result.device, language: result.language, words: wordCount(result.segments), seconds: result.duration };
        manifest.transcript = { file: 'transcript.md', ...transcript };
        await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
      }
      signal.throwIfAborted();
      // Promote only verified generated files; partial encodes never appear as complete outputs.
      const renamed = new Map();
      for (const name of await readdir(staging)) {
        const output = batch ? batchOutputName(name, job) : name;
        if (!output) continue;
        const target = path.join(destination, output);
        if (!isInside(destination, target)) throw new Error('Invalid generated file path.');
        await mkdir(path.dirname(target), { recursive: true });
        await rm(target, { force: true }); await rename(path.join(staging, name), target);
        renamed.set(name, output);
      }
      await rm(staging, { recursive: true, force: true });
      const files = manifest.files.map(file => ({ ...file, name: renamed.get(file.name) || file.name, path: path.join(destination, renamed.get(file.name) || file.name) }));
      const transcriptPath = transcript ? path.join(destination, renamed.get('transcript.md') || 'transcript.md') : null;
      if (transcriptPath) files.push({ name: path.basename(transcriptPath), path: transcriptPath, kind: 'transcript', bytes: (await stat(transcriptPath)).size });
      this.save(job, { status: 'done', phase: transcript ? `Ready for AI · ${transcript.words.toLocaleString('en-US')} words` : 'Ready for AI', fraction: 1, files, transcriptPath, transcript: transcript || null, finishedAt: new Date().toISOString(), input: null });
      if (batch && transcript) await this.writeIndex(job).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      const cancelled = signal.aborted;
      this.save(job, { status: this.closing ? 'interrupted' : cancelled ? 'cancelled' : 'error', phase: this.closing ? 'Interrupted — retry available' : cancelled ? 'Cancelled' : 'Export needs attention', error: error.message, fraction: null });
      await rm(path.join(directory, 'source.partial'), { force: true }).catch(() => {});
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
      // Remove incomplete decoded chunks while retaining the complete source for retry.
      for (const name of await readdir(directory).catch(() => [])) if (/^denoise-[a-zA-Z0-9]+$|^transcribe$/.test(name)) await rm(path.join(directory, name), { recursive: true, force: true }).catch(() => {});
    }
  }
  async writeIndex(job) {
    const done = this.jobs.filter(item => item.batchId === job.batchId && item.status === 'done' && item.transcriptPath).sort((a, b) => a.order - b.order);
    if (!done.length) return;
    const markdown = indexMarkdown({ title: job.batchTitle || job.title, lectures: done.map(item => ({ number: item.order, title: item.title, duration: item.transcript?.seconds, words: item.transcript?.words, transcript: path.basename(item.transcriptPath) })) });
    const target = path.join(job.destination, '00 - Index.md'), temporary = `${target}.partial`;
    await writeFile(temporary, markdown, 'utf8'); await rename(temporary, target);
  }
  async downloadModel(name) {
    if (!WHISPER_MODELS[name]) throw new Error('Choose a supported Whisper model.');
    if (this.modelDownload) return this.snapshot();
    this.modelDownload = { model: name, fraction: 0 }; this.changed();
    let last = 0;
    void ensureModel(name, this.modelsDir, { onProgress: fraction => { if (fraction - last >= 0.01 || fraction === 1) { last = fraction; this.modelDownload = { model: name, fraction }; this.changed(); } } })
      .then(() => { this.detail = `${WHISPER_MODELS[name].label} is ready for transcripts.`; }, error => { this.detail = error.message; })
      .finally(async () => { this.modelDownload = null; await this.checkEngines(); this.changed(); });
    return this.snapshot();
  }
  async cancel(id) {
    const job = this.jobs.find(job => job.id === id); if (!job) return;
    if (this.active?.id === id) this.abort.abort();
    else if (job.status === 'queued') this.save(job, { status: 'cancelled', phase: 'Cancelled' });
  }
  async retry(id) {
    const job = this.jobs.find(job => job.id === id);
    if (!job || !['error', 'interrupted', 'cancelled'].includes(job.status)) throw new Error('Choose an interrupted or failed job to retry.');
    this.save(job, { status: 'queued', phase: 'Queued for retry', error: null, fraction: 0 }); void this.pump();
  }
  savePreferences(data) {
    const allowed = [...Object.keys(TRANSCRIPT_DEFAULTS), 'engine', 'strength', 'splitMinutes', 'audioOnly', 'search', 'folder', 'windowWidth', 'windowHeight', 'outputPath', 'theme', 'selectedNote', 'expandedFolders', 'folderExpansionSaved', 'queueExpanded'];
    const next = { ...this.preferences }; for (const key of allowed) if (Object.hasOwn(data, key)) next[key] = data[key];
    settings({ ...next, clean: next.engine !== 'none' });
    if (next.outputPath && !path.isAbsolute(next.outputPath)) throw new Error('Choose an absolute export folder.');
    if (!['dark', 'light', 'system'].includes(next.theme) || !Array.isArray(next.expandedFolders) || next.expandedFolders.length > 2000) throw new Error('Invalid display preferences.');
    this.preferences = next; this.store.set('preferences', next); return this.snapshot();
  }
  async handle(type, data = {}) {
    switch (type) {
      case 'state': return this.snapshot();
      case 'engineCheck': await this.checkEngines(); this.changed(); return this.snapshot();
      case 'connect': return this.connect(true);
      case 'autoConnect': return this.connect(false);
      case 'browserHello': return this.connector.accept(data.connectionId, data.hello);
      case 'browserResponse': this.connector.receive(data.connectionId, data.message); return {};
      case 'browserDisconnected': this.connector.detach(data.connectionId); return {};
      case 'browserProfiles': return this.connector.info();
      case 'browserProfile': if (this.active?.source === 'Notability' && !this.active.input) throw new Error('Wait for the recording download or cancel it before changing Brave profiles.'); await this.connector.configure(data.directory); this.changed(); return this.snapshot();
      case 'openExtensions': await this.connector.openExtensions(); return {};
      case 'showNotability': await this.connector.show(); return {};
      case 'manualSignIn': return this.beginSignIn();
      case 'refresh': return this.refresh();
      case 'recordings': return this.load(data.noteId);
      case 'export': return this.enqueue(data);
      case 'secrets': this.secrets.groqKey = typeof data.groqKey === 'string' ? data.groqKey.trim().slice(0, 200) : ''; this.engines.groq = !!this.secrets.groqKey; this.changed(); return {};
      case 'downloadModel': return this.downloadModel(data.model || this.preferences.model);
      case 'preferences': return this.savePreferences(data);
      case 'cancel': await this.cancel(data.id); return {};
      case 'retry': await this.retry(data.id); return {};
      case 'clearCompleted': for (const job of this.jobs.filter(job => job.status === 'done')) this.store.removeJob(job.id); this.jobs = this.jobs.filter(job => job.status !== 'done'); this.changed(); return {};
      case 'reveal': {
        const job = this.jobs.find(job => job.id === data.id); const target = job?.destination || this.preferences.outputPath || this.paths.exports;
        spawn('explorer.exe', [target], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); return {};
      }
      default: throw new Error('Unknown app action.');
    }
  }
  async close() { this.closing = true; clearInterval(this.timer); this.abort?.abort(); await this.connector.close(); for (let i = 0; i < 350 && this.pumping; i++) await new Promise(resolve => setTimeout(resolve, 50)); if (this.pumping) throw new Error('An audio worker did not finish closing. Its verified source is retained for recovery.'); this.store.close(); }
}
// Final names inside a batch folder: "03 - Title.mp3", "03 - Title (part 2).mp3", "03 - Title.md".
function batchOutputName(name, job) {
  const prefix = `${String(job.order).padStart(2, '0')} - ${safeName(job.title)}`;
  if (name === 'lecture.mp3') return `${prefix}.mp3`;
  const part = /^lecture-(\d+)\.mp3$/.exec(name);
  if (part) return `${prefix} (part ${Number(part[1]) + 1}).mp3`;
  const original = /^original\.([a-z0-9]+)$/i.exec(name);
  if (original) return `${prefix}.${original[1]}`;
  if (name === 'transcript.md') return `${prefix}.md`;
  if (name === 'manifest.json') return path.join('.notakillite', `${prefix}.json`);
  return null; // The batch index replaces the per-recording READ ME.
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
