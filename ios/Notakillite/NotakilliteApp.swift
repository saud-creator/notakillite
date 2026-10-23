import SwiftUI

@main
struct NotakilliteApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                // "Open in Notakillite" from Notability's share sheet or the Files app.
                .onOpenURL { url in model.importFiles([url]) }
        }
    }
}
