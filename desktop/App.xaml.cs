using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Windows;
using System.Security.Cryptography;

namespace Notakillite.Desktop;
public partial class App : System.Windows.Application
{
    private Mutex? instance;
    private CancellationTokenSource? activationCancellation;
    public static string DataDirectory { get; private set; } = "";
    public static string AppDirectory => AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var dataIndex = Array.IndexOf(e.Args, "--data-dir");
        DataDirectory = Path.GetFullPath(dataIndex >= 0 && e.Args.Length > dataIndex + 1 ? e.Args[dataIndex + 1] : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Notakillite"));
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(DataDirectory.ToUpperInvariant())))[..20];
        var channel = "Notakillite.Brave." + identity;
        instance = new Mutex(true, "Local\\" + channel, out var first);
        if (!first) {
            try { using var pipe = new NamedPipeClientStream(".", channel, PipeDirection.Out); await pipe.ConnectAsync(2000); await pipe.WriteAsync(new byte[] { 1 }); } catch { }
            Shutdown(); return;
        }
        if (e.Args.Contains("--self-test")) {
            try {
                await using var core = new CoreClient();
                await core.Start(AppDirectory, DataDirectory);
                var state = await core.Request("state");
                Directory.CreateDirectory(DataDirectory);
                await File.WriteAllTextAsync(Path.Combine(DataDirectory, "desktop-verification.json"), state.GetRawText());
                Shutdown(0);
            } catch (Exception error) { Directory.CreateDirectory(DataDirectory); await File.WriteAllTextAsync(Path.Combine(DataDirectory, "desktop-verification-error.txt"), error.Message); Shutdown(1); }
            return;
        }
        var window = new MainWindow(); MainWindow = window; window.Show();
        activationCancellation = new CancellationTokenSource();
        _ = Task.Run(async () => {
            while (!activationCancellation.IsCancellationRequested) {
                try { await using var pipe = new NamedPipeServerStream(channel, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly); await pipe.WaitForConnectionAsync(activationCancellation.Token); await pipe.ReadExactlyAsync(new byte[1], activationCancellation.Token); Dispatcher.Invoke(() => { window.Show(); window.WindowState = WindowState.Normal; window.Activate(); }); }
                catch (OperationCanceledException) { break; } catch { await Task.Delay(500); }
            }
        });
        var previewIndex = Array.IndexOf(e.Args, "--preview-fixture");
        await window.InitializeAsync(e.Args.Contains("--no-connect") || previewIndex >= 0);
        if (previewIndex >= 0 && e.Args.Length > previewIndex + 1) { using var state = System.Text.Json.JsonDocument.Parse(await File.ReadAllTextAsync(e.Args[previewIndex + 1])); window.ApplyPreview(state.RootElement); }
        Directory.CreateDirectory(Path.Combine(DataDirectory, "logs"));
        await File.WriteAllTextAsync(Path.Combine(DataDirectory, "logs", "desktop-ready.txt"), Environment.ProcessId + "\n" + AppDirectory);
        var captureIndex = Array.IndexOf(e.Args, "--capture-to");
        if (captureIndex >= 0 && e.Args.Length > captureIndex + 1) { await Task.Delay(1200); await window.CaptureTo(e.Args[captureIndex + 1]); if (e.Args.Contains("--capture-and-exit")) window.Close(); }
    }
    protected override void OnExit(ExitEventArgs e) { activationCancellation?.Cancel(); try { instance?.ReleaseMutex(); } catch { } instance?.Dispose(); base.OnExit(e); }
}
