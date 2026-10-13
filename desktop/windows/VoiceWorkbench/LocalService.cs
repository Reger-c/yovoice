using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace VoiceWorkbench.Desktop;

// 原生宿主只管理服务生命周期；业务状态由 Go 服务统一持有。
public sealed class LocalService : IDisposable
{
    public string Root { get; } = DetermineDataRoot();
    public string Token { get; } = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
    public string CookieName => "vw-" + Token[..12];
    public string Origin { get; private set; } = "";
    private readonly HttpClient client = new(new HttpClientHandler { UseProxy = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private readonly CancellationTokenSource stopped = new();
    private Process? process;
    private Task? events;
    public event Action<string>? StateChanged;
    public event Action<string>? Failed;

    private static string DetermineDataRoot()
    {
        string? env = Environment.GetEnvironmentVariable("WORKBENCH_DATA");
        if (!string.IsNullOrWhiteSpace(env)) return Path.GetFullPath(env);

        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string configFile = Path.Combine(appData, "yovoice", "storage.json");
        if (File.Exists(configFile))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(configFile));
                if (doc.RootElement.TryGetProperty("dataPath", out var p) && p.GetString() is { Length: > 0 } customPath)
                {
                    return Path.GetFullPath(customPath);
                }
            }
            catch { }
        }

        string defaultUserData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".yovoice");
        // 旧版 VoiceWorkbench 数据会由 --prepare-data 迁移到 ~/.yovoice，此时必须沿用默认目录。
        string legacyData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VoiceWorkbench");
        if (Directory.Exists(defaultUserData) || Directory.Exists(legacyData))
        {
            return defaultUserData;
        }

        string installDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string installRoot = Path.GetPathRoot(installDir) ?? "";
        string userRoot = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)) ?? "";
        if (!string.IsNullOrEmpty(installRoot) && !string.IsNullOrEmpty(userRoot) &&
            !installRoot.Equals(userRoot, StringComparison.OrdinalIgnoreCase))
        {
            string? parent = Path.GetDirectoryName(installDir);
            if (!string.IsNullOrEmpty(parent))
            {
                string chosen = Path.Combine(parent, "yovoice-data");
                // 记录自动选择的目录：之后即使 ~/.yovoice 被命令行等工具创建，桌面应用也不会悄悄切回系统盘。
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(configFile)!);
                    File.WriteAllText(configFile, JsonSerializer.Serialize(new { dataPath = chosen }));
                }
                catch { }
                return chosen;
            }
        }

        return defaultUserData;
    }

    public async Task StartAsync()
    {
        if (process is { HasExited: false }) return;
        HostLog.Write(Root, "service.start_requested");
        string executable = Path.Combine(AppContext.BaseDirectory, "service", "yovoice-service.exe");
        if (!File.Exists(executable)) throw new IOException("本地服务缺失，请重新构建或安装应用。");
        if (Environment.GetEnvironmentVariable("WORKBENCH_DATA") is null)
        {
            using var migration = Process.Start(new ProcessStartInfo(executable, "--prepare-data") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true })!;
            string error = await migration.StandardError.ReadToEndAsync();
            await migration.WaitForExitAsync();
            if (migration.ExitCode != 0) throw new IOException("数据目录迁移失败：" + error);
        }
        Directory.CreateDirectory(Path.Combine(Root, "logs"));
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["WORKBENCH_DATA"] = Root;
        start.Environment["WORKBENCH_WEB"] = Path.Combine(AppContext.BaseDirectory, "web");
        start.Environment["WORKBENCH_TOKEN"] = Token;
        start.Environment["WORKBENCH_ENGINE"] = Path.Combine(AppContext.BaseDirectory, "engine", "audiocpp_server.exe");
        process = Process.Start(start) ?? throw new IOException("无法启动本地服务。");
        _ = PumpErrorsAsync(process);
        try
        {
            string? address = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30));
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1") throw new IOException("本地服务未返回有效地址，请检查日志。");
            Origin = uri.GetLeftPart(UriPartial.Authority);
        }
        catch
        {
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            throw;
        }
        HostLog.Write(Root, "service.ready");
        events = ReadEventsAsync();
    }
    private async Task PumpErrorsAsync(Process running)
    {
        try
        {
            // 与 macOS 一致：每次启动保留上一轮日志为 .1，单轮超过 5MB 时轮转，避免日志无限增长。
            const long limit = 5 * 1024 * 1024;
            string path = Path.Combine(Root, "logs", "host-service.log");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var log = OpenServiceLog(path);
            long size = log.BaseStream.Length;
            try
            {
                while (await running.StandardError.ReadLineAsync() is { } line)
                {
                    if (size >= limit)
                    {
                        await log.DisposeAsync();
                        log = OpenServiceLog(path);
                        size = 0;
                    }
                    await log.WriteLineAsync(line);
                    await log.FlushAsync();
                    size += Encoding.UTF8.GetByteCount(line) + Environment.NewLine.Length;
                }
            }
            finally { await log.DisposeAsync(); }
            await running.WaitForExitAsync();
            HostLog.Write(Root, "service.exited:" + running.ExitCode);
            if (!stopped.IsCancellationRequested) Failed?.Invoke("本地服务已停止，请退出后重新打开应用。");
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException) { }
    }
    // 轮转失败（例如日志正被外部程序占用）时退回追加写入，不能因此停止读取 stderr，否则服务会被管道阻塞。
    private static StreamWriter OpenServiceLog(string path)
    {
        try { if (File.Exists(path)) File.Move(path, path + ".1", true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Debug.WriteLine(error); }
        return new StreamWriter(path, true);
    }
    private HttpRequestMessage Request(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, Origin + "/" + path);
        request.Headers.Add("Cookie", CookieName + "=" + Token);
        return request;
    }
    public async Task<JsonElement> CallAsync(string method, object data)
    {
        using var request = Request(HttpMethod.Post, "api/call");
        request.Content = new StringContent(ServiceWire.Request(method, data), Encoding.UTF8, "application/json");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopped.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(120));
        using var response = await client.SendAsync(request, timeout.Token);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
        if (json.RootElement.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null) throw new ServiceCallException(error);
        return json.RootElement.GetProperty("result").Clone();
    }
    private async Task ReadEventsAsync()
    {
        while (!stopped.IsCancellationRequested)
        {
            try
            {
                using var request = Request(HttpMethod.Get, "api/state-events");
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, stopped.Token);
                response.EnsureSuccessStatusCode();
                using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(stopped.Token));
                while (await reader.ReadLineAsync(stopped.Token) is { } line)
                    if (line.StartsWith("data: ", StringComparison.Ordinal)) StateChanged?.Invoke(line[6..]);
            }
            catch (OperationCanceledException) when (stopped.IsCancellationRequested) { return; }
            catch (Exception error) when (error is HttpRequestException or IOException) { }
            try { await Task.Delay(1000, stopped.Token); } catch (OperationCanceledException) { return; }
        }
    }
    public async Task ShutdownAsync()
    {
        HostLog.Write(Root, "service.shutdown_requested");
        if (process is not { HasExited: false }) return;
        using var request = Request(HttpMethod.Post, "shutdown");
        using var response = await client.SendAsync(request).WaitAsync(TimeSpan.FromSeconds(30));
        response.EnsureSuccessStatusCode();
        stopped.Cancel();
        process.StandardInput.Close();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        HostLog.Write(Root, "service.shutdown_completed");
    }
    // 正常关停失败时使用：先关闭标准输入让服务自行退出，超时则结束进程。
    public void Stop()
    {
        stopped.Cancel();
        if (process is not { HasExited: false }) return;
        try
        {
            process.StandardInput.Close();
            if (!process.WaitForExit(5000)) process.Kill(true);
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or System.ComponentModel.Win32Exception) { HostLog.Write(Root, "service.stop_failed", error); }
    }
    public void Dispose()
    {
        stopped.Cancel();
        if (process is { HasExited: false }) process.StandardInput.Close();
        process?.Dispose(); client.Dispose();
    }
}
