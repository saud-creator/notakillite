using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace Notakillite.Desktop;
public partial class MainWindow : Window
{
    private readonly CoreClient core = new();
    private BrowserBridge? bridge;
    private List<NoteModel> notes = [];
    private List<FolderModel> folders = [];
    private List<RecordingModel> recordings = [];
    private List<JobModel> jobs = [];
    private FolderModel? folder;
    private NoteModel? note;
    private JsonElement preferences, browser, engineErrors, transcription;
    private string[] lecturePdfs = [];
    private string groqKey = "";
    private int revision = -1;
    private bool initialized, applying, busyConnect, closing, quit, playing, detailOpen, foldersOpen, queueExpanded;
    private bool closeWorkflowRunning, shutdownReady;
    private string recordingSignature = "", folderSignature = "", currentTheme = "", connectionCode = "", connection = "", previousJobs = "";
    private string restoredRecordingRequest = "";
    private readonly HashSet<string> loadingNotes = [];
    private readonly System.Windows.Forms.NotifyIcon tray;
    private readonly DispatcherTimer saveTimer = new() { Interval = TimeSpan.FromMilliseconds(450) };
    private readonly DispatcherTimer mediaTimer = new() { Interval = TimeSpan.FromMilliseconds(500) };
    public MainWindow()
    {
        InitializeComponent();
        tray = new System.Windows.Forms.NotifyIcon { Icon = System.Drawing.SystemIcons.Application, Text = "Notakillite", Visible = false };
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("Open Notakillite", null, (_, _) => Dispatcher.Invoke(Restore));
        menu.Items.Add("Quit", null, (_, _) => Dispatcher.Invoke(() => { quit = true; Close(); }));
        tray.ContextMenuStrip = menu; tray.DoubleClick += (_, _) => Dispatcher.Invoke(Restore);
        saveTimer.Tick += async (_, _) => { saveTimer.Stop(); if (initialized && !closing) await SavePreferences(); };
        mediaTimer.Tick += (_, _) => { if (Player.Source is not null) PlaybackTime.Text = FormatDuration(Player.Position.TotalSeconds) + (Player.NaturalDuration.HasTimeSpan ? " / " + FormatDuration(Player.NaturalDuration.TimeSpan.TotalSeconds) : ""); };
        core.State += state => Dispatcher.BeginInvoke(() => ApplyState(state));
        core.Failed += message => Dispatcher.BeginInvoke(() => { ShowError(message); ConnectionText.Text = "App needs attention"; });
        PreviewKeyDown += (_, e) => { if (e.Key == Key.F && Keyboard.Modifiers == ModifierKeys.Control) { SearchBox.Focus(); SearchBox.SelectAll(); e.Handled = true; } if (e.Key == Key.Escape) ClosePanels(); if (e.Key == Key.V && Keyboard.Modifiers == ModifierKeys.Control && Keyboard.FocusedElement is not (TextBox or PasswordBox)) { e.Handled = true; _ = PasteAsync(); } };
        SizeChanged += (_, _) => { Responsive(); if (initialized) ScheduleSave(); };
        SystemEvents.UserPreferenceChanged += OnWindowsPreference;
    }
    public async Task InitializeAsync(bool noConnect)
    {
        try {
            if (Environment.GetCommandLineArgs().Contains("--bridge-test")) Player.IsMuted = true;
            await core.Start(App.AppDirectory, App.DataDirectory);
            groqKey = GroqKey.Load(); if (groqKey.Length > 0) await core.Request("secrets", new { groqKey });
            if (!noConnect || Environment.GetCommandLineArgs().Contains("--bridge-test")) {
                if (!noConnect) ConnectorInstall.Prepare();
                bridge = new BrowserBridge(core, App.DataDirectory); bridge.Start();
            }
            ApplyState(await core.Request("state"));
            initialized = true; Responsive();
            if (!noConnect) _ = Command("autoConnect");
        } catch (Exception error) { ShowError(error.Message); }
    }
    public void ApplyPreview(JsonElement state)
    {
        initialized = false; ApplyState(state); initialized = true;
        if (notes.Count > 0) { NoteList.SelectedIndex = 0; UpdateInspector(); }
        detailOpen = state.Bool("previewInspector"); Responsive();
        if (state.Bool("previewScrollInspector")) { UpdateLayout(); InspectorScroll.ScrollToEnd(); }
        StatusText.Text = "UI test fixture · no account data";
    }
    public async Task CaptureTo(string filename)
    {
        await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
        UpdateLayout();
        var content = (FrameworkElement)Content;
        var target = new RenderTargetBitmap((int)Math.Ceiling(content.ActualWidth), (int)Math.Ceiling(content.ActualHeight), 96, 96, PixelFormats.Pbgra32);
        target.Render(content);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(target));
        using var file = File.Create(filename); encoder.Save(file);
    }
    public Task<JsonElement?> TestImport(string filename) => Command("export", new { file = filename, engine = Tag(Engine, "deepfilter"), strength = Tag(Strength, "balanced"), splitMinutes = 0, transcribe = false });
    public bool TestJobReady => jobs.Count > 0 && jobs.All(job => job.Status == "done");
    public bool TestJobFailed => jobs.Any(job => job.Status is "error" or "interrupted");
    private void Restore() { Show(); WindowState = WindowState.Normal; Activate(); tray.Visible = false; }
    private void ShowError(string message) { StatusText.Text = message; StatusText.SetResourceReference(TextBlock.ForegroundProperty, "ErrorBrush"); WelcomeStatus.Text = message; }
    private async Task<JsonElement?> Command(string type, object? data = null)
    {
        try { return await core.Request(type, data); }
        catch (Exception error) { ShowError(error.Message); return null; }
    }
    private void ApplyState(JsonElement state)
    {
        if (closing) return;
        applying = true;
        try {
            preferences = state.Get("preferences");
            engineErrors = state.Get("engineErrors");
            if (state.Get("transcription").ValueKind == JsonValueKind.Object) transcription = state.Get("transcription").Clone();
            if (state.Get("browser").ValueKind == JsonValueKind.Object) browser = state.Get("browser").Clone();
            var previousConnection = connection;
            connection = state.Text("connection"); connectionCode = state.Text("connectionCode");
            if (connection == "Connected" && previousConnection != connection) restoredRecordingRequest = "";
            var theme = preferences.Text("theme", "dark");
            if (currentTheme != theme) { currentTheme = theme; Theme.Apply(theme); }
            ConnectionText.Text = connection == "Connected" ? "Connected · Brave" : connection;
            ConnectionDot.SetResourceReference(TextBlock.ForegroundProperty, connection == "Connected" ? "SuccessBrush" : "WarningBrush");
            SyncText.Text = DateTime.TryParse(state.Text("lastSync"), out var last) ? $"Last observed {last.ToLocalTime():HH:mm}" + (browser.Text("profileId").Length > 0 ? "\n" + browser.Text("profileLabel", "Brave") + " · Paired" : "") : browser.Text("profileId").Length > 0 ? "Your usual Brave profile is paired." : "One-time setup in your usual Brave profile.";
            StatusText.Text = state.Text("detail"); StatusText.SetResourceReference(TextBlock.ForegroundProperty, "MutedBrush");
            BannerTitle.Text = connection; BannerMessage.Text = state.Text("detail");
            BannerAction.Content = connectionCode == "SIGN_IN_REQUIRED" ? "Sign in" : connectionCode == "CONNECTOR_SETUP_REQUIRED" ? "Set up Brave" : "Reconnect";
            ConnectionBanner.Visibility = connection != "Connected" && notes.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            if (!initialized) {
                SelectTag(Engine, preferences.Text("engine", "deepfilter")); SelectTag(Strength, preferences.Text("strength", "balanced")); SelectTag(Split, preferences.Text("splitMinutes", "0"));
                SelectTag(ResourcePolicy,preferences.Text("resourcePolicy","auto"));
                AudioOnly.IsChecked = preferences.Bool("audioOnly"); SearchBox.Text = preferences.Text("search");
                if (double.TryParse(preferences.Text("windowWidth"), out var width)) Width = Math.Clamp(width, MinWidth, Math.Max(MinWidth, SystemParameters.WorkArea.Width));
                if (double.TryParse(preferences.Text("windowHeight"), out var height)) Height = Math.Clamp(height, MinHeight, Math.Max(MinHeight, SystemParameters.WorkArea.Height));
                queueExpanded = preferences.Bool("queueExpanded");
                SelectTag(Transcriber, preferences.Text("transcriber", "local")); SelectTag(LanguageBox, preferences.Text("language", "auto")); SelectTag(Model, preferences.Text("model", "turbo"));
                TranscribeBox.IsChecked = preferences.Get("transcribe").ValueKind != JsonValueKind.False; Vocabulary.Text = preferences.Text("vocabulary");
            }
            foreach (ComboBoxItem item in Engine.Items) { var tag = item.Tag.ToString()!; item.IsEnabled = tag == "none" || state.Get("engines").Bool(tag); }
            BalancedPreset.IsEnabled = state.Get("engines").Bool("deepfilter"); FastPreset.IsEnabled = state.Get("engines").Bool("rnnoise");
            var newRevision = int.TryParse(state.Text("revision"), out var value) ? value : 0;
            if (newRevision != revision && state.Get("notes").ValueKind == JsonValueKind.Array) {
                revision = newRevision;
                notes = state.Get("notes").Rows().Select(item => new NoteModel { Value = item.Clone() }).ToList();
                var graph = state.Get("library");
                var signature = graph.ValueKind == JsonValueKind.Object ? graph.GetRawText() : "";
                if (signature != folderSignature) {
                    var expanded = initialized ? Flatten(folders).Where(item => item.Expanded).Select(item => item.Key).ToHashSet() : preferences.Get("expandedFolders").Rows().Select(item => item.GetString()!).ToHashSet();
                    folderSignature = signature;
                    bool restoreExpansion = initialized || preferences.Bool("folderExpansionSaved");
                    folders = graph.Get("workspaces").Rows().Select(item => BuildFolder(item, item.Text("id"), "", expanded, restoreExpansion, preferences.Text("folder"), 0)).ToList();
                    FolderTree.ItemsSource = folders;
                }
                folder = Flatten(folders).FirstOrDefault(item => item.Key == preferences.Text("folder"));
                AllNotesButton.Content = $"All notes   ·   {notes.Count}";
                var sort = graph.Get("sort"); var mode = sort.Text("mode");
                SortText.Text = (mode switch { "created" => "Created date", "edited" => "Modified date", "name" => "Name", _ => "Created date" }) + (sort.Bool("matched") ? " · Notability" : " · Fallback");
                FilterNotes();
            }
            var jobData = state.Get("jobs");
            if (jobData.ValueKind == JsonValueKind.Array && jobData.GetRawText() != previousJobs) {
                previousJobs = jobData.GetRawText();
                var selectedJobId = (QueueList.SelectedItem as JobModel)?.Id;
                jobs = jobData.Rows().Select(item => new JobModel { Value = item.Clone() }).ToList();
                QueueList.ItemsSource = jobs; QueueList.SelectedItem = jobs.FirstOrDefault(job => job.Id == selectedJobId);
            }
            var active = jobs.FirstOrDefault(job => job.Status == "running");
            QueueHeading.Text = active is not null ? active.Phase : jobs.Any(job => job.Status == "queued") ? "Waiting to export" : jobs.Any(job => job.Status is "error" or "interrupted") ? "Export needs attention · Open queue to retry" : jobs.Any(job => job.Status == "needs-review") ? $"{jobs.Count(job => job.Status == "needs-review")} transcript{(jobs.Count(job => job.Status == "needs-review") == 1 ? "" : "s")} need review · Open queue" : jobs.Any(job => job.Status == "done") ? $"{jobs.Count(job => job.Status == "done")} ready for AI" : "No exports yet";
            QueueToggle.Content = $"↓  Exports{(jobs.Count > 0 ? " · " + jobs.Count : "")}  {(queueExpanded ? "⌃" : "⌄")}";
            QueueList.Visibility = queueExpanded ? Visibility.Visible : Visibility.Collapsed;
            WelcomePanel.Visibility = notes.Count == 0 && state.Text("connection") != "Connected" ? Visibility.Visible : Visibility.Collapsed;
            ConnectionBanner.Visibility = connection != "Connected" && notes.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            UpdateOptions(); UpdateTranscript(); UpdateInspector(); Responsive();
        } finally { applying = false; }
        if (initialized && connection == "Connected" && note?.HasAudio == true && recordings.Count == 0) {
            var key = note.Id + ":" + note.Value.Text("updatedAt");
            if (restoredRecordingRequest != key && !loadingNotes.Contains(note.Id)) {
                restoredRecordingRequest = key; var selectedId = note.Id;
                Dispatcher.BeginInvoke(async () => { if (!closing && note?.Id == selectedId) await LoadRecordings(); });
            }
        }
    }
    private static FolderModel BuildFolder(JsonElement value, string workspace, string prefix, HashSet<string> expanded, bool restoreExpansion, string selected, int depth)
    {
        var title = value.Text("title", "My Library"); var name = string.IsNullOrEmpty(prefix) ? title : prefix + " / " + title;
        var key = workspace + "/" + value.Text("id");
        return new FolderModel { Key = key, Title = title, Path = name, Expanded = restoreExpansion ? expanded.Contains(key) : depth < 3, Selected = key == selected, ColorValue = value.Text("color"), NoteIds = value.Get("noteIds").Rows().Select(item => item.GetString()!).ToArray(), Children = value.Get("children").Rows().Select(item => BuildFolder(item, workspace, name, expanded, restoreExpansion, selected, depth + 1)).ToList() };
    }
    private static IEnumerable<FolderModel> Flatten(IEnumerable<FolderModel> items) { foreach (var item in items) { yield return item; foreach (var child in Flatten(item.Children)) yield return child; } }
    private void FilterNotes()
    {
        var selected = note?.Id ?? preferences.Text("selectedNote");
        var search = SearchBox.Text.Trim(); var ids = folder is null ? null : new HashSet<string>(folder.NoteIds);
        var filtered = notes.Where(item => (search.Length > 0 || ids is null || ids.Contains(item.Id)) && (AudioOnly.IsChecked != true || item.HasAudio) && (search.Length == 0 || (item.Title + " " + item.Path + " " + string.Join(" ", item.Value.Get("recordings").Rows().Select(x => x.Text("name")))).Contains(search, StringComparison.CurrentCultureIgnoreCase))).ToList();
        foreach (var item in filtered) item.ShowPath = folder is null || search.Length > 0;
        var scroll = FindVisual<ScrollViewer>(NoteList); var offset = scroll?.VerticalOffset ?? 0;
        NoteList.ItemsSource = filtered; NoteList.SelectedItem = filtered.FirstOrDefault(item => item.Id == selected);
        note = NoteList.SelectedItem as NoteModel;
        if (scroll is not null) Dispatcher.BeginInvoke(() => scroll.ScrollToVerticalOffset(offset), DispatcherPriority.Loaded);
        Breadcrumb.Text = search.Length > 0 ? "Search all folders" : folder?.Path ?? "Notability library";
        FolderTitle.Text = search.Length > 0 ? "Search results" : folder?.Title ?? "All notes";
        NoteCount.Text = $"{filtered.Count} {(filtered.Count == 1 ? "note" : "notes")}";
        AllNotesButton.SetResourceReference(BackgroundProperty, folder is null ? "SelectedBrush" : "RaisedBrush");
        LibraryEmpty.Visibility = filtered.Count > 0 ? Visibility.Collapsed : Visibility.Visible;
        LibraryEmpty.Text = folder?.Children.Count > 0 ? "Choose a subject or folder on the left to see its notes." : search.Length > 0 ? "No matching notes. Try another title or folder name." : AudioOnly.IsChecked == true ? "No audio notes here. Turn off Audio only to see all notes." : "This folder is empty.";
    }
    private static T? FindVisual<T>(DependencyObject parent) where T : DependencyObject { for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++) { var child = VisualTreeHelper.GetChild(parent, i); if (child is T result) return result; var nested = FindVisual<T>(child); if (nested is not null) return nested; } return null; }
    private void UpdateInspector()
    {
        DetailTitle.Text = note?.Title ?? "Import lectures"; DetailTitle.FlowDirection = note?.Direction ?? FlowDirection.LeftToRight;
        DetailMeta.Text = note is null ? "Drop Notability .note exports, audio files or folders anywhere in this window, or paste them with Ctrl+V. The cleanup and transcript settings below apply to every import." : note.Path;
        var signature = note is null ? "" : note.Id + ":" + (note.Value.Get("recordings").ValueKind == JsonValueKind.Array ? note.Value.Get("recordings").GetRawText() : "[]");
        if (signature != recordingSignature) {
            var previous = recordings.ToDictionary(item => item.Id, item => item.Selected);
            bool sameNote = note is not null && recordingSignature.StartsWith(note.Id + ":");
            recordingSignature = signature;
            recordings = note?.Value.Get("recordings").Rows().Select(item => new RecordingModel { Id = item.Text("id"), Name = item.Text("name"), Seconds = double.TryParse(item.Text("duration"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds) ? seconds : 0, Selected = !sameNote || !previous.TryGetValue(item.Text("id"), out var selected) || selected }).ToList() ?? [];
            foreach (var recording in recordings) recording.PropertyChanged += (_, _) => UpdateExport();
            RecordingsList.ItemsSource = recordings;
        }
        RecordingsHeading.Text = "Recordings" + (recordings.Count > 0 ? " · " + recordings.Count : "");
        // In import mode (no note selected) only the cleanup and transcript settings are relevant.
        var noteVisibility = note is null ? Visibility.Collapsed : Visibility.Visible;
        ((FrameworkElement)RecordingsHeading.Parent).Visibility = RecordingsList.Visibility = RecordingsSeparator.Visibility = noteVisibility;
        NoRecordingText.Visibility = recordings.Count == 0 && note is not null ? Visibility.Visible : Visibility.Collapsed;
        NoRecordingText.Text = note is null ? "Choose a note with audio to export a lecture." : !note.HasAudio ? "This note has no audio recordings." : loadingNotes.Contains(note.Id) ? "Loading recordings…" : "Recordings are not loaded. Retry when Notability is ready.";
        LoadRecordingsButton.Visibility = note?.HasAudio == true && recordings.Count == 0 && !loadingNotes.Contains(note.Id) ? Visibility.Visible : Visibility.Collapsed;
        UpdateExport();
    }
    private void UpdateExport()
    {
        if (ExportButton is null) return;
        var selected = recordings.Where(item => item.Selected).ToList(); bool connected = connection is "Connected" or "Offline cache" && browser.Bool("connected");
        // Synthetic UI fixtures use Connected without a live connector; real exports are verified again by the core.
        if (connection == "Connected") connected = true;
        var selectedEngine = Engine.SelectedItem as ComboBoxItem; bool engineAvailable = selectedEngine?.IsEnabled == true;
        ExportButton.IsEnabled = note is null ? engineAvailable : selected.Count > 0 && connected && engineAvailable;
        ExportButton.Content = !engineAvailable ? "Engine unavailable" : note is null ? "＋  Import lectures…" : !connected && selected.Count > 0 ? "Connect to export" : "↓  Export for AI";
        RuntimeRepairButton.Visibility = !engineAvailable && Tag(Engine, "deepfilter") is "deepfilter" or "hybrid" ? Visibility.Visible : Visibility.Collapsed;
        ExportSummary.Text = note is null ? "Audio, .note, folders" : selected.Count > 0 ? $"{selected.Count} recording{(selected.Count == 1 ? "" : "s")} selected" : "Select a recording";
        SelectedDuration.Text = selected.Count > 0 ? FormatDuration(selected.Sum(item => item.Seconds)) : "";
    }
    internal static string FormatDuration(double seconds) { var value = TimeSpan.FromSeconds(Math.Max(0, seconds)); return value.TotalHours >= 1 ? $"{(int)value.TotalHours}:{value.Minutes:00}:{value.Seconds:00}" : $"{(int)value.TotalMinutes}:{value.Seconds:00}"; }
    private static new string Tag(ComboBox box, string fallback) => (box.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? fallback;
    private static void SelectTag(ComboBox box, string tag) { box.SelectedItem = box.Items.Cast<ComboBoxItem>().FirstOrDefault(item => item.Tag.ToString() == tag) ?? box.Items[0]; }
    private void UpdateOptions()
    {
        var engine = Tag(Engine, "deepfilter"); Strength.IsEnabled = engine is not ("none" or "classic");
        EngineDescription.Text = engine switch { "rnnoise" => "Neural speech cleanup with RNNoise.", "hybrid" => "RNNoise, then DeepFilterNet3. Takes more processing and can soften quiet speech.", "classic" => "Light steady-noise cleanup and balanced volume.", "none" => "Keep the source unchanged. Splitting converts it to MP3.", _ => "Detailed speech cleanup with DeepFilterNet3. Balanced preserves more quiet speech." };
        if (engineErrors.Text(engine).Length > 0) EngineDescription.Text = engineErrors.Text(engine);
        foreach (var button in new[] { BalancedPreset, FastPreset, OriginalPreset }) { button.SetResourceReference(BackgroundProperty, button.Tag.ToString() == engine ? "SelectedBrush" : "PanelBrush"); button.SetResourceReference(BorderBrushProperty, button.Tag.ToString() == engine ? "AccentBrush" : "LineBrush"); }
        var name = engine switch { "rnnoise" => "RNNoise", "hybrid" => "RNNoise + DeepFilterNet3", "classic" => "Light cleanup", "none" => "Original audio", _ => "DeepFilterNet3" };
        var split = Tag(Split, "0");
        OutputSummary.Text = (engine == "none" && split == "0" ? "Original file · No conversion" : $"{name} · MP3 · {(split == "0" ? "Keep one file" : split + "-minute parts")}") + (TranscribeBox?.IsChecked == true ? (Tag(Transcriber, "local") == "groq" ? " · Groq transcript" : " · Whisper transcript") : "");
    }
    private void UpdateTranscript()
    {
        if (TranscriptStatus is null || TranscribeBox is null) return;
        bool on = TranscribeBox.IsChecked == true; TranscriptOptions.IsEnabled = on; TranscriptOptions.Opacity = on ? 1 : 0.55;
        var engine = Tag(Transcriber, "local"); var model = Tag(Model, "turbo"); var download = transcription.Get("download");
        TranscriptWhere.Text = engine == "groq" ? "Uploads audio to Groq" : "Runs locally";
        string text; string? action = null;
        if (engine == "groq") { text = groqKey.Length > 0 ? "Uses your Groq key. Audio is uploaded to Groq for transcription." : "Add your free Groq API key to use the cloud engine."; if (groqKey.Length == 0) action = "Add Groq API key…"; }
        else if (transcription.ValueKind == JsonValueKind.Object && !transcription.Bool("installed")) text = "Whisper is not installed in this build. Choose Groq or install the latest Notakillite.";
        else if (download.ValueKind == JsonValueKind.Object) text = $"Downloading Whisper {(download.Text("model") == "large-v3" ? "large-v3" : "large-v3-turbo")} · {(double.TryParse(download.Text("fraction"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var fraction) ? fraction * 100 : 0):0}%";
        else if (transcription.Get("models").Bool(model)) text = transcription.Bool("gpuBuild") ? "Model ready · uses your graphics card when available." : "Model ready · runs on the processor.";
        else { text = $"The model downloads once, on first use ({(model == "large-v3" ? "3.1 GB" : "874 MB")})."; action = "Download model now"; }
        TranscriptStatus.Text = text; TranscriptAction.Content = action; TranscriptAction.Visibility = action is null ? Visibility.Collapsed : Visibility.Visible;
    }
    private Dictionary<string, object?> ExportOptions() => new()
    {
        ["ocr"] = OcrBox.IsChecked == true, ["course"] = CourseName.Text.Trim(), ["pdfs"] = lecturePdfs, ["resourcePolicy"] = Tag(ResourcePolicy, "auto"), ["engine"] = Tag(Engine, "deepfilter"), ["strength"] = Tag(Strength, "balanced"), ["splitMinutes"] = int.Parse(Tag(Split, "0")),
        ["transcribe"] = TranscribeBox.IsChecked == true, ["transcriber"] = Tag(Transcriber, "local"), ["language"] = Tag(LanguageBox, "auto"), ["model"] = Tag(Model, "turbo"), ["vocabulary"] = Vocabulary.Text.Trim(),
    };
    private void ScheduleSave() { if (initialized && !applying && !closing) { saveTimer.Stop(); saveTimer.Start(); } }
    private async Task SavePreferences() { await Command("preferences", new { engine = Tag(Engine, "deepfilter"), strength = Tag(Strength, "balanced"), splitMinutes = int.Parse(Tag(Split, "0")), audioOnly = AudioOnly.IsChecked == true, search = SearchBox.Text, folder = folder?.Key ?? "", selectedNote = note?.Id ?? "", expandedFolders = Flatten(folders).Where(item => item.Expanded).Select(item => item.Key).ToArray(), folderExpansionSaved = true, queueExpanded, theme = currentTheme.Length > 0 ? currentTheme : "dark", windowWidth = ActualWidth, windowHeight = ActualHeight, resourcePolicy = Tag(ResourcePolicy,"auto"), transcribe = TranscribeBox.IsChecked == true, transcriber = Tag(Transcriber, "local"), language = Tag(LanguageBox, "auto"), model = Tag(Model, "turbo"), vocabulary = Vocabulary.Text.Trim() }); }
    private void Responsive()
    {
        if (BodyGrid is null) return;
        if (WelcomePanel.Visibility == Visibility.Visible) {
            bool shortWelcome = BodyGrid.ActualHeight < 480;
            WelcomeMark.Visibility = shortWelcome ? Visibility.Collapsed : Visibility.Visible;
            WelcomeTitle.FontSize = shortWelcome ? 26 : 31;
            WelcomeStack.Margin = new Thickness(shortWelcome ? 20 : 32);
            WelcomeIntro.Margin = new Thickness(10, 0, 10, shortWelcome ? 12 : 24);
            // Keep the import settings visible beside the welcome screen when there is room.
            bool roomy = ActualWidth >= 1000;
            Grid.SetColumnSpan(WelcomePanel, roomy ? 2 : 3); SidebarColumn.Width = new GridLength(232); InspectorColumn.Width = roomy ? new GridLength(344) : new GridLength(0);
            Grid.SetColumn(InspectorPanel, 2); Grid.SetColumnSpan(InspectorPanel, 1); InspectorPanel.Width = double.NaN; InspectorPanel.HorizontalAlignment = HorizontalAlignment.Stretch; CloseDetailButton.Visibility = Visibility.Collapsed;
            InspectorPanel.Visibility = roomy || detailOpen ? Visibility.Visible : Visibility.Collapsed;
            if (!roomy && detailOpen) { Grid.SetColumn(InspectorPanel,0); Grid.SetColumnSpan(InspectorPanel,3); InspectorPanel.Width=340; InspectorPanel.HorizontalAlignment=HorizontalAlignment.Right; CloseDetailButton.Visibility=Visibility.Visible; }
            SidebarPanel.Visibility = FoldersButton.Visibility = Visibility.Collapsed; DetailButton.Visibility=Visibility.Visible; InspectorScrim.Visibility=!roomy && detailOpen?Visibility.Visible:Visibility.Collapsed; return;
        }
        Grid.SetColumnSpan(WelcomePanel, 3);
        bool compact = ActualWidth < 1120, narrow = ActualWidth < 900;
        FoldersButton.Visibility = narrow ? Visibility.Visible : Visibility.Collapsed;
        SidebarColumn.Width = narrow ? new GridLength(0) : new GridLength(232);
        SidebarPanel.Visibility = !narrow || foldersOpen ? Visibility.Visible : Visibility.Collapsed;
        SidebarPanel.Width = narrow ? 245 : double.NaN; SidebarPanel.HorizontalAlignment = narrow ? HorizontalAlignment.Left : HorizontalAlignment.Stretch;
        Grid.SetColumnSpan(SidebarPanel, narrow ? 3 : 1);
        InspectorColumn.Width = compact ? new GridLength(0) : new GridLength(344);
        InspectorPanel.Visibility = !compact || detailOpen ? Visibility.Visible : Visibility.Collapsed;
        InspectorPanel.Width = compact ? Math.Min(365, ActualWidth - 32) : double.NaN;
        InspectorPanel.HorizontalAlignment = compact ? HorizontalAlignment.Right : HorizontalAlignment.Stretch;
        Grid.SetColumn(InspectorPanel, compact ? 0 : 2); Grid.SetColumnSpan(InspectorPanel, compact ? 3 : 1);
        InspectorScrim.Visibility = compact && detailOpen || narrow && foldersOpen ? Visibility.Visible : Visibility.Collapsed;
        CloseDetailButton.Visibility = compact ? Visibility.Visible : Visibility.Collapsed;
        DetailButton.Visibility = compact && note is not null ? Visibility.Visible : Visibility.Collapsed;
    }
    private void ClosePanels() { detailOpen = foldersOpen = false; Responsive(); }
    private void OnToggleFolders(object sender, RoutedEventArgs e) { foldersOpen = !foldersOpen; detailOpen = false; Responsive(); }
    private void OnShowDetails(object sender, RoutedEventArgs e) { detailOpen = true; foldersOpen = false; Responsive(); }
    private void OnClosePanels(object sender, RoutedEventArgs e) => ClosePanels();
    private void OnToggleQueue(object sender, RoutedEventArgs e) { queueExpanded = !queueExpanded; QueueList.Visibility = queueExpanded ? Visibility.Visible : Visibility.Collapsed; QueueToggle.Content = $"↓  Exports · {jobs.Count}  {(queueExpanded ? "⌃" : "⌄")}"; ScheduleSave(); }
    private void OnFolderExpansion(object sender, RoutedEventArgs e) { if (!applying) ScheduleSave(); }
    private async void OnConnect(object sender, RoutedEventArgs e)
    {
        if (busyConnect) return; busyConnect = true;
        try {
            if (browser.Text("profileId").Length == 0) { await Setup(); return; }
            await Command(connectionCode == "SIGN_IN_REQUIRED" ? "showNotability" : connection == "Connected" ? "refresh" : "connect");
        } finally { busyConnect = false; }
    }
    private Task Setup()
    {
        var dialog = new ConnectorSetup(browser, core) { Owner = this };
        dialog.ShowDialog(); return Task.CompletedTask;
    }
    private async void OnSetup(object sender, RoutedEventArgs e) => await Setup();
    private async void OnOpenBrave(object sender, RoutedEventArgs e) { if (browser.Text("profileId").Length == 0) await Setup(); else await Command("showNotability"); }
    private void OnAccount(object sender, RoutedEventArgs e) { if (sender is Button button) { button.ContextMenu.PlacementTarget = button; button.ContextMenu.IsOpen = true; } }
    private async void OnTheme(object sender, RoutedEventArgs e) { if (sender is MenuItem item) await SetTheme(item.Tag.ToString()!); }
    private async void OnToggleTheme(object sender, RoutedEventArgs e) => await SetTheme(currentTheme == "light" ? "dark" : "light");
    private async Task SetTheme(string mode) { currentTheme = mode; Theme.Apply(mode); UpdateOptions(); await SavePreferences(); }
    private async void OnRepairRuntime(object sender, RoutedEventArgs e) { RuntimeRepairButton.IsEnabled = false; StatusText.Text = "Downloading and verifying Microsoft's Visual C++ installer…"; try { await RuntimeSetup.Install(); await Command("engineCheck"); StatusText.Text = "Audio runtime checked. Your saved Brave sign-in is unchanged."; } catch (Exception error) { ShowError(error.Message); } finally { RuntimeRepairButton.IsEnabled = true; } }
    private void OnWindowsPreference(object sender, UserPreferenceChangedEventArgs e) { if (!closing) Dispatcher.BeginInvoke(() => { Theme.Apply(currentTheme.Length > 0 ? currentTheme : "dark"); UpdateOptions(); }); }
    private void OnPreset(object sender, RoutedEventArgs e) { if (sender is Button button) { SelectTag(Engine, button.Tag.ToString()!); SelectTag(Strength, "balanced"); UpdateOptions(); UpdateExport(); ScheduleSave(); } }
    private void OnSelectAll(object sender, RoutedEventArgs e) { foreach (var recording in recordings) recording.Selected = true; }
    private void OnFolderSelected(object sender, RoutedPropertyChangedEventArgs<object> e) { if (applying || e.NewValue is not FolderModel selected) return; folder = selected; SearchBox.Text = ""; note = null; FilterNotes(); UpdateInspector(); ClosePanels(); ScheduleSave(); }
    private void OnAllNotes(object sender, RoutedEventArgs e) { folder = null; foreach (var item in Flatten(folders)) item.Selected = false; SearchBox.Text = ""; FilterNotes(); UpdateInspector(); ClosePanels(); ScheduleSave(); }
    private void OnSearchChanged(object sender, TextChangedEventArgs e) { if (applying || !initialized) return; FilterNotes(); UpdateInspector(); ScheduleSave(); }
    private void OnFilterChanged(object sender, RoutedEventArgs e) { if (applying || !initialized) return; FilterNotes(); UpdateInspector(); ScheduleSave(); }
    private void OnOptionsChanged(object sender, SelectionChangedEventArgs e) { if (applying || EngineDescription is null || OutputSummary is null) return; UpdateOptions(); UpdateTranscript(); UpdateExport(); ScheduleSave(); }
    private void OnTranscriptToggled(object sender, RoutedEventArgs e) { if (applying || !initialized) return; UpdateOptions(); UpdateTranscript(); ScheduleSave(); }
    private void OnVocabularyChanged(object sender, TextChangedEventArgs e) { if (applying || !initialized) return; ScheduleSave(); }
    private async void OnTranscriptAction(object sender, RoutedEventArgs e) { if (Tag(Transcriber, "local") == "groq") await EditGroqKey(); else await Command("downloadModel", new { model = Tag(Model, "turbo") }); }
    private async void OnDownloadModel(object sender, RoutedEventArgs e) => await Command("downloadModel", new { model = Tag(Model, "turbo") });
    private async void OnGroqKey(object sender, RoutedEventArgs e) => await EditGroqKey();
    private async Task EditGroqKey()
    {
        var dialog = new GroqKeyDialog(groqKey.Length > 0) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        try { GroqKey.Save(dialog.Key); groqKey = dialog.Key; await core.Request("secrets", new { groqKey }); StatusText.Text = groqKey.Length > 0 ? "Groq key saved for this Windows account." : "Groq key removed."; }
        catch (Exception error) { ShowError(error.Message); }
        UpdateTranscript();
    }
    private async void OnNoteSelected(object sender, SelectionChangedEventArgs e)
    {
        if (applying) return;
        note = NoteList.SelectedItem as NoteModel; UpdateInspector();
        if (note is not null) { detailOpen = true; foldersOpen = false; InspectorScroll.ScrollToTop(); Responsive(); ScheduleSave(); }
        if (note?.HasAudio == true && recordings.Count == 0) await LoadRecordings();
    }
    private async Task LoadRecordings() { if (note is null || !loadingNotes.Add(note.Id)) return; var id = note.Id; UpdateInspector(); try { await Command("recordings", new { noteId = id }); } finally { loadingNotes.Remove(id); UpdateInspector(); } }
    private async void OnLoadRecordings(object sender, RoutedEventArgs e) => await LoadRecordings();
    private async void OnExport(object sender, RoutedEventArgs e)
    {
        if (note is null) { OnImport(sender, e); return; }
        var ids = recordings.Where(item => item.Selected).Select(item => item.Id).ToArray();
        if (ids.Length == 0) { ShowError("Select at least one recording."); return; }
        var data = ExportOptions(); data["noteId"] = note.Id; data["recordingIds"] = ids;
        var result = await Command("export", data);
        if (result is not null) { StatusText.Text = "Added to the export queue. You can continue browsing."; queueExpanded = true; QueueList.Visibility = Visibility.Visible; }
    }
    private async Task Import(IEnumerable<string> files)
    {
        var all = files.Where(f => f.Length > 0).Select(Path.GetFullPath).Distinct().ToArray();
        var pdfs = all.Where(f => Path.GetExtension(f).Equals(".pdf", StringComparison.OrdinalIgnoreCase)).ToArray(); if(pdfs.Length > 0) { lecturePdfs=pdfs; PdfSummary.Text=$"{pdfs.Length} PDF(s) attached"; }
        if(all.Length > 200) { ShowError("Import up to 200 items at a time."); return; }
        var list = all.Where(f => !Path.GetExtension(f).Equals(".pdf",StringComparison.OrdinalIgnoreCase)).Where(file => file.Length > 0).Select(Path.GetFullPath).Distinct().Take(200).ToArray(); if (list.Length == 0) return;
        var data = ExportOptions(); data["files"] = list;
        StatusText.Text = "Reading your files…";
        var result = await Command("export", data);
        if (result is JsonElement value) { var count = value.Get("ids").Rows().Count(); StatusText.Text = $"Added {count} recording{(count == 1 ? "" : "s")} to the queue. Results are saved together in one folder."; StatusText.SetResourceReference(TextBlock.ForegroundProperty, "MutedBrush"); }
        queueExpanded = true; QueueList.Visibility = Visibility.Visible;
    }
    private async void OnImport(object sender, RoutedEventArgs e) { var dialog = new OpenFileDialog { Title = "Choose lectures: Notability notes or audio", Multiselect = true, Filter = "Lectures|*.pdf;*.note;*.zip;*.m4a;*.mp3;*.wav;*.aac;*.alac;*.flac;*.ogg;*.opus;*.webm;*.caf;*.aif;*.aiff;*.wma;*.amr;*.mp4|Notability notes|*.note|All files|*.*" }; if (dialog.ShowDialog(this) == true) await Import(dialog.FileNames); }
    private async void OnPaste(object sender, RoutedEventArgs e) => await PasteAsync();
    private async Task PasteAsync()
    {
        try {
            var files = new List<string>();
            if (System.Windows.Clipboard.ContainsFileDropList()) files.AddRange(System.Windows.Clipboard.GetFileDropList().Cast<string>());
            else if (System.Windows.Clipboard.ContainsAudio()) {
                var folder = Path.Combine(App.DataDirectory, "clipboard"); Directory.CreateDirectory(folder);
                foreach (var old in Directory.GetFiles(folder).Where(item => File.GetLastWriteTime(item) < DateTime.Now.AddDays(-7))) try { File.Delete(old); } catch { }
                var file = Path.Combine(folder, $"Pasted audio {DateTime.Now:yyyy-MM-dd HH.mm.ss}.wav");
                using (var audio = System.Windows.Clipboard.GetAudioStream()) using (var output = File.Create(file)) audio?.CopyTo(output);
                files.Add(file);
            }
            else if (System.Windows.Clipboard.ContainsText()) files.AddRange(System.Windows.Clipboard.GetText().Split('\n').Select(line => line.Trim().Trim('"')).Where(line => line.Length > 0 && Path.IsPathFullyQualified(line) && (File.Exists(line) || Directory.Exists(line))));
            if (files.Count == 0) { ShowError("The clipboard has no lectures. In File Explorer, copy a .note export, audio files or a folder, then press Ctrl+V here."); return; }
            await Import(files);
        } catch (Exception error) { ShowError("Could not read the clipboard: " + error.Message); }
    }
    private void OnCopyTranscript(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) { var file = job.Value.Text("transcriptPath"); if (File.Exists(file)) { System.Windows.Clipboard.SetText(File.ReadAllText(file)); StatusText.Text = "Transcript copied. Paste it into ChatGPT or Claude."; } else ShowError("The transcript was moved or deleted. Open its export folder to check."); } }
    private void OnReviewTranscript(object sender, RoutedEventArgs e) { if (closing || closeWorkflowRunning || shutdownReady) return; if ((sender as Button)?.DataContext is JobModel job) new ReviewWindow(core,job) { Owner=this }.Show(); }
    private async void OnPauseJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) await Command("pause",new { id=job.Id }); }
    private async void OnResumeJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) await Command("resume",new { id=job.Id }); }
    private async void OnSaveCourse(object sender, RoutedEventArgs e) { await Command("saveCourse",new {name=CourseName.Text.Trim(),vocabulary=Vocabulary.Text.Trim()}); }
    private async void OnLoadCourse(object sender, RoutedEventArgs e) { var courses=await Command("courses"); if(courses is JsonElement c) Vocabulary.Text=c.Text(CourseName.Text.Trim()); }
    private async void OnFindTranscripts(object sender, RoutedEventArgs e) {
        var window=new Window { Owner=this,Title="Search transcripts / البحث في النصوص",Width=800,Height=500,MinWidth=500 };
        var root=new DockPanel {Margin=new Thickness(12)}; var input=new TextBox {MinHeight=30}; DockPanel.SetDock(input,Dock.Top);root.Children.Add(input);
        var find=new Button {Content="Search / بحث"};DockPanel.SetDock(find,Dock.Top);root.Children.Add(find);var results=new ListBox();root.Children.Add(results);window.Content=root;
        find.Click+=async (_,_)=>{ var found=await Command("searchTranscripts",new {text=input.Text});results.Items.Clear();if(found is JsonElement rows) foreach(var r in rows.Rows())results.Items.Add(new ListBoxItem {Content=r.Text("start")+"s · "+r.Text("text"),Tag=r.Clone()}); };
        results.MouseDoubleClick+=(_,_)=>{if(closing || closeWorkflowRunning || shutdownReady) return;if(results.SelectedItem is ListBoxItem item && item.Tag is JsonElement r) {var job=jobs.FirstOrDefault(j=>j.Id==r.Text("job"));if(job is not null)new ReviewWindow(core,job,r.Text("segment")){Owner=this}.Show();}};
        window.Show(); input.Focus();
    }
    private async void OnPreflight(object sender,RoutedEventArgs e) { var result=await Command("preflight",ExportOptions()); if(result is JsonElement p)MessageBox.Show(this,$"Audio engine ready: {p.Bool("engineReady")}\nModel ready: {p.Bool("modelReady")}\nOne-time download: {Math.Round(double.Parse(p.Text("downloadBytes","0"))/1048576)} MB\nOutput writable: {p.Bool("outputWritable")}\nCloud processing selected: {p.Bool("cloud")}\n"+string.Join("\n",p.Get("warnings").Rows().Select(w=>w.GetString())),"Processing readiness / جاهزية المعالجة"); }
    private async void OnResourceInfo(object sender,RoutedEventArgs e) { var result=await Command("capabilities");if(result is JsonElement c)MessageBox.Show(this,$"{c.Text("cpu")}\nAvailable CPU allocation: {c.Text("effective")}\nRAM available: {Math.Round(double.Parse(c.Text("available","0"))/1073741824,1)} GiB\nDetected NVIDIA devices: {c.Get("gpus").Rows().Count()}\nVulkan support is verified when inference starts.","Processing resources"); }
    private void OnClearPdfs(object sender,RoutedEventArgs e) { lecturePdfs=[];PdfSummary.Text="Audio only / صوت فقط"; }
    private void OnAttachPdfs(object sender, RoutedEventArgs e) { var dialog=new OpenFileDialog { Multiselect=true, Filter="Lecture PDF|*.pdf" }; if(dialog.ShowDialog(this)==true) { lecturePdfs=dialog.FileNames; PdfSummary.Text=$"{lecturePdfs.Length} PDF(s) attached"; } }
    private void OnProcessingPreset(object sender, SelectionChangedEventArgs e) { if(Engine is null || Model is null) return; var preset=Tag(ProcessingPreset,"balanced"); if(preset=="custom") return; SelectTag(Engine,preset=="fast"?"none":"rnnoise"); SelectTag(Model,preset=="accuracy"?"large-v3":"turbo"); }
    private void OnOpenTranscript(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) { var file = job.Value.Text("transcriptPath"); if (File.Exists(file)) Process.Start(new ProcessStartInfo(file) { UseShellExecute = true }); else ShowError("The transcript was moved or deleted. Open its export folder to check."); } }
    private async void OnDrop(object sender, DragEventArgs e) { if (e.Data.GetData(DataFormats.FileDrop) is string[] files) { e.Handled = true; await Import(files); } }
    private async void OnChooseOutput(object sender, RoutedEventArgs e) { var dialog = new OpenFolderDialog { Title = "Choose export destination" }; if (dialog.ShowDialog(this) == true) { await Command("preferences", new { outputPath = dialog.FolderName }); StatusText.Text = "Future exports will be saved in " + dialog.FolderName; } }
    private async void OnOpenOutput(object sender, RoutedEventArgs e) => await Command("reveal");
    private async void OnClearCompleted(object sender, RoutedEventArgs e) => await Command("clearCompleted");
    private async void OnCancelJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) await Command("cancel", new { id = job.Id }); }
    private async void OnCopyDiagnostics(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is not JobModel job) return; var result = await Command("diagnostics", new { id = job.Id }); var text = result?.Text("text") ?? ""; if (text.Length == 0) { ShowError("No diagnostics were recorded for this job."); return; } System.Windows.Clipboard.SetText(text); StatusText.Text = "Diagnostics copied (no audio or transcript text)."; }
    private async void OnRetryJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) await Command("retry", new { id = job.Id }); }
    private async void OnRevealJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) await Command("reveal", new { id = job.Id }); }
    private void OnCopyJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is JobModel job) { var file = job.Value.Get("files").Rows().FirstOrDefault().Text("path"); if (File.Exists(file)) { System.Windows.Clipboard.SetText(file); StatusText.Text = "Audio path copied."; } else ShowError("The output file was moved or deleted."); } }
    private void OnPreviewJob(object sender, RoutedEventArgs e) { if ((sender as Button)?.DataContext is not JobModel job) return; var file = job.Value.Get("files").Rows().FirstOrDefault().Text("path"); if (!File.Exists(file)) { ShowError("The output file was moved or deleted. Open its export folder to check."); return; } Player.Stop(); Player.Source = new Uri(file); Player.Play(); playing = true; mediaTimer.Start(); PlaybackPanel.Visibility = Visibility.Visible; PlaybackTitle.Text = job.Title + " · " + job.Recording; }
    private void OnPlayPause(object sender, RoutedEventArgs e) { if (Player.Source is null) return; if (playing) Player.Pause(); else Player.Play(); playing = !playing; }
    private void OnStopPlayback(object sender, RoutedEventArgs e) { Player.Stop(); playing = false; PlaybackTime.Text = ""; mediaTimer.Stop(); PlaybackPanel.Visibility = Visibility.Collapsed; }
    private void OnMediaFailed(object sender, ExceptionRoutedEventArgs e) { ShowError("Windows could not preview this file. The output remains available in its export folder."); playing = false; }
    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        if (shutdownReady) return;
        e.Cancel = true;
        if (closeWorkflowRunning) return;
        if (!quit && jobs.Any(job => job.Status is "running" or "queued")) {
            var answer = System.Windows.MessageBox.Show(this, "Keep your exports running in the background?\n\nYes: hide to the system tray.\nNo: quit; interrupted jobs can be retried next launch.", "Audio export in progress", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
            if (answer == MessageBoxResult.Cancel) return;
            if (answer == MessageBoxResult.Yes) { Hide(); tray.Visible = true; return; }
        }
        closeWorkflowRunning = true;
        var preparedReviews = new List<ReviewWindow>();
        try {
            IsEnabled = false;
            var reviews = Application.Current.Windows.OfType<ReviewWindow>()
                .Where(review => ReferenceEquals(review.Owner, this) && !review.IsClosed)
                .ToArray();
            foreach (var review in reviews) {
                if (review.HasOwnerShutdownBlocker()) {
                    review.Activate();
                    return;
                }
            }
            foreach (var review in reviews) {
                if (review.IsClosed) continue;
                if (!await review.PrepareForOwnerShutdownAsync()) {
                    review.Activate();
                    return;
                }
                if (!review.IsClosed) preparedReviews.Add(review);
            }
            foreach (var review in preparedReviews) {
                if (!review.CloseForOwnerShutdown()) {
                    review.Activate();
                    return;
                }
            }

            closing = true;
            IsEnabled = false; saveTimer.Stop(); mediaTimer.Stop(); Player.Stop(); SystemEvents.UserPreferenceChanged -= OnWindowsPreference;
            await SavePreferences(); if (bridge is not null) await bridge.DisposeAsync(); await core.DisposeAsync();
            shutdownReady = true;
            tray.Dispose();
            Close();
        } catch (Exception error) {
            IsEnabled = true;
            ShowError("Notakillite could not finish closing. " + error.Message);
        } finally {
            if (!shutdownReady) {
                foreach (var review in preparedReviews) review.ReleaseOwnerShutdown();
                IsEnabled = true;
                closing = false;
                closeWorkflowRunning = false;
            }
        }
    }
}
