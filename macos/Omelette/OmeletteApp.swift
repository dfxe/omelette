import SwiftUI

@main
struct OmeletteApp: App {
    @StateObject private var store: VaultStore
    private let clipboardOverride: ClipboardOverrideController

    init() {
        let store = VaultStore()
        _store = StateObject(wrappedValue: store)
        clipboardOverride = ClipboardOverrideController(store: store)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environmentObject(store)
        } label: {
            OmeletteMark()
                .frame(width: 18, height: 18)
        }
        .menuBarExtraStyle(.window)
    }
}
