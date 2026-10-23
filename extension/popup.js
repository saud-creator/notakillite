"use strict";

const byId = (id) => document.getElementById(id);
const elements = {
  connection: byId("connection"), connectionLabel: byId("connection-label"),
  processorStatus: byId("processor-status"), processorHelp: byId("processor-help"),
  clean: byId("clean-audio"), split: byId("split-minutes"), search: byId("search"),
  notes: byId("notes"), count: byId("note-count"), empty: byId("empty-state"),
  emptyTitle: byId("empty-title"), emptyDescription: byId("empty-description"),
  feedback: byId("feedback"), feedbackText: byId("feedback-text"), refresh: byId("refresh"),
  live: document.querySelector(".live-label"), liveText: byId("live-label-text"), output: byId("open-output"), clear: byId("clear-session"),
  folders: byId("library-folders"), path: byId("library-path"), workspace: byId("workspace-select"), workspaceControl: byId("workspace-control"),
  audioOnly: byId("audio-only"), sort: byId("library-sort"),
  engine: byId("noise-engine"), strength: byId("noise-strength"), engineDescription: byId("engine-description"),
  file: byId("audio-file"), fileName: byId("selected-file"), fileButton: byId("process-file"),
  progress: byId("export-progress"), meter: byId("progress-meter"), progressCaption: byId("progress-caption"),
  noteSection: byId("note-section-heading"),
};
let state = { connected: false, notes: [], bridge: { ready: false } };
const selectedRecordings = new Map();
const exporting = new Set();
const loadingRecordings = new Set();
let updateTimer;
let loading = false;
let reloadRequested = false;
let feedbackSource = "local";
let navigation = { accountId: undefined, workspaceId: undefined, folderId: undefined };
const connection = new NotakilliteWorkerClient();
let connectionAlive = true;
let localBusy = false;
let selectedFile;
let localProgress;
let preferencesLoaded = false;

function request(message) {
  return connection.request(message).then(response => {
    if (response?.error && response.ok === false) throw new Error(response.error);
    return response;
  });
}

function feedback(message, isError = false, source = "local") {
  feedbackSource = source;
  elements.feedbackText.textContent = message;
  elements.feedback.classList.toggle("is-error", isError);
  elements.feedback.hidden = !message;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDuration(duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function formatBytes(bytes) { return bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }

function updatedLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function availableRecordings(note) {
  return (Array.isArray(note.recordings) ? note.recordings : []).filter((recording) => recording.available);
}

function needsProcessor() {
  return elements.clean.checked || Number(elements.split.value) > 0;
}

function isBusy() { return Boolean(state.busy) || localBusy || exporting.size > 0 || !connectionAlive; }
function engineReady() { return !elements.clean.checked || Boolean(state.bridge?.engines?.[elements.engine.value]); }
function exportOptions() { return { clean: elements.clean.checked, engine: elements.engine.value, strength: elements.strength.value, splitMinutes: Number(elements.split.value) }; }

function getSelected(note) {
  const available = availableRecordings(note);
  if (!available.length) return new Set();
  const known = selectedRecordings.get(note.id);
  if (!known) {
    const defaults = new Set(available.map((recording) => recording.id));
    selectedRecordings.set(note.id, defaults);
    return defaults;
  }
  return known;
}

function noteCard(note) {
  const card = makeElement("article", "note-card");
  const top = makeElement("div", "note-top");
  const icon = makeElement("span", "note-icon", "♫");
  icon.setAttribute("aria-hidden", "true");
  const info = makeElement("div", "note-info");
  const title = makeElement("h3", "note-title", note.title || "Untitled note");
  title.dir = "auto";
  info.append(title);
  const recordings = Array.isArray(note.recordings) ? note.recordings : [];
  const recordingLabel = recordings.length ? `${recordings.length} recording${recordings.length === 1 ? "" : "s"}` : note.hasRecordings ? "Recordings available" : "Synced note";
  const meta = [recordingLabel, updatedLabel(note.updatedAt)].filter(Boolean).join(" · ");
  info.append(makeElement("div", "note-meta", meta));
  top.append(icon, info);
  card.append(top);
  if (elements.search.value.trim() && note.path?.length) {
    const location = makeElement("button", "note-location text-button", note.path.map(item => item.title).join(" / "));
    location.type = "button";
    location.dir = "auto";
    location.addEventListener("click", () => navigate(note.workspaceId, note.folderId));
    card.append(location);
  }
  if (note.error) card.append(makeElement("p", "note-error", String(note.error)));

  if (!recordings.length) {
    if (note.hasRecordings === false && !note.error) {
      card.append(makeElement("p", "no-recordings", "This note has no audio recordings."));
      return card;
    }
    const loadButton = makeElement("button", "export-button load-button", loadingRecordings.has(note.id) ? "Loading recordings…" : note.error ? "Try loading again" : "Load recordings");
    loadButton.type = "button";
    loadButton.disabled = loadingRecordings.size > 0 || isBusy() || !state.connected;
    loadButton.addEventListener("click", () => void loadRecordings(note.id));
    card.append(loadButton);
    card.append(makeElement("p", "no-recordings", "Read the recordings from this note in your synced account."));
    return card;
  }

  const selected = getSelected(note);
  const recordingList = makeElement("div", "recordings");
  for (const recording of recordings) {
    const label = makeElement("label", `recording${recording.available ? "" : " is-unavailable"}`);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = recording.available && selected.has(recording.id);
    checkbox.disabled = !recording.available || isBusy();
    checkbox.setAttribute("aria-label", `Export ${recording.name || "recording"}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(recording.id);
      else selected.delete(recording.id);
      renderNotes();
    });
    const name = makeElement("span", "recording-name", recording.name || "Lecture recording");
    name.title = name.textContent;
    label.append(checkbox, name);
    const duration = formatDuration(recording.duration);
    if (duration) label.append(makeElement("span", "recording-duration", duration));
    if (!recording.available) label.append(makeElement("span", "recording-duration", "Unavailable"));
    recordingList.append(label);
  }
  card.append(recordingList);
  const selectedIds = availableRecordings(note).filter((recording) => selected.has(recording.id)).map((recording) => recording.id);
  const button = makeElement("button", "export-button", isBusy() ? "Export in progress…" : `↓  Export audio${selectedIds.length > 1 ? ` (${selectedIds.length})` : ""}`);
  button.type = "button";
  button.disabled = isBusy() || loadingRecordings.size > 0 || !selectedIds.length || (needsProcessor() && (!state.bridge?.ready || !engineReady()));
  button.addEventListener("click", () => exportNote(note.id, selectedIds));
  card.append(button);
  if (needsProcessor() && !state.bridge?.ready) {
    card.append(makeElement("p", "export-hint", "Start the companion, or choose “Use original audio” above."));
  }
  else if (!engineReady()) card.append(makeElement("p", "export-hint", "This engine needs the latest app processor. Choose an installed engine or reopen the updated EXE."));
  return card;
}

function locationIndex() {
  const workspaces = state.library?.workspaces || [];
  const index = new Map();
  function visit(node, workspace, path = []) {
    index.set(`${workspace.id}/${node.id}`, { node, workspace, path });
    for (const child of node.children || []) visit(child, workspace, [...path, { id: node.id, title: node.title }]);
  }
  for (const workspace of workspaces) {
    index.set(workspace.id, { node: workspace, workspace, path: [] });
    for (const child of workspace.children || []) visit(child, workspace);
  }
  return { workspaces, index };
}

function syncNavigation(workspaces, index) {
  if (!state.library) return;
  const accountId = state.library?.accountId;
  if (navigation.accountId !== accountId) { navigation = { accountId }; selectedRecordings.clear(); }
  if (!workspaces.some(workspace => workspace.id === navigation.workspaceId)) navigation.workspaceId = state.library?.privateWorkspaceId || workspaces[0]?.id;
  if (navigation.folderId && !index.has(`${navigation.workspaceId}/${navigation.folderId}`)) navigation.folderId = undefined;
}

function saveNavigation() {
  void chrome.storage.local.set({ libraryNavigation: { ...navigation, audioOnly: elements.audioOnly.checked } }).catch(() => {});
}

function navigate(workspaceId, folderId) {
  navigation = { accountId: state.library?.accountId, workspaceId, folderId };
  elements.search.value = "";
  saveNavigation();
  renderNotes();
}

function folderCard(item, workspace, notesById, searching = false) {
  const button = makeElement("button", "folder-card");
  button.type = "button";
  button.dataset.folderId = item.id;
  button.dataset.workspaceId = workspace.id;
  const icon = makeElement("span", "folder-icon", item.type === "Divider" ? "▤" : "▰");
  icon.setAttribute("aria-hidden", "true");
  if (/^#[0-9a-f]{6}$/i.test(item.color)) icon.style.color = item.color;
  const details = makeElement("span", "folder-info");
  const title = makeElement("span", "folder-title", item.title);
  title.dir = "auto";
  details.append(title);
  function count(node) {
    return (node.noteIds || []).filter(id => notesById.has(id) && (!elements.audioOnly.checked || notesById.get(id).hasRecordings)).length + (node.children || []).reduce((sum, child) => sum + count(child), 0);
  }
  const total = count(item);
  const meta = searching && item.path?.length ? item.path.map(parent => parent.title).join(" / ") : `${total} ${elements.audioOnly.checked ? "audio " : ""}note${total === 1 ? "" : "s"}${item.children?.length ? ` · ${item.children.length} folders` : ""}`;
  const description = makeElement("span", "folder-meta", meta);
  description.dir = "auto";
  details.append(description);
  button.append(icon, details, makeElement("span", "folder-chevron", "›"));
  button.addEventListener("click", () => navigate(workspace.id, item.id));
  return button;
}

function renderNotes() {
  const notes = Array.isArray(state.notes) ? state.notes : [];
  const notesById = new Map(notes.map(note => [note.id, note]));
  const { workspaces, index } = locationIndex();
  syncNavigation(workspaces, index);
  const query = elements.search.value.trim().toLocaleLowerCase();
  const selected = index.get(navigation.folderId ? `${navigation.workspaceId}/${navigation.folderId}` : navigation.workspaceId);
  const visible = query || !selected ? notes : (selected.node.noteIds || []).map(id => notesById.get(id)).filter(Boolean);
  const filtered = visible.filter(note => (!elements.audioOnly.checked || note.hasRecordings !== false) && (!query || [note.title, ...(note.path || []).map(item => item.title), ...(note.recordings || []).map(recording => recording.name)].join(" ").toLocaleLowerCase().includes(query)));
  const folders = query ? [...index.values()].filter(item => item.node !== item.workspace && [item.node.title, ...(item.node.path || []).map(parent => parent.title)].join(" ").toLocaleLowerCase().includes(query)) : (selected?.node.children || []).map(node => ({ node, workspace: selected.workspace }));
  elements.count.textContent = String(notes.length);
  elements.workspaceControl.hidden = workspaces.length < 2;
  const workspaceSignature = JSON.stringify(workspaces.map(workspace => [workspace.id, workspace.title]));
  if (elements.workspace.dataset.signature !== workspaceSignature) {
    elements.workspace.replaceChildren(...workspaces.map(workspace => { const option = makeElement("option", "", workspace.title); option.value = workspace.id; return option; }));
    elements.workspace.dataset.signature = workspaceSignature;
  }
  elements.workspace.value = navigation.workspaceId || "";
  const modes = { name: "Name", created: "Created date", edited: "Modified date" };
  const sort = state.library?.sort;
  elements.sort.textContent = sort ? `${modes[sort.mode] || "Created date"}${sort.matched ? " · Notability" : " · default"}` : "";
  elements.sort.title = sort?.matched ? "Follows your current Notability library sort setting." : "Notability’s sort preference is unavailable; using its default created-date order.";
  const breadcrumbs = [];
  if (selected) {
    const root = makeElement("button", "breadcrumb", selected.workspace.title);
    root.type = "button";
    root.addEventListener("click", () => navigate(selected.workspace.id));
    breadcrumbs.push(root);
    const parents = navigation.folderId ? [...selected.path, { id: selected.node.id, title: selected.node.title }] : [];
    for (const parent of parents) {
      breadcrumbs.push(makeElement("span", "breadcrumb-separator", "/"));
      const crumb = makeElement("button", "breadcrumb", parent.title);
      crumb.type = "button"; crumb.dir = "auto";
      if (parent.id === navigation.folderId) crumb.setAttribute("aria-current", "page");
      crumb.addEventListener("click", () => navigate(selected.workspace.id, parent.id));
      breadcrumbs.push(crumb);
    }
  }
  if (query) breadcrumbs.push(makeElement("span", "search-scope", "Search across all folders"));
  elements.path.replaceChildren(...breadcrumbs);
  elements.folders.replaceChildren(...folders.map(item => folderCard(item.node, item.workspace, notesById, Boolean(query))));
  elements.noteSection.hidden = !filtered.length;
  elements.noteSection.textContent = `${query ? "Matching notes" : selected && !navigation.folderId && selected.workspace.kind !== "shared" ? "Unfiled notes" : "Notes"} (${filtered.length})`;
  elements.notes.replaceChildren(...filtered.map(noteCard));
  elements.empty.hidden = filtered.length > 0 || folders.length > 0;
  if (query && !filtered.length && !folders.length) {
    elements.emptyTitle.textContent = "No matching notes or folders";
    elements.emptyDescription.textContent = "Try a different folder, note title or recording name.";
  } else if (selected && state.connected && !state.error) {
    elements.emptyTitle.textContent = elements.audioOnly.checked ? "No recordings in this folder" : "This folder is empty";
    elements.emptyDescription.textContent = elements.audioOnly.checked ? "Turn off Audio only to see all of its notes." : "Folders and notes appear here as they sync from Notability.";
  } else {
    elements.emptyTitle.textContent = state.error ? "The account connection needs attention" : state.connected ? "No synced notes found" : "Your lectures will appear here";
    elements.emptyDescription.textContent = state.error ? String(state.error) : state.connected ? "Notes from your synced Notability account appear here. Refresh after your library finishes syncing." : "Sign in on notability.com and keep your library open. Your synced notes will appear here; choose a note to load its recordings.";
  }
}

function render() {
  document.body.classList.toggle("has-library", Boolean(state.connected));
  elements.connection.classList.toggle("is-connected", Boolean(state.connected && connectionAlive));
  elements.connectionLabel.textContent = !connectionAlive ? "Reconnecting…" : state.connected ? state.online === true ? "Notability web account" : "Notability account · offline cache" : state.error ? "Connection needs attention" : "Waiting for Notability";
  elements.live.classList.toggle("is-connected", Boolean(state.connected && connectionAlive && state.online === true));
  elements.liveText.textContent = !connectionAlive ? "RECONNECTING" : state.connected ? state.online === true ? "AUTO REFRESH" : "OFFLINE CACHE" : "ACCOUNT LIBRARY";
  const ready = Boolean(state.bridge?.ready);
  elements.processorStatus.textContent = ready ? "Processor ready" : "Companion offline";
  elements.processorStatus.classList.toggle("is-ready", ready);
  elements.processorHelp.hidden = ready || !needsProcessor();
  elements.output.disabled = !ready;
  elements.clear.disabled = isBusy() || loadingRecordings.size > 0;
  elements.clean.disabled = isBusy();
  elements.engine.disabled = isBusy() || !elements.clean.checked;
  elements.strength.disabled = isBusy() || !elements.clean.checked || elements.engine.value === "classic";
  const descriptions = {
    deepfilter: "Detailed speech cleanup with DeepFilterNet3. Balanced keeps more quiet speech.",
    rnnoise: "Fast neural noise reduction with RNNoise. A good choice for long lectures.",
    hybrid: "RNNoise followed by DeepFilterNet3. Slower; may soften quiet speech.",
    classic: "Light cleanup for steady hiss and hum, with balanced volume.",
  };
  elements.engineDescription.textContent = !elements.clean.checked ? "Original audio stays unchanged. Splitting, if selected, converts it to MP3." : !engineReady() ? "This engine is unavailable. Reopen the latest EXE or choose another engine." : descriptions[elements.engine.value];
  elements.engineDescription.classList.toggle("is-error", elements.clean.checked && !engineReady());
  const engineNames = { deepfilter: 'DeepFilterNet3', rnnoise: 'RNNoise', hybrid: 'Both engines', classic: 'Light cleanup' };
  byId('engine-summary').textContent = elements.clean.checked ? `${engineNames[elements.engine.value]} · ${elements.strength.value === 'strong' ? 'Strong' : 'Balanced'}` : 'Original audio';
  for (const option of elements.engine.options) option.disabled = state.bridge?.ready && !state.bridge?.engines?.[option.value];
  elements.file.disabled = isBusy();
  elements.fileButton.disabled = isBusy() || !selectedFile || !state.bridge?.ready || !engineReady();
  elements.fileButton.textContent = localBusy ? "Processing audio…" : elements.clean.checked ? "Clean & export MP3" : "Convert to MP3";
  const progress = localProgress || (state.busy ? state.progress : null);
  elements.progress.hidden = !progress;
  if (progress) {
    if (Number.isFinite(progress.fraction)) elements.meter.value = Math.max(0, Math.min(1, progress.fraction));
    else elements.meter.removeAttribute("value");
    elements.progressCaption.textContent = progress.phase || "Working on your audio…";
  }
  elements.split.disabled = isBusy();
  byId("use-originals").disabled = isBusy();
  renderNotes();
}

async function refreshState() {
  if (loading) { reloadRequested = true; return; }
  loading = true;
  try {
    const next = await request({ type: "GET_STATE" });
    if (!next || typeof next !== "object" || !Array.isArray(next.notes)) throw connection.interrupted();
    connectionAlive = true;
    state = next;
    render();
    if (localBusy) return;
    if (next.error) feedback(String(next.error), true, "state");
    else if (next.message) feedback(String(next.message), false, "state");
    else if (feedbackSource === "state" || feedbackSource === "transport") feedback("", false, "state");
  } catch (error) {
    connectionAlive = false;
    render();
    feedback(error.transport ? "Reconnecting to the app. Your library and current folder are preserved." : error.message || "Could not read the Notability session.", !error.transport, "transport");
  } finally {
    loading = false;
    if (reloadRequested) { reloadRequested = false; void refreshState(); }
  }
}

async function loadRecordings(noteId) {
  loadingRecordings.add(noteId);
  render();
  try {
    const result = await request({ type: "LOAD_RECORDINGS", noteId });
    if (result?.ok === false) throw new Error(result.error || "Could not load the recordings for this note.");
    await refreshState();
  } catch (error) { feedback(error.message || "Could not load this note's recordings. Refresh the connection and try again.", true); }
  finally { loadingRecordings.delete(noteId); render(); }
}

async function exportNote(noteId, recordingIds) {
  exporting.add(noteId);
  feedback("Preparing your audio. Keep Notability open while the recording is downloaded.");
  render();
  try {
    const result = await request({ type: "EXPORT_AUDIO", noteId, recordingIds, ...exportOptions() });
    if (!result?.ok) throw new Error(result?.error || "The audio could not be exported. Refresh the connection and load the recordings again.");
    feedback(result.message || "Your audio export is ready.");
    await refreshState();
  } catch (error) { feedback(error.message || "Could not export this recording.", true); }
  finally { exporting.delete(noteId); render(); }
}

async function action(type) {
  try {
    const result = await request({ type });
    if (result?.error) throw new Error(result.error);
    return result;
  } catch (error) { feedback(error.message || "Could not complete this action.", true); return null; }
}

function openNotability(event) {
  event.preventDefault();
  void action("OPEN_NOTABILITY");
}

async function loadPreferences() {
  try {
    const saved = await chrome.storage.local.get("audioExportPreferences");
    const preferences = saved.audioExportPreferences;
    if (typeof preferences?.clean === "boolean") elements.clean.checked = preferences.clean;
    if ([0, 10, 20, 30].includes(preferences?.splitMinutes)) elements.split.value = String(preferences.splitMinutes);
    if (["classic", "rnnoise", "deepfilter", "hybrid"].includes(preferences?.engine)) elements.engine.value = preferences.engine;
    if (["balanced", "strong"].includes(preferences?.strength)) elements.strength.value = preferences.strength;
    if (typeof preferences?.expanded === 'boolean') byId('export-settings').open = preferences.expanded;
    const library = (await chrome.storage.local.get("libraryNavigation")).libraryNavigation;
    if (library && typeof library === "object") {
      navigation = { accountId: library.accountId, workspaceId: library.workspaceId, folderId: library.folderId };
      elements.audioOnly.checked = library.audioOnly === true;
    }
  } catch (error) { feedback(error.message || "Could not load your export preferences.", true); }
  finally { preferencesLoaded = true; }
}

async function savePreferences() {
  render();
  try {
    await chrome.storage.local.set({ audioExportPreferences: { ...exportOptions(), expanded: byId('export-settings').open } });
  } catch (error) { feedback(error.message || "Could not save your export preferences.", true); }
}

const LOCAL_PROCESSOR = 'http://127.0.0.1:43188';
async function localAPI() {
  const response = await fetch(`${LOCAL_PROCESSOR}/health`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(3000) });
  const health = await response.json();
  if (!response.ok || !health.ready || !health.token) throw new Error('Open the latest Notakillite EXE to start the audio processor.');
  return async (url, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${LOCAL_PROCESSOR}${url}`, { method, body, headers: { 'X-Notakillite-Token': health.token, ...headers }, signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'The audio processor could not complete this step.'); error.status = response.status; throw error; }
    return result;
  };
}
function chooseFile(file) {
  if (!file || isBusy()) return;
  if (!file.size || file.size > 2 * 1024 ** 3) { feedback('Choose a nonempty audio file smaller than 2 GB.', true); return; }
  selectedFile = file;
  elements.fileName.hidden = false;
  elements.fileName.textContent = `${file.name} · ${formatBytes(file.size)}`;
  byId('file-results').hidden = true;
  render();
}
async function monitorLocal(api, jobId, filename) {
  for (;;) {
    const result = await api(`/jobs/${jobId}`);
    if (result.status === 'error') { const error = new Error(result.error || 'Audio processing failed.'); error.terminal = true; throw error; }
    if (result.status === 'uploading') throw new Error('The file upload was interrupted. Select your file and try again.');
    if (result.status === 'done') {
      const container = byId('file-results');
      container.replaceChildren();
      for (const file of result.files || []) {
        const target = new URL(file.url);
        if (target.origin !== LOCAL_PROCESSOR || !target.pathname.startsWith(`/files/${jobId}/`)) continue;
        const link = makeElement('a', 'download-result', `↓ ${file.name} · ${formatBytes(file.bytes)}`);
        link.href = target.href;
        link.setAttribute('download', file.name);
        container.append(link);
        if (result.files.length === 1) {
          const audio = makeElement('audio');
          audio.controls = true;
          audio.preload = 'none';
          audio.src = target.href;
          audio.setAttribute('aria-label', 'Preview cleaned audio');
          container.append(audio);
        }
      }
      container.hidden = false;
      feedback(`Export complete. ${filename} is ready as MP3. Preview it below or open the export folder.`, false, 'local-file');
      return;
    }
    localProgress = { phase: result.phase || (result.status === 'queued' ? 'Waiting for the current export…' : 'Processing audio…'), fraction: result.fraction };
    render();
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
async function processFile() {
  if (!selectedFile || isBusy() || !engineReady()) return;
  const file = selectedFile;
  const options = exportOptions();
  let api, job, accepted = false;
  localBusy = true;
  localProgress = { phase: 'Preparing your file…', fraction: 0 };
  render();
  feedback('Uploading to the processor on this computer. Keep this window open until the upload finishes.', false, 'local-file');
  try {
    api = await localAPI();
    job = await api('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...options, title: file.name.replace(/\.[^.]+$/, ''), recordingName: file.name, source: 'Local audio file' }) });
    await chrome.storage.local.set({ localFileJob: { id: job.id, filename: file.name } });
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      await api(`/jobs/${job.id}/audio`, { method: 'PUT', headers: { 'X-Chunk-Offset': String(offset) }, body: file.slice(offset, offset + 1024 * 1024) });
      localProgress = { phase: `Uploading ${Math.min(100, Math.round((offset + 1024 * 1024) / file.size * 100))}% · ${file.name}`, fraction: Math.min(1, (offset + 1024 * 1024) / file.size) };
      render();
    }
    await api(`/jobs/${job.id}/process`, { method: 'POST' });
    accepted = true;
    feedback('Noise reduction is running locally. You can close and reopen this panel for progress.', false, 'local-file');
    await monitorLocal(api, job.id, file.name);
    await chrome.storage.local.remove('localFileJob');
  } catch (error) {
    if (job && !accepted) { await api(`/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {}); await chrome.storage.local.remove('localFileJob'); }
    if (error.terminal || error.status === 404) await chrome.storage.local.remove('localFileJob');
    feedback(error.message || 'Could not clean this file. Try selecting it again.', true, 'local-file');
  } finally { localBusy = false; localProgress = undefined; render(); }
}
async function restoreLocalJob() {
  const saved = (await chrome.storage.local.get('localFileJob')).localFileJob;
  if (!saved?.id || !/^[a-f0-9-]{36}$/.test(saved.id)) return;
  localBusy = true;
  localProgress = { phase: 'Reconnecting to your audio export…' };
  byId('local-import').open = true;
  render();
  try {
    const api = await localAPI();
    const status = await api(`/jobs/${saved.id}`);
    if (status.status === 'uploading') {
      await api(`/jobs/${saved.id}`, { method: 'DELETE' });
      await chrome.storage.local.remove('localFileJob');
      throw new Error('The previous file upload was interrupted. Choose the file to try again.');
    }
    await monitorLocal(api, saved.id, saved.filename || 'Your file');
    await chrome.storage.local.remove('localFileJob');
  } catch (error) { if (error.terminal || error.status === 404) await chrome.storage.local.remove('localFileJob'); feedback(error.message || 'Could not reconnect to your audio export.', true, 'local-file'); }
  finally { localBusy = false; localProgress = undefined; render(); }
}
elements.file.addEventListener('change', () => chooseFile(elements.file.files?.[0]));
elements.fileButton.addEventListener('click', () => void processFile());
const fileDrop = byId('file-drop');
fileDrop.addEventListener('dragover', event => { event.preventDefault(); if (!isBusy()) fileDrop.classList.add('is-dragging'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('is-dragging'));
fileDrop.addEventListener('drop', event => { event.preventDefault(); fileDrop.classList.remove('is-dragging'); chooseFile(event.dataTransfer.files[0]); });
byId("open-notability").addEventListener("click", openNotability);
byId("brand-link").addEventListener("click", openNotability);
elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  elements.refresh.classList.add("is-refreshing");
  await action("REFRESH");
  await refreshState();
  elements.refresh.disabled = false;
  elements.refresh.classList.remove("is-refreshing");
});
elements.clean.addEventListener("change", () => void savePreferences());
elements.engine.addEventListener("change", () => void savePreferences());
elements.strength.addEventListener("change", () => void savePreferences());
byId('export-settings').addEventListener('toggle', () => { if (preferencesLoaded) void savePreferences(); });
elements.split.addEventListener("change", () => void savePreferences());
elements.search.addEventListener("input", renderNotes);
elements.audioOnly.addEventListener("change", () => { saveNavigation(); renderNotes(); });
elements.workspace.addEventListener("change", () => navigate(elements.workspace.value));
byId("use-originals").addEventListener("click", () => {
  elements.clean.checked = false;
  elements.split.value = "0";
  void savePreferences();
  feedback("Original recordings will download without cleanup or splitting.");
});
elements.output.addEventListener("click", () => void action("OPEN_OUTPUT"));
byId("clear-session").addEventListener("click", async () => {
  const result = await action("CLEAR_SESSION");
  if (result === null) return;
  selectedRecordings.clear();
  await refreshState();
  feedback("The locally loaded recording list has been cleared.");
});
byId("dismiss-feedback").addEventListener("click", () => feedback(""));
connection.subscribe((message) => {
  if (message?.type !== "STATE_UPDATED") return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => void refreshState(), 100);
});
void loadPreferences().then(async () => { await refreshState(); await restoreLocalJob(); }).catch(error => feedback(error.message, true));
const pollingTimer = setInterval(() => void refreshState(), 3000);
window.addEventListener("unload", () => { clearInterval(pollingTimer); clearTimeout(updateTimer); connection.dispose(); });
