using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("Notakillite")]
[assembly: AssemblyDescription("Native Windows Notability audio app with persistent Brave sign-in")]
[assembly: AssemblyProduct("Notakillite")]
[assembly: AssemblyVersion("0.6.0.0")]
[assembly: AssemblyFileVersion("0.6.0.0")]
internal static class WindowsLauncher
{
    private const string Version = "0.6.0";
    [STAThread]
    private static int Main(string[] args)
    {
        bool verify = Array.IndexOf(args, "--verify-only") >= 0;
        int location = Array.IndexOf(args, "--extract-to");
        string destination = location >= 0 && location + 1 < args.Length ? Path.GetFullPath(args[location + 1]) : null;
        if (destination != null && !verify) return 2;
        if (verify) {
            try {
                if (destination == null) return 2;
                string app = Prepare(destination);
                string node = Run(Path.Combine(app, "runtime", "node.exe"), "--version", app);
                string ffmpeg = Run(Path.Combine(app, "node_modules", "ffmpeg-static", "ffmpeg.exe"), "-version", app);
                string deepfilter = Run(Path.Combine(app, "vendor", "deepfilternet", "deep-filter.exe"), "--version", app);
                Run(Path.Combine(app, "Notakillite.Desktop.exe"), "--self-test --data-dir " + Quote(Path.Combine(destination, "native-test")), app);
                File.WriteAllText(Path.Combine(destination, "verification.txt"), "PASS\r\n" + node.Trim() + "\r\n" + ffmpeg.Split('\n')[0] + "\r\n" + deepfilter.Trim() + "\r\nNative WPF and local core passed\r\n" + app);
                return 0;
            } catch (Exception error) { if (destination != null) { Directory.CreateDirectory(destination); File.WriteAllText(Path.Combine(destination, "verification-error.txt"), error.ToString()); } return 1; }
        }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var splash = new Form { Text = "Notakillite", Width = 400, Height = 150, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        splash.Controls.Add(new Label { Text = "Opening your Brave workspace…", AutoSize = true, Left = 24, Top = 22 });
        splash.Controls.Add(new ProgressBar { Left = 24, Top = 60, Width = 335, Style = ProgressBarStyle.Marquee });
        Exception failure = null;
        splash.Shown += delegate {
            Task.Run(delegate {
                try {
                    string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Notakillite");
                    string app = Prepare(data);
                    try { LaunchDesktop(app, data); }
                    catch {
                        string current = Path.Combine(data, "launcher", "current.txt");
                        string previous = File.Exists(current) ? File.ReadAllText(current).Trim() : null;
                        string versions = Path.GetFullPath(Path.Combine(data, "versions")) + Path.DirectorySeparatorChar;
                        if (previous == null || previous == app || !Path.GetFullPath(previous).StartsWith(versions, StringComparison.OrdinalIgnoreCase) || !File.Exists(Path.Combine(previous, "Notakillite.Desktop.exe"))) throw;
                        LaunchDesktop(previous, data);
                    }
                } catch (Exception error) { failure = error; }
                splash.BeginInvoke(new Action(delegate { splash.Close(); }));
            });
        };
        Application.Run(splash);
        if (failure != null) { MessageBox.Show(failure.Message, "Notakillite could not open", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
        return 0;
    }
    private static void LaunchDesktop(string app, string data)
    {
        var info = new ProcessStartInfo(Path.Combine(app, "Notakillite.Desktop.exe"), "--data-dir " + Quote(data)) { WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true };
        using (Process process = Process.Start(info)) {
            string ready = Path.Combine(data, "logs", "desktop-ready.txt");
            for (int i = 0; i < 150; i++) {
                if (process.HasExited) { if (process.ExitCode != 0) throw new Exception("The new desktop app could not start. Your saved Brave sign-in and exports have been retained."); return; }
                try {
                    if (File.Exists(ready) && File.ReadAllLines(ready)[0] == process.Id.ToString()) {
                        Directory.CreateDirectory(Path.Combine(data, "launcher"));
                        string current = Path.Combine(data, "launcher", "current.txt");
                        File.WriteAllText(current + ".next", app);
                        if (File.Exists(current)) File.Replace(current + ".next", current, current + ".previous"); else File.Move(current + ".next", current);
                        return;
                    }
                } catch (IOException) { }
                Thread.Sleep(200);
            }
            throw new Exception("The desktop app did not finish starting. Reopen Notakillite to recover. Your Brave profile has not been reset.");
        }
    }
    private static string Prepare(string data)
    {
        Directory.CreateDirectory(data);
        string digest;
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Notakillite.Payload.zip"))
        using (SHA256 sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(resource)).Replace("-", "").Substring(0, 12).ToLowerInvariant();
        string app = Path.Combine(data, "versions", Version + "-" + digest);
        string complete = Path.Combine(app, "ready.txt");
        if (File.Exists(complete)) return app;
        Directory.CreateDirectory(app);
        string root = Path.GetFullPath(app).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Notakillite.Payload.zip"))
        using (var archive = new ZipArchive(resource, ZipArchiveMode.Read)) {
            foreach (ZipArchiveEntry entry in archive.Entries) {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                string target = Path.GetFullPath(Path.Combine(app, relative));
                if (target.TrimEnd(Path.DirectorySeparatorChar).Equals(root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) continue;
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid application package path.");
                if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (Stream input = entry.Open()) using (Stream output = File.Create(target)) input.CopyTo(output);
            }
        }
        foreach (string required in new[] { "Notakillite.Desktop.exe", "Notakillite.NativeHost.exe", "brave-connector\\manifest.json", "brave-connector\\adapter.js", "runtime\\node.exe", "core\\main.mjs", "node_modules\\ffmpeg-static\\ffmpeg.exe", "vendor\\rnnoise\\cb.rnnn", "vendor\\deepfilternet\\deep-filter.exe", "vendor\\deepfilternet\\DeepFilterNet3_onnx.tar.gz" }) if (!File.Exists(Path.Combine(app, required))) throw new InvalidDataException("The application package is incomplete.");
        File.WriteAllText(complete, Version); return app;
    }
    private static string Run(string executable, string arguments, string directory)
    {
        var info = new ProcessStartInfo(executable, arguments) { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true };
        using (Process process = Process.Start(info)) {
            Task<string> output = process.StandardOutput.ReadToEndAsync(); Task<string> error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(120000)) { process.Kill(); throw new Exception("Runtime verification took too long."); }
            Task.WaitAll(output, error);
            if (process.ExitCode != 0) throw new Exception((output.Result + "\r\n" + error.Result).Trim()); return output.Result;
        }
    }
    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
}
