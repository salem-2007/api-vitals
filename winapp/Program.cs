// Program.cs — 原生窗口壳：WinForms + WebView2（内嵌渲染，不弹浏览器）
// 职责只有四件事：开窗、嵌 WebView、本地 JSON 读写桥、日志。
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ApiHealth;

static class Program
{
    // Win11 DWM：窗口圆角 + 深色标题栏
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWCP_ROUND = 2;

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    static void ApplyChrome(IntPtr hwnd, bool dark)
    {
        try
        {
            int round = DWMWCP_ROUND;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
            int darkMode = dark ? 1 : 0;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref darkMode, sizeof(int));
        }
        catch { /* 非 Win11 或 API 不可用时忽略 */ }
    }

    // 探测系统 UI 字体：优先 SystemFonts（Windows 实际生效的 UI 字体），
    // 其次注册表 LOGFONT（用户自定义/字体替换），最后系统默认字体。不写死任何字体名。
    static (string Font, int Px) DetectSystemFont()
    {
        // 1) SystemFonts：随系统主题/DPI/个性化设置实时变化
        try
        {
            using var f = SystemFonts.MessageBoxFont;
            if (f?.FontFamily?.Name is string n && !string.IsNullOrWhiteSpace(n))
                return (n, (int)Math.Round(f.SizeInPoints * 96 / 72));
        }
        catch { }

        // 2) 注册表 MessageFont（LOGFONTW）
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop\WindowMetrics");
            if (k?.GetValue("MessageFont") is byte[] b && b.Length >= 92)
            {
                var name = Encoding.Unicode.GetString(b, 28, 64).TrimEnd('\0').Trim();
                var h = BitConverter.ToInt32(b, 0);
                if (!string.IsNullOrWhiteSpace(name))
                    return (name, Math.Abs(h) / 20 * 96 / 72);
            }
        }
        catch { }

        // 3) 系统默认字体
        try
        {
            using var f = SystemFonts.DefaultFont;
            if (f?.FontFamily?.Name is string n2 && !string.IsNullOrWhiteSpace(n2))
                return (n2, (int)Math.Round(f.SizeInPoints * 96 / 72));
        }
        catch { }

        return ("", 13);
    }
    static WebView2? _webView;
    static CoreWebView2? _core;
    static Icon? _appIcon;
    static bool _iconTried;

    // 从内嵌资源加载图标（发布为单文件时不能靠外部路径）；找不到就回退到 exe 自带图标
    static Icon? LoadAppIcon()
    {
        if (_iconTried) return _appIcon;
        _iconTried = true;
        try
        {
            var asm = typeof(Program).Assembly;
            using var s = asm.GetManifestResourceStream("wwwroot/app.ico");
            if (s != null) _appIcon = new Icon(s);
        }
        catch { }
        if (_appIcon == null)
        {
            try
            {
                var exe = Environment.ProcessPath;
                if (!string.IsNullOrEmpty(exe)) _appIcon = Icon.ExtractAssociatedIcon(exe);
            }
            catch { }
        }
        return _appIcon;
    }

    static string DataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ApiHealth");

    static string StoreDir => Path.Combine(DataDir, "data");
    static string LogFile => Path.Combine(DataDir, "launch.log");

    [STAThread]
    static void Main()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(StoreDir);
        var webRoot = ExtractWebRoot();
        var sysFont = DetectSystemFont();
        Log($"start v{typeof(Program).Assembly.GetName().Version} webroot={webRoot} sysFont={sysFont.Font} {sysFont.Px}px");

        ApplicationConfiguration.Initialize();
        var form = new Form
        {
            Text = "API 模型健康检测",
            ClientSize = new Size(1360, 900),
            MinimumSize = new Size(1080, 720),
            StartPosition = FormStartPosition.CenterScreen,
            BackColor = Color.FromArgb(10, 14, 19),
            Icon = LoadAppIcon(),          // 标题栏 + 任务栏 + Alt-Tab 图标
        };
        _webView = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(_webView);
        form.FormClosed += (_, _) => Application.Exit();
        form.Load += async (_, _) =>
        {
            ApplyChrome(form.Handle, true);   // 默认深色标题栏；前端切主题时会再同步
            await InitAsync(webRoot);
        };
        Application.Run(form);
    }

    static async Task InitAsync(string webRoot)
    {
        try
        {
            var dev = Environment.GetEnvironmentVariable("APIHEALTH_DEV") == "1";
            // DEV 模式额外开 WebView2 远程调试端口，便于 WSL 里用 CDP 驱动原生窗口做端到端验证
            var extraArgs = "--disable-web-security --allow-running-insecure-content"
                + (dev ? " --remote-debugging-port=9222" : "");
            var opts = new CoreWebView2EnvironmentOptions(extraArgs);
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "webview"), opts);
            await _webView!.EnsureCoreWebView2Async(env);
            _core = _webView.CoreWebView2;

            _core.SetVirtualHostNameToFolderMapping("app.local", webRoot, CoreWebView2HostResourceAccessKind.Allow);
            _core.WebMessageReceived += OnWebMessage;
            _core.NavigationCompleted += (_, e) => Log("ui-loaded " + e.IsSuccess);
            _core.Settings.AreDefaultContextMenusEnabled = dev;
            _core.Settings.IsStatusBarEnabled = false;
            _core.Settings.AreDevToolsEnabled = dev;
            _core.Settings.IsZoomControlEnabled = true;

            _webView.Source = new Uri("https://app.local/index.html");
        }
        catch (Exception ex)
        {
            Log("init-fail " + ex);
            MessageBox.Show(ex.ToString(), "启动失败");
        }
    }

    static void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var id = root.TryGetProperty("id", out var idv) && idv.TryGetInt64(out var idl) ? idl : 0;
            var cmd = root.TryGetProperty("cmd", out var cv) ? cv.GetString() ?? "" : "";
            var name = root.TryGetProperty("name", out var nv) ? nv.GetString() ?? "" : "";
            var data = root.TryGetProperty("data", out var dv) ? dv.GetString() ?? "" : "";

            switch (cmd)
            {
                case "load":
                {
                    var path = StorePath(name);
                    var content = File.Exists(path) ? File.ReadAllText(path) : null;
                    Reply(id, true, content);
                    break;
                }
                case "save":
                {
                    File.WriteAllText(StorePath(name), data);
                    Reply(id, true, null);
                    break;
                }
                case "openDataDir":
                {
                    Directory.CreateDirectory(StoreDir);
                    Process.Start(new ProcessStartInfo { FileName = StoreDir, UseShellExecute = true });
                    Reply(id, true, StoreDir);
                    break;
                }
                case "chrome":
                {
                    // 前端切主题时同步原生窗口装饰（圆角 + 标题栏明暗）
                    if (_webView?.FindForm() is Form f)
                        ApplyChrome(f.Handle, data == "dark");
                    Reply(id, true, null);
                    break;
                }
                case "clipread":
                {
                    // 读系统剪贴板（UI 线程 = STA，解锁重试几次）
                    string? txt = null;
                    for (var i = 0; i < 5 && txt == null; i++)
                    {
                        try { txt = Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
                        catch { Thread.Sleep(60); }
                    }
                    Reply(id, true, txt ?? "");
                    break;
                }
                case "clipwrite":
                {
                    var done = false;
                    for (var i = 0; i < 5 && !done; i++)
                    {
                        try { Clipboard.SetText(data ?? ""); done = true; }
                        catch { Thread.Sleep(60); }
                    }
                    Reply(id, done, null);
                    break;
                }
                case "openUrl":
                {
                    var opened = false;
                    try
                    {
                        if (Uri.TryCreate(data, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))
                        {
                            Process.Start(new ProcessStartInfo { FileName = u.ToString(), UseShellExecute = true });
                            opened = true;
                        }
                    }
                    catch { }
                    Reply(id, opened, null);
                    break;
                }
                case "sysinfo":
                {
                    var (font, px) = DetectSystemFont();
                    var ver = typeof(Program).Assembly.GetName().Version?.ToString() ?? "0";
                    Reply(id, true, JsonSerializer.Serialize(new { font, px, ver }));
                    break;
                }
                case "log":
                {
                    Log("[ui] " + data);
                    Reply(id, true, null);
                    break;
                }
                default:
                    Reply(id, false, null);
                    break;
            }
        }
        catch (Exception ex)
        {
            Log("msg-fail " + ex.Message);
        }
    }

    static string StorePath(string name)
    {
        var clean = new string((name ?? "").Where(ch =>
            char.IsLetterOrDigit(ch) || ch is '.' or '_' or '-').ToArray());
        if (clean.Length == 0) clean = "default";
        if (!clean.Contains('.')) clean += ".json";
        return Path.Combine(StoreDir, clean);
    }

    static void Reply(long id, bool ok, string? data)
    {
        try
        {
            _core?.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, ok, data }));
        }
        catch (Exception ex)
        {
            Log("reply-fail " + ex.Message);
        }
    }

    // 把内嵌的 wwwroot 释放到 %LOCALAPPDATA%\ApiHealth\wwwroot\<版本>\
    static string ExtractWebRoot()
    {
        var ver = typeof(Program).Assembly.GetName().Version?.ToString() ?? "0";
        var dest = Path.Combine(DataDir, "wwwroot", ver);
        var asm = typeof(Program).Assembly;
        foreach (var res in asm.GetManifestResourceNames())
        {
            if (!res.StartsWith("wwwroot/")) continue;
            var rel = res["wwwroot/".Length..];
            var path = Path.Combine(dest, rel.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using var s = asm.GetManifestResourceStream(res)!;
            using var f = File.Create(path);
            s.CopyTo(f);
        }
        return dest;
    }

    static void Log(string msg)
    {
        try
        {
            File.AppendAllText(LogFile,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + msg + Environment.NewLine);
        }
        catch { /* 日志失败不影响主流程 */ }
    }
}