import SwiftUI

@main
struct MentalityApp: App {
    @StateObject private var library = LibraryModel(demo: CommandLine.arguments.contains("--ui-demo") || AutoTest.isHostingUnitTests)

    init() {
        AutoTest.prepareLaunch()   // does nothing outside the automated tests
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(library)
                // "Open in Mentality" from Notability's share sheet or the Files app.
                .onOpenURL { url in library.importFiles([url]) }
        }
    }
}
