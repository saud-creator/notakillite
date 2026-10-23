using System;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

internal static class NativeMessagingHost
{
    private const string Origin = "chrome-extension://pnfghekgheamlilmdlapjbhaofgnbcco/";
    private static int Main(string[] args)
    {
        if (args.Length < 1 || args[0] != Origin) return 2;
        try {
            string root = Directory.GetParent(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)).FullName;
            string identity;
            using (var sha = SHA256.Create()) identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant()))).Replace("-", "").Substring(0, 20);
            using (var pipe = new NamedPipeClientStream(".", "Notakillite.Browser." + identity, PipeDirection.InOut, PipeOptions.Asynchronous)) {
                // The host stays small and waits for the user's desktop app; it never starts an unrelated browser or resets profiles.
                pipe.Connect(30000);
                Task upstream = Frames(Console.OpenStandardInput(), pipe);
                Task downstream = Frames(pipe, Console.OpenStandardOutput());
                Task.WhenAny(upstream, downstream).GetAwaiter().GetResult();
            }
            return 0;
        } catch { Console.Error.WriteLine("Notakillite is not available. Open its desktop app to reconnect."); return 1; }
    }
    private static async Task Frames(Stream input, Stream output)
    {
        var header = new byte[4];
        while (await Read(input, header, 4)) {
            uint length = BitConverter.ToUInt32(header, 0);
            if (length < 2 || length > 1024 * 1024) throw new InvalidDataException("Invalid bridge frame.");
            var body = new byte[(int)length];
            if (!await Read(input, body, body.Length)) throw new EndOfStreamException();
            await output.WriteAsync(header, 0, 4); await output.WriteAsync(body, 0, body.Length); await output.FlushAsync();
        }
    }
    private static async Task<bool> Read(Stream input, byte[] buffer, int size)
    {
        int offset = 0;
        while (offset < size) { int count = await input.ReadAsync(buffer, offset, size - offset); if (count == 0) { if (offset != 0) throw new EndOfStreamException(); return false; } offset += count; }
        return true;
    }
}
