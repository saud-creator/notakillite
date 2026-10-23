using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;

namespace Notakillite.Desktop;

/// <summary>Stores the user's Groq API key encrypted for the current Windows user (DPAPI).</summary>
public static class GroqKey
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Notakillite.Groq.v1");
    private static string FilePath => Path.Combine(App.DataDirectory, "data", "groq-key.bin");
    public static string Load()
    {
        try { return File.Exists(FilePath) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(FilePath), Entropy, DataProtectionScope.CurrentUser)) : ""; }
        catch { return ""; }
    }
    public static void Save(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) { if (File.Exists(FilePath)) File.Delete(FilePath); return; }
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllBytes(FilePath, ProtectedData.Protect(Encoding.UTF8.GetBytes(key.Trim()), Entropy, DataProtectionScope.CurrentUser));
    }
}

public sealed class GroqKeyDialog : Window
{
    public string Key { get; private set; } = "";
    public GroqKeyDialog(bool hasKey)
    {
        Title = "Groq API key"; Width = 520; SizeToContent = SizeToContent.Height; ResizeMode = ResizeMode.NoResize; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Style = (Style)System.Windows.Application.Current.FindResource("AppWindowStyle");
        var panel = new StackPanel { Margin = new Thickness(24) };
        Content = panel;
        panel.Children.Add(new TextBlock { Text = "Groq cloud transcription", FontSize = 20, FontWeight = FontWeights.SemiBold });
        var intro = new TextBlock { TextWrapping = TextWrapping.Wrap, LineHeight = 21, Margin = new Thickness(0, 10, 0, 14) };
        intro.Inlines.Add("Groq runs Whisper large-v3 very fast with a free daily allowance. Your lecture audio is uploaded to Groq when you choose this engine. Create a free key at ");
        var link = new Hyperlink(new Run("console.groq.com/keys")) { NavigateUri = new Uri("https://console.groq.com/keys") };
        link.RequestNavigate += (_, e) => { Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); e.Handled = true; };
        intro.Inlines.Add(link); intro.Inlines.Add(", then paste it here. It is stored encrypted for your Windows account only.");
        panel.Children.Add(intro);
        var box = new PasswordBox { MinHeight = 34, Margin = new Thickness(0, 0, 0, 14) };
        System.Windows.Automation.AutomationProperties.SetName(box, "Groq API key");
        panel.Children.Add(box);
        var actions = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Right };
        var remove = new Button { Content = "Remove key", Visibility = hasKey ? Visibility.Visible : Visibility.Collapsed, Margin = new Thickness(0, 0, 8, 0) };
        var cancel = new Button { Content = "Cancel", IsCancel = true, Margin = new Thickness(0, 0, 8, 0) };
        var save = new Button { Content = "Save key", IsDefault = true, Style = (Style)System.Windows.Application.Current.FindResource("PrimaryButton") };
        remove.Click += (_, _) => { Key = ""; DialogResult = true; };
        save.Click += (_, _) => { if (box.Password.Trim().Length < 20) { box.Focus(); return; } Key = box.Password.Trim(); DialogResult = true; };
        actions.Children.Add(remove); actions.Children.Add(cancel); actions.Children.Add(save);
        panel.Children.Add(actions);
        Loaded += (_, _) => box.Focus();
    }
}
