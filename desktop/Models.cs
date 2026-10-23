using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;

namespace Notakillite.Desktop;
public static class Json
{
    public static string Text(this JsonElement value, string key, string fallback = "") => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var item) && item.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? item.ValueKind == JsonValueKind.String ? item.GetString() ?? fallback : item.ToString() : fallback;
    public static bool Bool(this JsonElement value, string key) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.True;
    public static JsonElement Get(this JsonElement value, string key) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var item) ? item : default;
    public static IEnumerable<JsonElement> Rows(this JsonElement value) => value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];
}
public class FolderModel : INotifyPropertyChanged
{
    public string Key { get; init; } = "";
    public string Title { get; init; } = "";
    public string Path { get; init; } = "";
    public string[] NoteIds { get; init; } = [];
    public List<FolderModel> Children { get; init; } = [];
    public bool Expanded { get; set; }
    private bool selected;
    public bool Selected { get => selected; set { if (selected != value) { selected = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Selected))); } } }
    public event PropertyChangedEventHandler? PropertyChanged;
    public string ColorValue { get; init; } = "";
    public Brush Color { get { try { if (ColorValue.StartsWith('#')) return new SolidColorBrush((Color)ColorConverter.ConvertFromString(ColorValue)); } catch { } return (Brush)System.Windows.Application.Current.FindResource("AccentBrush"); } }
    public string CountLabel => NoteIds.Length > 0 ? NoteIds.Length.ToString() : "";
}
public class NoteModel
{
    public JsonElement Value { get; init; }
    public string Id => Value.Text("id");
    public string Title => Value.Text("title", "Untitled note");
    public string Path => string.Join(" / ", Value.Get("path").Rows().Select(x => x.Text("title")));
    public bool HasAudio => Value.Bool("hasRecordings");
    public string Meta { get { var count = Value.Get("recordings").Rows().Count(); return (HasAudio ? count > 0 ? $"{count} recording{(count == 1 ? "" : "s")}" : "Recordings available" : "No audio") + DateLabel(); } }
    private string DateLabel() { var raw = Value.Text("updatedAt"); if (DateTimeOffset.TryParse(raw, out var date)) return " · " + date.ToLocalTime().ToString("d MMM"); if (long.TryParse(raw, out var timestamp) && timestamp > 0 && timestamp < 253402300799000) { try { return " · " + DateTimeOffset.FromUnixTimeMilliseconds(timestamp < 100000000000 ? timestamp * 1000 : timestamp).ToLocalTime().ToString("d MMM"); } catch { } } return ""; }
    public bool ShowPath { get; set; }
    public string Duration { get { var seconds = Value.Get("recordings").Rows().Sum(item => double.TryParse(item.Text("duration"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0); return seconds > 0 ? MainWindow.FormatDuration(seconds) : ""; } }
    public string Icon => HasAudio ? "♫" : "▤";
    public FlowDirection Direction => Title.Length > 0 && Title.Any(c => c >= '\u0600' && c <= '\u06ff') ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
}
public class RecordingModel : INotifyPropertyChanged
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    private bool selected = true;
    public bool Selected { get => selected; set { if (selected != value) { selected = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Selected))); } } }
    public double Seconds { get; init; }
    public string Duration => MainWindow.FormatDuration(Seconds);
    public event PropertyChangedEventHandler? PropertyChanged;
}
public class JobModel
{
    public JsonElement Value { get; init; }
    public string Id => Value.Text("id");
    public string Title => Value.Text("title");
    public string Recording => Value.Text("recordingName");
    public string Status => Value.Text("status");
    public string Phase => Value.Text("phase");
    public string Error => Value.Text("error");
    public string Engine => (Value.Get("options").Text("engine") switch { "deepfilter" => "DeepFilterNet3", "rnnoise" => "RNNoise", "hybrid" => "Both engines", "none" => "Original", _ => "Light cleanup" }) + (Value.Get("options").Bool("transcribe") ? Value.Get("options").Text("transcriber") == "groq" ? " · Groq transcript" : " · Whisper transcript" : "");
    public bool HasTranscript => Status == "done" && Value.Text("transcriptPath").Length > 0;
    public double Progress => double.TryParse(Value.Text("fraction"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var progress) ? progress * 100 : 0;
    public bool Indeterminate => Status == "running" && Value.Get("fraction").ValueKind != JsonValueKind.Number;
    public string Badge => Status switch { "done" => "✓", "running" => "●", "queued" => "◷", "cancelled" => "−", _ => "!" };
    public bool CanCancel => Status is "queued" or "running";
    public bool CanRetry => Status is "error" or "interrupted" or "cancelled";
    public bool CanPlay => Status == "done" && Value.Get("files").Rows().Any();
}
