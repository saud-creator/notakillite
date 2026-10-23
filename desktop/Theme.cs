using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace Notakillite.Desktop;
public static class Theme
{
    public static void Apply(string mode)
    {
        bool light = mode == "light";
        if (mode == "system") { using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"); light = (int?)(key?.GetValue("AppsUseLightTheme")) != 0; }
#pragma warning disable WPF0001
        System.Windows.Application.Current.ThemeMode = mode == "system" ? ThemeMode.System : light ? ThemeMode.Light : ThemeMode.Dark;
#pragma warning restore WPF0001
        string[] keys = ["BackgroundBrush","SidebarBrush","PanelBrush","RaisedBrush","HoverBrush","SelectedBrush","TextBrush","MutedBrush","AccentBrush","AccentInkBrush","LineBrush","ControlLineBrush","SuccessBrush","ErrorBrush","WarningBrush"];
        string[] colors = light ? ["#FFFFFF","#F3F4F8","#FAFAFF","#EEEFF6","#E7E9F2","#EEE8FF","#202637","#526078","#6246B1","#FFFFFF","#C5CBDA","#7C879D","#176B54","#A22B41","#805A17"] : ["#171B24","#12151D","#1C212D","#242B39","#272E3E","#302A48","#F2F4F9","#B0BBCE","#BCADFF","#241B42","#343E50","#667187","#8BDCC4","#FFB4BC","#F1CE88"];
        for (int index = 0; index < keys.Length; index++) System.Windows.Application.Current.Resources[keys[index]] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(colors[index]));
        if (SystemParameters.HighContrast) {
            var resources = System.Windows.Application.Current.Resources;
            foreach (var key in new[] { "BackgroundBrush", "SidebarBrush", "PanelBrush", "RaisedBrush", "HoverBrush" }) resources[key] = SystemColors.WindowBrush;
            foreach (var key in new[] { "TextBrush", "MutedBrush", "ControlLineBrush", "LineBrush" }) resources[key] = SystemColors.WindowTextBrush;
            resources["AccentBrush"] = SystemColors.HighlightBrush; resources["SelectedBrush"] = SystemColors.HighlightBrush; resources["AccentInkBrush"] = SystemColors.HighlightTextBrush;
        }
    }
}
