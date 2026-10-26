using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Notakillite.Desktop;
public sealed class CoreClient : IAsyncDisposable
{
    private Process? process;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> pending = new();
    private readonly SemaphoreSlim writer = new(1, 1);
    private int sequence;
    public event Action<JsonElement>? State;
    public event Action<JsonElement>? BrowserCommand;
    public event Action<string>? Failed;
    public async Task Start(string appDirectory, string dataDirectory)
    {
        var info = new ProcessStartInfo(Path.Combine(appDirectory, "runtime", "node.exe")) { WorkingDirectory = appDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        info.ArgumentList.Add("--disable-warning=ExperimentalWarning"); info.ArgumentList.Add(Path.Combine(appDirectory, "core", "main.mjs")); info.ArgumentList.Add("--data-dir"); info.ArgumentList.Add(dataDirectory);
        process = Process.Start(info) ?? throw new Exception("The local audio core could not start.");
        _ = Task.Run(async () => {
            try { while (await process.StandardOutput.ReadLineAsync() is { } line) {
                using var document = JsonDocument.Parse(line); var value = document.RootElement;
                if (value.TryGetProperty("event", out var eventName) && eventName.GetString() == "state") State?.Invoke(value.GetProperty("data").Clone());
                else if (value.TryGetProperty("event", out eventName) && eventName.GetString() == "browserCommand") BrowserCommand?.Invoke(value.GetProperty("data").Clone());
                else if (value.TryGetProperty("id", out var id) && pending.TryRemove(id.GetInt32(), out var completion)) {
                    if (value.TryGetProperty("error", out var error)) completion.TrySetException(new Exception(error.GetString()));
                    else completion.TrySetResult(value.GetProperty("result").Clone());
                }
            } } catch (Exception error) { Failed?.Invoke(error.Message); }
            finally { foreach (var request in pending.Values) request.TrySetException(new Exception("The app core stopped. Reopen Notakillite to recover saved jobs.")); pending.Clear(); if (process is { HasExited: true } && process.ExitCode != 0) Failed?.Invoke("The app core stopped. Reopen the app; saved exports and sign-in are retained."); }
        });
        _ = Task.Run(async () => { while (await process.StandardError.ReadLineAsync() is { } _) { /* Do not surface browser diagnostics or website data in the UI. */ } });
        var hello=await Request("state"); if(int.TryParse(hello.Text("protocolVersion","1"),out var protocol) && protocol>2) throw new Exception("The desktop and processing core versions do not match. Reinstall the complete application.");
    }
    public async Task<JsonElement> Request(string type, object? parameters = null)
    {
        if (process is null || process.HasExited) throw new Exception("The local app core is not running.");
        var id = Interlocked.Increment(ref sequence);
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously); pending[id] = completion;
        await writer.WaitAsync();
        try { await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { id, type, @params = parameters ?? new { } })); await process.StandardInput.FlushAsync(); }
        catch { pending.TryRemove(id,out _); throw; }
        finally { writer.Release(); }
        try { return await completion.Task.WaitAsync(TimeSpan.FromMinutes(type == "connect" ? 2 : 5)); }
        finally { pending.TryRemove(id, out _); }
    }
    public async ValueTask DisposeAsync()
    {
        if (process is null) return;
        try { if (!process.HasExited) { await process.StandardInput.WriteLineAsync("{\"id\":0,\"type\":\"shutdown\"}"); await process.StandardInput.FlushAsync(); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); } }
        catch { if (!process.HasExited) process.Kill(true); }
        process.Dispose();
    }
}
