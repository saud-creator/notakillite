using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
namespace Notakillite.Desktop;
public sealed class ReviewWindow : Window
{
    private readonly CoreClient core; private readonly JobModel job;
    private JsonElement document;
    private readonly ListBox segments = new() { DisplayMemberPath = "Label" };
    private readonly TextBox editor = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MinHeight = 100 };
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Canvas waveform=new() {Height=60,ClipToBounds=true};
    private readonly Slider timeline=new() {Minimum=0};
    private readonly TextBlock clock=new();
    private readonly DispatcherTimer playbackTimer=new() {Interval=TimeSpan.FromMilliseconds(250)};
    private bool updatingTimeline; private int audioGeneration; private double audioOffset;
    private readonly MediaElement player = new() { LoadedBehavior = MediaState.Manual, Height = 0 };
    private readonly ComboBox format = new() { ItemsSource = new[] { "txt", "md", "srt", "vtt", "json" }, SelectedIndex = 0, Width = 75 };
    private readonly ComboBox source = new() { DisplayMemberPath = "Name", Width = 200 };
    private readonly ComboBox pdfPages = new() { DisplayMemberPath = "Name", Width = 230 };
    private readonly Image pdf = new() { Stretch = Stretch.Uniform };
    private readonly TextBlock pdfText = new() { TextWrapping = TextWrapping.Wrap };
    private bool dirty, loading, candidate, retryPending;
    private readonly SemaphoreSlim saveGate = new(1,1);
    private Row? current; private readonly string? initialSegment;
    private readonly DispatcherTimer autosave = new() { Interval = TimeSpan.FromSeconds(2) };
    private sealed record Row(string Id, string Label, double Start, double End, string Text);
    private sealed record AudioSource(string Name, string Path, double Offset=0);
    private sealed record PdfPage(string Name, string File, int Page);
    public ReviewWindow(CoreClient client, JobModel model, string? segmentId=null)
    {
        core = client; job = model; initialSegment=segmentId; Title = "Review lecture / مراجعة المحاضرة — " + job.Title; Width = 1100; Height = 760; MinWidth = 680; MinHeight = 480;
        SetResourceReference(BackgroundProperty, "BackgroundBrush"); SetResourceReference(ForegroundProperty, "TextBrush");
        AutomationProperties.SetName(source, "Audio source / مصدر الصوت");
        AutomationProperties.SetName(format, "Export format / صيغة التصدير");
        AutomationProperties.SetName(pdfPages, "PDF page / صفحة PDF");
        AutomationProperties.SetName(timeline, "Audio timeline / المخطط الزمني للصوت");
        AutomationProperties.SetName(editor, "Transcript editor / محرر النص");
        AutomationProperties.SetName(segments, "Transcript segments / مقاطع النص");
        var root = new DockPanel { Margin = new Thickness(14) }; Content = root;
        var tools = new WrapPanel(); DockPanel.SetDock(tools, Dock.Top); root.Children.Add(tools);
        void Button(string label, RoutedEventHandler action) { var b = new Button { Content = label, Margin = new Thickness(3), Padding = new Thickness(8,5,8,5) }; b.Click += action; tools.Children.Add(b); }
        Button("Play / تشغيل", (_,_) => player.Play()); Button("Pause / إيقاف", (_,_) => player.Pause());
        Button("−10s", (_,_) => player.Position = TimeSpan.FromSeconds(Math.Max(0,player.Position.TotalSeconds-10))); Button("+10s", (_,_) => player.Position += TimeSpan.FromSeconds(10));
        var speed = new ComboBox { ItemsSource = new double[] { .75, 1, 1.25, 1.5, 2 }, SelectedIndex = 1, Width = 65 }; AutomationProperties.SetName(speed, "Playback speed / سرعة التشغيل"); speed.SelectionChanged += (_,_) => player.SpeedRatio = (double)speed.SelectedItem; tools.Children.Add(speed);
        tools.Children.Add(source); source.SelectionChanged += async (_,_) => { if(source.SelectedItem is AudioSource audio) { var position=player.Position.TotalSeconds+audioOffset; audioOffset=audio.Offset; player.Source=new Uri(audio.Path); player.Position=TimeSpan.FromSeconds(Math.Max(0,position-audioOffset)); var generation=++audioGeneration; try { var data=await core.Request("waveform",new {id=job.Id,fileName=Path.GetFileName(audio.Path),source=audio.Name.StartsWith("Original")?"original":"cleaned"}); if(generation==audioGeneration) DrawWaveform(data); } catch(Exception e) {status.Text=e.Message;} } };
        Button("History / السجل", (_,_) => ShowHistory()); Button("Save / حفظ", async (_,_) => { candidate=false; await Save(); }); Button("PDF terms / مصطلحات PDF", (_,_) => MessageBox.Show(this,string.Join(", ",document.Get("metadata").Get("suggestedTerms").Rows().Select(t=>t.Text("term"))),"Suggested vocabulary — review required")); Button("Discard candidate", (_,_) => { candidate=false; dirty=false; loading=true; editor.Text=current?.Text ?? ""; loading=false; }); Button("Retry passage / إعادة المقطع", async (_,_) => await Retry());
        tools.Children.Add(format); Button("Export / تصدير", async (_,_) => { try { if(candidate) { status.Text="Save or discard the candidate before export."; return; } await Save(); if(dirty) return; var result=await core.Request("exportTranscript",new { id=job.Id,format=format.SelectedItem?.ToString() }); status.Text=result.Text("path"); } catch(Exception e) { status.Text=e.Message; } });
        var bottom = new StackPanel(); DockPanel.SetDock(bottom,Dock.Bottom); root.Children.Add(bottom); bottom.Children.Add(waveform); bottom.Children.Add(timeline); bottom.Children.Add(clock); bottom.Children.Add(status); bottom.Children.Add(player);
        timeline.Maximum=Math.Max(1,double.TryParse(job.Value.Get("transcript").Text("seconds"),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var duration)?duration:60);
        timeline.ValueChanged+=(_,_)=>{if(!updatingTimeline)Seek(timeline.Value);};
        playbackTimer.Tick+=(_,_)=>{updatingTimeline=true;timeline.Value=Math.Min(timeline.Maximum,player.Position.TotalSeconds+audioOffset);clock.Text=TimeSpan.FromSeconds(player.Position.TotalSeconds+audioOffset).ToString(@"hh\:mm\:ss");updatingTimeline=false;};playbackTimer.Start();
        bottom.Children.Add(new TextBlock { Text = "Edits autosave. Ctrl+Z / Ctrl+Y undo or redo. Retry proposals require review before saving. / تُحفظ التعديلات تلقائيًا.", TextWrapping=TextWrapping.Wrap });
        bottom.Children.Add(editor); editor.TextChanged += (_,_) => { if(!loading && current is not null) { dirty=true; autosave.Stop(); if(!candidate) autosave.Start(); } };
        var grid=new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition()); root.Children.Add(grid);
        grid.Children.Add(segments); var slidePanel=new DockPanel { Margin=new Thickness(10,0,0,0) }; Grid.SetColumn(slidePanel,1); grid.Children.Add(slidePanel);
        DockPanel.SetDock(pdfPages,Dock.Top); slidePanel.Children.Add(pdfPages); var scroll=new ScrollViewer { VerticalScrollBarVisibility=ScrollBarVisibility.Auto }; var slideContent=new StackPanel(); slideContent.Children.Add(pdf); slideContent.Children.Add(pdfText); scroll.Content=slideContent; slidePanel.Children.Add(scroll);
        pdfPages.SelectionChanged += async (_,_) => { if(pdfPages.SelectedItem is PdfPage page) try { var rendered=await core.Request("pdfPreview",new { id=job.Id,file=page.File,page=page.Page }); pdf.Source=new BitmapImage(new Uri(rendered.Text("path"))); pdfText.Text=rendered.Text("text"); } catch(Exception e) { status.Text=e.Message; } };
        segments.SelectionChanged += async (_,_) => { if(loading) return; if(retryPending) return; if(candidate) { status.Text="Save or discard the retry candidate before selecting another passage."; loading=true; segments.SelectedItem=current; loading=false; return; } await Save(); if(dirty) {loading=true;segments.SelectedItem=current;loading=false;return;} current=segments.SelectedItem as Row; if(current is null) return; loading=true; editor.Text=current.Text; editor.FlowDirection=current.Text.Any(c=>c>=0x600 && c<=0x6ff)?FlowDirection.RightToLeft:FlowDirection.LeftToRight; loading=false; Seek(current.Start); var selected=document.Get("segments").Rows().FirstOrDefault(s=>s.Text("id")==current.Id); status.Text="PDF matches (approximate): "+string.Join(", ",selected.Get("pdfReferences").Rows().Select(r=>Path.GetFileName(r.Text("file"))+" p."+r.Text("page"))); };
        autosave.Tick += async (_,_) => { autosave.Stop(); await Save(); };
        Loaded += async (_,_) => await Load();
        Closing += (_,e) => { if(retryPending) {e.Cancel=true;status.Text="Wait for the passage retry to finish before closing.";} else if(candidate) { e.Cancel=true; status.Text="Save or discard the candidate before closing."; } else if(dirty) { e.Cancel=true; _=SaveAndClose(); } else { autosave.Stop(); playbackTimer.Stop(); player.Stop(); } };
    }
    private void Seek(double seconds) {
        if(source.SelectedItem is AudioSource audio && !audio.Name.StartsWith("Original")) { var target=source.Items.Cast<AudioSource>().Where(a=>!a.Name.StartsWith("Original") && a.Offset<=seconds).OrderByDescending(a=>a.Offset).FirstOrDefault(); if(target is not null && target!=audio) source.SelectedItem=target; }
        player.Position=TimeSpan.FromSeconds(Math.Max(0,seconds-audioOffset));
    }
    private void DrawWaveform(JsonElement data)
    {
        waveform.Children.Clear();var values=data.Get("levels").Rows().Select(v=>v.GetDouble()).ToArray();if(values.Length==0)return;
        var shape=new System.Windows.Shapes.Polyline {Stroke=Brushes.Teal,StrokeThickness=1};var width=Math.Max(500,ActualWidth-40);waveform.Width=width;
        var peak=Math.Max(.001,values.Max());for(int i=0;i<values.Length;i++){var x=i*width/Math.Max(1,values.Length-1);shape.Points.Add(new Point(x,30-values[i]/peak*27));shape.Points.Add(new Point(x,30+values[i]/peak*27));}waveform.Children.Add(shape);
    }
    private void ShowHistory()
    {
        var window=new Window {Owner=this,Title="Revision history / سجل التعديلات",Width=700,Height=450};var panel=new DockPanel {Margin=new Thickness(12)};var restore=new Button {Content="Restore selected text / استعادة النص"};DockPanel.SetDock(restore,Dock.Bottom);panel.Children.Add(restore);var list=new ListBox();panel.Children.Add(list);
        foreach(var entry in document.Get("history").Rows())list.Items.Add(new ListBoxItem {Content=entry.Text("at")+" · "+entry.Text("before")+" → "+entry.Text("after"),Tag=entry.Clone()});window.Content=panel;
        restore.Click+=async (_,_)=>{if(candidate || dirty){status.Text="Save or discard current changes first.";return;}if(list.SelectedItem is ListBoxItem item && item.Tag is JsonElement h)try{document=await core.Request("editTranscript",new {id=job.Id,revision=int.Parse(document.Text("revision")),segmentId=h.Text("segmentId"),text=h.Text("before")});Populate();if(current is not null){loading=true;editor.Text=current.Text;loading=false;}window.Close();}catch(Exception e){status.Text=e.Message;}};window.Show();
    }
    private async Task SaveAndClose() { await Save(); if(!dirty) Close(); }
    private async Task Load()
    {
        try {
            document=await core.Request("transcript",new { id=job.Id }); Populate(); var rows=(List<Row>)segments.ItemsSource; segments.SelectedItem=rows.FirstOrDefault(r=>r.Id==initialSegment) ?? rows.FirstOrDefault();
            var audio=job.Value.Get("files").Rows().Where(f=>f.Text("kind")!="transcript").Select((f,i)=>new AudioSource(f.Text("name"),f.Text("path"),i*double.Parse(job.Value.Get("options").Text("splitMinutes","0"),System.Globalization.CultureInfo.InvariantCulture)*60)).ToList();
            var original=job.Value.Text("localFile"); if(File.Exists(original)) audio.Insert(0,new AudioSource("Original / الأصل",original));
            source.ItemsSource=audio; source.SelectedIndex=0;
            pdfPages.ItemsSource=document.Get("metadata").Get("pdfs").Rows().SelectMany(f=>Enumerable.Range(1,int.Parse(f.Text("pages","0"))).Select(p=>new PdfPage(Path.GetFileName(f.Text("file"))+" · "+p,f.Text("file"),p))).ToArray(); pdfPages.SelectedIndex=0;
            status.Text="Automatic audit: "+document.Get("quality").Text("status")+" · Human review: "+document.Text("reviewStatus");
        } catch(Exception e) { status.Text=e.Message; }
    }
    private void Populate()
    {
        loading=true; var id=current?.Id;
        var rows=document.Get("segments").Rows().Select(s=>new Row(s.Text("id"),$"{(s.Bool("marker")?"⚠ ":"")}{TimeSpan.FromSeconds(double.Parse(s.Text("start"),System.Globalization.CultureInfo.InvariantCulture)):hh\\:mm\\:ss}  {s.Text("text")}",double.Parse(s.Text("start"),System.Globalization.CultureInfo.InvariantCulture),double.Parse(s.Text("end"),System.Globalization.CultureInfo.InvariantCulture),s.Text("text"))).ToList();
        segments.ItemsSource=rows; current=rows.FirstOrDefault(r=>r.Id==id); segments.SelectedItem=current; loading=false;
    }
    private async Task Save()
    {
        if(candidate || !dirty || current is null) return;
        await saveGate.WaitAsync();
        try {
        if(!dirty || current is null) return;
        var text=editor.Text; var row=current; dirty=false;
        try { document=await core.Request("editTranscript",new { id=job.Id,revision=int.Parse(document.Text("revision")),segmentId=row.Id,text }); Populate(); }
        catch(Exception e) { dirty=true; status.Text=e.Message; }
        } finally { saveGate.Release(); }
    }
    private async Task Retry()
    {
        if(current is null || candidate || retryPending) return; await Save(); if(dirty) return;
        retryPending=true;segments.IsEnabled=false;editor.IsReadOnly=true; var requestedId=current.Id; var requestedRevision=document.Text("revision");
        try { status.Text="Transcribing selected audio…"; var result=await core.Request("retryPassage",new { id=job.Id,segmentId=current.Id,revision=int.Parse(document.Text("revision")) });
            if(current?.Id!=requestedId || document.Text("revision")!=requestedRevision) throw new Exception("Transcript changed during retry. Run the passage again.");
            loading=true; editor.Text=string.Join(" ",result.Get("segments").Rows().Where(s=>!s.Bool("marker")).Select(s=>s.Text("text"))); loading=false;
            // Deliberately no autosave: the user reviews the candidate and presses Save.
            candidate=true; dirty=true; status.Text="Candidate ready. Listen and press Save to accept. / راجع الاقتراح ثم اضغط حفظ.";
        } catch(Exception e) { status.Text=e.Message; }
        finally { retryPending=false;segments.IsEnabled=true;editor.IsReadOnly=false; }
    }
}
