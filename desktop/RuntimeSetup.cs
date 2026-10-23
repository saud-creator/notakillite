using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;

namespace Notakillite.Desktop;
public static class RuntimeSetup
{
    public static async Task Install()
    {
        var directory = Path.Combine(App.DataDirectory, "tools", "microsoft-runtime"); Directory.CreateDirectory(directory);
        var target = Path.Combine(directory, "vc_redist.x64.exe"); var partial = Path.Combine(directory, "vc_redist.download.exe");
        using (var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) }) {
            using var response = await client.GetAsync("https://aka.ms/vc14/vc_redist.x64.exe", HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            var host = response.RequestMessage?.RequestUri?.Host ?? "";
            if (response.RequestMessage?.RequestUri?.Scheme != "https" || !(host == "aka.ms" || host.EndsWith(".microsoft.com", StringComparison.OrdinalIgnoreCase))) throw new Exception("Microsoft's runtime download could not be verified.");
            await using var input = await response.Content.ReadAsStreamAsync();
            await using var output = File.Create(partial); var buffer = new byte[65536]; long total = 0;
            for (;;) { var read = await input.ReadAsync(buffer); if (read == 0) break; total += read; if (total > 100 * 1024 * 1024) throw new Exception("The runtime download exceeded its expected size."); await output.WriteAsync(buffer.AsMemory(0, read)); }
            await output.FlushAsync();
        }
        var script = "$signature = Get-AuthenticodeSignature -LiteralPath '" + partial.Replace("'", "''") + "'; if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'CN=Microsoft Corporation') { exit 0 } else { exit 1 }";
        var check = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe")) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        check.ArgumentList.Add("-NoProfile"); check.ArgumentList.Add("-NonInteractive"); check.ArgumentList.Add("-EncodedCommand"); check.ArgumentList.Add(Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
        using (var signature = Process.Start(check) ?? throw new Exception("Could not verify the Microsoft installer.")) { await signature.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(45)); if (signature.ExitCode != 0) { File.Delete(partial); throw new Exception("Microsoft's installer signature was not valid. The installer was not opened."); } }
        File.Move(partial, target, true);
        using var installer = Process.Start(new ProcessStartInfo(target, "/install /norestart") { UseShellExecute = true }) ?? throw new Exception("Could not open Microsoft's runtime installer.");
        await installer.WaitForExitAsync();
        if (installer.ExitCode is not (0 or 1638 or 3010)) throw new Exception("Microsoft's runtime installation did not complete. You can retry it from Settings.");
    }
}
