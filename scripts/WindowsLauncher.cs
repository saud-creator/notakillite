using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("Notakillite")]
[assembly: AssemblyDescription("Native Windows Notability audio app with persistent Brave sign-in")]
[assembly: AssemblyProduct("Notakillite")]
[assembly: AssemblyVersion("0.7.0.0")]
[assembly: AssemblyFileVersion("0.7.0.0")]
internal static class WindowsLauncher
{
    private const string Version = "0.7.0";
    private static readonly string[] RequiredPayloadFiles = {
        "Notakillite.Desktop.exe", "Notakillite.NativeHost.exe", "brave-connector\\manifest.json", "brave-connector\\adapter.js",
        "runtime\\node.exe", "core\\main.mjs", "node_modules\\ffmpeg-static\\ffmpeg.exe", "vendor\\rnnoise\\cb.rnnn",
        "vendor\\deepfilternet\\deep-filter.exe", "vendor\\deepfilternet\\DeepFilterNet3_onnx.tar.gz"
    };

    private sealed class LaunchOptions
    {
        public string DataDirectory;
        public bool NoConnect;
        public string PreviewFixture;
        public string CaptureTo;
        public bool CaptureAndExit;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool verify = Array.IndexOf(args, "--verify-only") >= 0;
        int location = Array.IndexOf(args, "--extract-to");
        string destination = location >= 0 && location + 1 < args.Length ? Path.GetFullPath(args[location + 1]) : null;
        if (verify) {
            try {
                if (destination == null || args.Length != 3 || location < 0) return 2;
                string app = Prepare(destination);
                string node = Run(Path.Combine(app, "runtime", "node.exe"), "--version", app);
                string ffmpeg = Run(Path.Combine(app, "node_modules", "ffmpeg-static", "ffmpeg.exe"), "-version", app);
                string deepfilter = Run(Path.Combine(app, "vendor", "deepfilternet", "deep-filter.exe"), "--version", app);
                Run(Path.Combine(app, "Notakillite.Desktop.exe"), "--self-test " + QuoteArgument("--data-dir") + " " + QuoteArgument(Path.Combine(destination, "native-test")), app);
                File.WriteAllText(Path.Combine(destination, "verification.txt"), "PASS\r\n" + node.Trim() + "\r\n" + ffmpeg.Split('\n')[0] + "\r\n" + deepfilter.Trim() + "\r\nNative WPF and local core passed\r\n" + app);
                return 0;
            } catch (Exception error) { if (destination != null) { Directory.CreateDirectory(destination); File.WriteAllText(Path.Combine(destination, "verification-error.txt"), error.ToString()); } return 1; }
        }
        if (location >= 0) return 2;
        LaunchOptions options;
        try { options = ParseLaunchOptions(args); }
        catch (Exception error) { MessageBox.Show(error.Message, "Notakillite could not open", MessageBoxButtons.OK, MessageBoxIcon.Error); return 2; }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var splash = new Form { Text = "Notakillite", Width = 400, Height = 150, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        splash.Controls.Add(new Label { Text = "Opening your Brave workspace…", AutoSize = true, Left = 24, Top = 22 });
        splash.Controls.Add(new ProgressBar { Left = 24, Top = 60, Width = 335, Style = ProgressBarStyle.Marquee });
        Exception failure = null;
        splash.Shown += delegate {
            Task.Run(delegate {
                try {
                    string data = options.DataDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Notakillite");
                    string app = Prepare(data);
                    try { LaunchDesktop(app, data, options); }
                    catch {
                        string current = Path.Combine(data, "launcher", "current.txt");
                        string previous = File.Exists(current) ? File.ReadAllText(current).Trim() : null;
                        string versions = Path.GetFullPath(Path.Combine(data, "versions")) + Path.DirectorySeparatorChar;
                        if (previous == null || previous == app || !Path.GetFullPath(previous).StartsWith(versions, StringComparison.OrdinalIgnoreCase) || !File.Exists(Path.Combine(previous, "Notakillite.Desktop.exe"))) throw;
                        LaunchDesktop(previous, data, options);
                    }
                } catch (Exception error) { failure = error; }
                splash.BeginInvoke(new Action(delegate { splash.Close(); }));
            });
        };
        Application.Run(splash);
        if (failure != null) {
            if (options.CaptureAndExit) {
                try { string logs = Path.Combine(options.DataDirectory, "logs"); Directory.CreateDirectory(logs); File.WriteAllText(Path.Combine(logs, "launcher-error.txt"), failure.ToString()); } catch { }
            } else MessageBox.Show(failure.Message, "Notakillite could not open", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
    private static LaunchOptions ParseLaunchOptions(string[] args)
    {
        var options = new LaunchOptions();
        for (int i = 0; i < args.Length; i++) {
            string value;
            switch (args[i]) {
                case "--data-dir":
                    if (options.DataDirectory != null) throw new ArgumentException("Use --data-dir only once.");
                    value = RequireValue(args, ref i, "--data-dir");
                    options.DataDirectory = Path.GetFullPath(value);
                    break;
                case "--no-connect":
                    if (options.NoConnect) throw new ArgumentException("Use --no-connect only once.");
                    options.NoConnect = true;
                    break;
                case "--preview-fixture":
                    if (options.PreviewFixture != null) throw new ArgumentException("Use --preview-fixture only once.");
                    options.PreviewFixture = Path.GetFullPath(RequireValue(args, ref i, "--preview-fixture"));
                    break;
                case "--capture-to":
                    if (options.CaptureTo != null) throw new ArgumentException("Use --capture-to only once.");
                    options.CaptureTo = Path.GetFullPath(RequireValue(args, ref i, "--capture-to"));
                    break;
                case "--capture-and-exit":
                    if (options.CaptureAndExit) throw new ArgumentException("Use --capture-and-exit only once.");
                    options.CaptureAndExit = true;
                    break;
                default:
                    throw new ArgumentException("Unsupported launcher option: " + args[i]);
            }
        }
        if (options.CaptureAndExit && (options.CaptureTo == null || options.DataDirectory == null || (!options.NoConnect && options.PreviewFixture == null)))
            throw new ArgumentException("--capture-and-exit requires --data-dir, --capture-to and --no-connect (or --preview-fixture).");
        return options;
    }

    private static string RequireValue(string[] args, ref int index, string option)
    {
        if (index + 1 >= args.Length || args[index + 1].Length == 0) throw new ArgumentException(option + " requires a path.");
        return args[++index];
    }

    private static void LaunchDesktop(string app, string data, LaunchOptions options)
    {
        var info = new ProcessStartInfo(Path.Combine(app, "Notakillite.Desktop.exe"), BuildDesktopArguments(data, options)) { WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true };
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
                        if (options.CaptureAndExit) {
                            if (!process.WaitForExit(30000)) {
                                try { process.Kill(); process.WaitForExit(5000); } catch { }
                                throw new Exception("The desktop app did not exit after capture-and-exit.");
                            }
                            if (process.ExitCode != 0) throw new Exception("The desktop app did not exit cleanly after capture-and-exit.");
                        }
                        return;
                    }
                } catch (IOException) { }
                Thread.Sleep(200);
            }
            if (options.CaptureAndExit) {
                try { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } } catch { }
            }
            throw new Exception("The desktop app did not finish starting. Reopen Notakillite to recover. Your Brave profile has not been reset.");
        }
    }

    private static string BuildDesktopArguments(string data, LaunchOptions options)
    {
        var result = new StringBuilder();
        AppendArgument(result, "--data-dir"); AppendArgument(result, data);
        if (options.NoConnect) AppendArgument(result, "--no-connect");
        if (options.PreviewFixture != null) { AppendArgument(result, "--preview-fixture"); AppendArgument(result, options.PreviewFixture); }
        if (options.CaptureTo != null) { AppendArgument(result, "--capture-to"); AppendArgument(result, options.CaptureTo); }
        if (options.CaptureAndExit) AppendArgument(result, "--capture-and-exit");
        return result.ToString();
    }

    private static void AppendArgument(StringBuilder commandLine, string argument)
    {
        if (commandLine.Length > 0) commandLine.Append(' ');
        commandLine.Append(QuoteArgument(argument));
    }

    // ProcessStartInfo on .NET Framework accepts one command-line string, not an argument list.
    // Quote according to the Windows argv parsing rules, including quotes and trailing backslashes.
    private static string QuoteArgument(string value)
    {
        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value) {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"') {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
            } else {
                result.Append('\\', backslashes);
                result.Append(character);
            }
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string Prepare(string data)
    {
        Directory.CreateDirectory(data);
        string digest;
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Notakillite.Payload.zip"))
        using (SHA256 sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(resource)).Replace("-", "").Substring(0, 12).ToLowerInvariant();
        string app = Path.Combine(data, "versions", Version + "-" + digest);
        string complete = Path.Combine(app, "ready.txt");
        if (File.Exists(complete) && HasRequiredPayload(app)) return app;
        if (File.Exists(complete)) File.Delete(complete);
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
        if (!HasRequiredPayload(app)) throw new InvalidDataException("The application package is incomplete.");
        File.WriteAllText(complete, Version); return app;
    }

    private static bool HasRequiredPayload(string app)
    {
        foreach (string required in RequiredPayloadFiles) if (!File.Exists(Path.Combine(app, required))) return false;
        return true;
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
}
