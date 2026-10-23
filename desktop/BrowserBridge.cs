using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Notakillite.Desktop;
public sealed class BrowserBridge : IAsyncDisposable
{
    private readonly CoreClient core;
    private readonly string channel;
    private readonly CancellationTokenSource cancellation = new();
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    private Task? listener;
    public BrowserBridge(CoreClient core, string directory)
    {
        this.core = core;
        channel = "Notakillite.Browser." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToUpperInvariant())))[..20];
        core.BrowserCommand += OnCommand;
    }
    public void Start() { listener = Listen(); }
    private async Task Listen()
    {
        while (!cancellation.IsCancellationRequested) {
            NamedPipeServerStream? pipe = null;
            try {
                pipe = new NamedPipeServerStream(channel, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 65536, 65536);
                await pipe.WaitForConnectionAsync(cancellation.Token);
                if (sessions.Count >= 6) { pipe.Dispose(); continue; }
                var session = new Session(pipe); sessions[session.Id] = session; pipe = null;
                _ = Receive(session);
            } catch (OperationCanceledException) { pipe?.Dispose(); break; }
            catch (IOException) { pipe?.Dispose(); try { await Task.Delay(500, cancellation.Token); } catch { break; } }
        }
    }
    private async Task Receive(Session session)
    {
        try {
            var header = new byte[4];
            while (!cancellation.IsCancellationRequested) {
                await session.Pipe.ReadExactlyAsync(header, cancellation.Token);
                uint count = BitConverter.ToUInt32(header);
                if (count < 2 || count > 1024 * 1024) throw new InvalidDataException("Invalid browser frame.");
                var bytes = new byte[(int)count]; await session.Pipe.ReadExactlyAsync(bytes, cancellation.Token);
                using var document = JsonDocument.Parse(bytes); var message = document.RootElement;
                if (message.Text("type") == "hello") {
                    var result = await core.Request("browserHello", new { connectionId = session.Id, hello = message.Clone() });
                    await session.Send(new { type = "helloAck", accepted = result.Bool("accepted"), code = result.Text("code"), message = result.Text("message"), version = result.Text("version") }, cancellation.Token);
                } else if (message.Text("type") is "response" or "responseChunk") {
                    await core.Request("browserResponse", new { connectionId = session.Id, message = message.Clone() });
                }
            }
        } catch (Exception) when (cancellation.IsCancellationRequested) { }
        catch (IOException) { }
        catch (Exception) { /* Invalid or interrupted sessions are isolated to this client. */ }
        finally {
            sessions.TryRemove(session.Id, out _); session.Pipe.Dispose();
            try { await core.Request("browserDisconnected", new { connectionId = session.Id }); } catch { }
        }
    }
    private void OnCommand(JsonElement command) { _ = SendCommand(command); }
    private async Task SendCommand(JsonElement command)
    {
        if (!sessions.TryGetValue(command.Text("connectionId"), out var session)) return;
        try { await session.Send(command, cancellation.Token); }
        catch { session.Pipe.Dispose(); }
    }
    public async ValueTask DisposeAsync()
    {
        core.BrowserCommand -= OnCommand; cancellation.Cancel();
        foreach (var session in sessions.Values) session.Pipe.Dispose();
        if (listener is not null) try { await listener.WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
        cancellation.Dispose();
    }
    private sealed class Session(NamedPipeServerStream pipe)
    {
        public string Id { get; } = Guid.NewGuid().ToString();
        public NamedPipeServerStream Pipe { get; } = pipe;
        private readonly SemaphoreSlim writer = new(1, 1);
        public async Task Send<T>(T message, CancellationToken token)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
            if (bytes.Length > 1024 * 1024) throw new InvalidDataException("Browser message exceeds the frame limit.");
            await writer.WaitAsync(token);
            try { await Pipe.WriteAsync(BitConverter.GetBytes(bytes.Length), token); await Pipe.WriteAsync(bytes, token); await Pipe.FlushAsync(token); }
            finally { writer.Release(); }
        }
    }
}
