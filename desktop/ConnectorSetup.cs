using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace Notakillite.Desktop;
public sealed class ConnectorSetup : Window
{
    public ConnectorSetup(JsonElement browser, CoreClient core)
    {
        Title = "Set up regular Brave"; Width = 600; Height = 670; MinWidth = 500; MinHeight = 580; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Style = (Style)System.Windows.Application.Current.FindResource("AppWindowStyle");
        var panel = new StackPanel { Margin = new Thickness(27) };
        Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        panel.Children.Add(new TextBlock { Text = "Connect your usual Brave profile", FontSize = 23, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = "Set this up once. Your Notability sign-in stays in Brave across app exits, computer restarts, and app updates while the website session is valid.", Margin = new Thickness(0, 13, 0, 17), TextWrapping = TextWrapping.Wrap, LineHeight = 23 });
        panel.Children.Add(new TextBlock { Text = "Brave profile", FontWeight = FontWeights.SemiBold });
        var profiles = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var profile in browser.Get("profiles").Rows()) { var item = new ComboBoxItem { Content = profile.Text("label"), Tag = profile.Text("directory") }; profiles.Items.Add(item); if (profile.Text("directory") == browser.Text("profileDirectory")) profiles.SelectedItem = item; }
        if (profiles.SelectedIndex < 0 && profiles.Items.Count > 0) profiles.SelectedIndex = 0;
        panel.Children.Add(profiles);
        var label = new TextBlock { Text = "Local connector setup", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 12, 0, 6) }; panel.Children.Add(label);
        panel.Children.Add(new TextBlock { Text = "This local build needs one manual installation. Type brave://extensions in Brave’s address bar. Turn on Developer mode, choose Load unpacked, then select the folder below. This app does not change Developer mode automatically. Store publication is pending.", TextWrapping = TextWrapping.Wrap, LineHeight = 22 });
        var directory = new TextBox { Text = ConnectorInstall.ExtensionDirectory, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 13, 0, 9), FontSize = 12 };
        panel.Children.Add(directory);
        var status = new TextBlock { Text = "After installation, press Connect. Keep Notability’s site data when closing Brave so its session can be retained.", TextWrapping = TextWrapping.Wrap, LineHeight = 21, Margin = new Thickness(0, 14, 0, 13) };
        var actions = new WrapPanel();
        var open = new Button { Content = "1. Open Brave extensions" }; var copy = new Button { Content = "Copy folder path" }; var connect = new Button { Content = "2. Connect", Style = (Style)System.Windows.Application.Current.FindResource("PrimaryButton") };
        async Task ChooseProfile() { if (profiles.SelectedItem is ComboBoxItem item) await core.Request("browserProfile", new { directory = item.Tag.ToString() }); }
        open.Click += async (_, _) => { try { await ChooseProfile(); await core.Request("openExtensions"); status.Text = "If Brave opens a blank tab, type brave://extensions in its address bar. Install Notakillite Brave Connector before pressing Connect."; } catch (Exception error) { status.Text = error.Message; } };
        copy.Click += (_, _) => System.Windows.Clipboard.SetText(ConnectorInstall.ExtensionDirectory);
        connect.Click += async (_, _) => {
            connect.IsEnabled = false; status.Text = "Connecting to this regular Brave profile…";
            try { await ChooseProfile(); var result = await core.Request("connect"); status.Text = result.Text("detail"); if (result.Get("browser").Text("profileId").Length > 0) { DialogResult = true; Close(); } }
            catch (Exception error) { status.Text = error.Message; }
            finally { connect.IsEnabled = true; }
        };
        actions.Children.Add(open); actions.Children.Add(copy); panel.Children.Add(actions); panel.Children.Add(status); panel.Children.Add(connect);
    }
}
