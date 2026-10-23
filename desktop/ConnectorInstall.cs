using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Notakillite.Desktop;
public static class ConnectorInstall
{
    public const string ExtensionId = "pnfghekgheamlilmdlapjbhaofgnbcco";
    public const string HostName = "com.notakillite.bridge";
    public static string ExtensionDirectory => Path.Combine(App.DataDirectory, "connector", "extension");
    public static void Prepare()
    {
        var source = Path.Combine(App.AppDirectory, "brave-connector");
        Directory.CreateDirectory(ExtensionDirectory);
        foreach (var name in new[] { "manifest.json", "background.js", "adapter.js", "connect.html", "connect.js", "connect.css" }) {
            var bytes = File.ReadAllBytes(Path.Combine(source, name));
            var destination = Path.Combine(ExtensionDirectory, name);
            if (File.Exists(destination) && File.ReadAllBytes(destination).AsSpan().SequenceEqual(bytes)) continue;
            AtomicWrite(destination, bytes);
        }
        var hostBytes = File.ReadAllBytes(Path.Combine(App.AppDirectory, "Notakillite.NativeHost.exe"));
        var bridge = Path.Combine(App.DataDirectory, "bridge"); Directory.CreateDirectory(bridge);
        var host = Path.Combine(bridge, "native-host-" + Convert.ToHexString(SHA256.HashData(hostBytes))[..12].ToLowerInvariant() + ".exe");
        if (!File.Exists(host)) AtomicWrite(host, hostBytes);
        var manifest = Path.Combine(bridge, HostName + ".json");
        AtomicWrite(manifest, JsonSerializer.SerializeToUtf8Bytes(new { name = HostName, description = "Notakillite regular Brave connector", path = host, type = "stdio", allowed_origins = new[] { "chrome-extension://" + ExtensionId + "/" } }));
        // Brave checks the compatible Chromium host registration on Windows. Register only this app's host, never extension-install policies.
        foreach (var prefix in new[] { @"Software\BraveSoftware\Brave-Browser", @"Software\Google\Chrome" }) {
            using var key = Registry.CurrentUser.CreateSubKey(prefix + @"\NativeMessagingHosts\" + HostName);
            key.SetValue("", manifest, RegistryValueKind.String);
        }
    }
    private static void AtomicWrite(string destination, byte[] bytes)
    {
        var pending = destination + ".next"; File.WriteAllBytes(pending, bytes); File.Move(pending, destination, true);
    }
}
