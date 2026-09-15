import AppKit
import ImageIO
import SwiftUI

private enum OmeletteTheme {
    static let accent = Color(red: 0.91, green: 0.42, blue: 0.24)
    static let amber = Color(red: 0.95, green: 0.72, blue: 0.29)
    static func canvas(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.14, green: 0.13, blue: 0.12)
            : Color(red: 0.97, green: 0.95, blue: 0.93)
    }
}

struct PopoverView: View {
    @EnvironmentObject var store: VaultStore
    @State private var showAbout = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Everything you copied", systemImage: "square.stack.3d.up.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(OmeletteTheme.accent)
                Spacer()
                Text("\(store.items.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(OmeletteTheme.amber.opacity(0.18), in: Capsule())
            }
            .padding(.horizontal, 4)

            if let captureStatus = store.captureStatus {
                Label(captureStatus, systemImage: "camera.viewfinder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.horizontal, 4)
            }

            if store.items.isEmpty {
                EmptyVaultState()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(store.items) { item in
                            VaultItemRow(item: item)
                                .environmentObject(store)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .frame(maxHeight: .infinity)
            }

            Divider()

            HStack {
                Label("Kept on this Mac, in plain text", systemImage: "tray.full")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Toggle("Pause", isOn: $store.isPaused)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .help("Stop noting things down, without quitting")

                Button {
                    store.captureScreenshot(mode: .interactive)
                } label: {
                    Label("Area", systemImage: "camera.viewfinder")
                }
                .buttonStyle(.borderedProminent)
                .tint(OmeletteTheme.accent)
                .help("Capture an area into Omelette (Control-Option-S)")

                Button {
                    store.captureScreenshot(mode: .fullScreen)
                } label: {
                    Label("Screen", systemImage: "display")
                }
                .buttonStyle(.bordered)
                .tint(OmeletteTheme.accent)
                .help("Capture the screen into Omelette")

                Button("About") { showAbout.toggle() }
                    .buttonStyle(.borderless)
                    .popover(isPresented: $showAbout) { AboutView() }

                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("q")
            }
            .padding(10)
            .background(OmeletteTheme.amber.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(14)
        .background(OmeletteTheme.canvas(colorScheme))
        .frame(width: 620)
        .frame(minHeight: 760, idealHeight: 760, maxHeight: 760)
    }
}

// What this is and what version it is. The version comes out of the bundle
// rather than a constant so it can only ever say what was actually built — note
// that resolves inside the .app only, which is what build.sh assembles.
private struct AboutView: View {
    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    var body: some View {
        VStack(spacing: 8) {
            OmeletteMark()
                .frame(width: 34, height: 34)

            Text("Omelette \(version)")
                .font(.headline)

            Text("Early beta · Built for coding agent workflows.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("MIT licensed")
                .font(.caption)
                .foregroundStyle(.secondary)

            Link("github.com/dfxe/omelette", destination: URL(string: "https://github.com/dfxe/omelette")!)
                .font(.caption)
        }
        .multilineTextAlignment(.center)
        .padding(20)
        .frame(width: 260)
    }
}

private struct EmptyVaultState: View {
    var body: some View {
        GeometryReader { proxy in
            let textWidth = min(max(proxy.size.width - 80, 220), 420)

            VStack(spacing: 12) {
                Spacer(minLength: 24)

                Image(systemName: "tray")
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(.secondary)

                Text("Nothing pinned up yet. Copy anything — text, an image, a file — and it lands here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: textWidth)

                Spacer(minLength: 24)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(minHeight: 420)
    }
}

private struct VaultItemRow: View {
    @EnvironmentObject var store: VaultStore

    let item: VaultItem
    @State private var thumbnail: NSImage?
    @State private var textPreview: String?
    @State private var copied = false

    var body: some View {
        Button {
            store.copyToClipboard(item)
            copied = true
            Task {
                try? await Task.sleep(nanoseconds: 850_000_000)
                copied = false
            }
        } label: {
            HStack(spacing: 10) {
                preview

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Image(systemName: iconName)
                            .foregroundStyle(.secondary)
                            .frame(width: 14)
                        Text(displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                    }

                    HStack(spacing: 6) {
                        Text(item.kind.rawValue.capitalized)
                        Text("·")
                        Text(item.byteCount.formatted(.byteCount(style: .file)))
                        Text("·")
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            Text(relativeAge(from: item.createdAt, to: context.date))
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 6)

                if copied {
                    Image(systemName: "target")
                        .foregroundStyle(OmeletteTheme.accent)
                        .font(.title3)
                } else {
                    Image(systemName: "cursorarrow.click")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(copied ? OmeletteTheme.amber.opacity(0.24) : OmeletteTheme.amber.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(copied ? OmeletteTheme.accent.opacity(0.55) : OmeletteTheme.accent.opacity(0.16), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help("Peel this off for the next ⌘V")
        .task(id: item.id) {
            guard item.kind == .image,
                  let data = store.decryptedData(for: item)
            else {
                if item.kind == .text,
                   let data = store.decryptedData(for: item),
                   let string = String(data: data, encoding: .utf8) {
                    textPreview = Self.previewText(string)
                }
                return
            }

            let cg = await Task.detached(priority: .utility) {
                Self.makeThumbnailCGImage(data: data, maxPixel: 180)
            }.value
            if let cg {
                thumbnail = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
            }
        }
    }

    @ViewBuilder
    private var preview: some View {
        ZStack {
            if item.kind == .image, let thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle().fill(Color.secondary.opacity(0.12))
                Image(systemName: iconName)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 84, height: 60)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(OmeletteTheme.accent.opacity(0.16), lineWidth: 1)
        )
        .overlay(alignment: .topLeading) { tape }
        .rotationEffect(.degrees(tilt))
        // Rotating does not grow the frame, so the tilted corners and the tape
        // need somewhere to go or they clip against the row above.
        .padding(.vertical, 3)
    }

    /// A photo dropped on a desk rather than filed square — images only, since a
    /// tilted placeholder rectangle reads as a rendering fault, not as charm.
    ///
    /// Derived from the first byte of the item's UUID so it is fixed for the
    /// life of the entry. `TimelineView` re-renders this row every 30s to age
    /// the timestamp; anything random here would make the pile twitch.
    private var tilt: Double {
        guard item.kind == .image else { return 0 }
        return item.id.uuid.0.isMultiple(of: 2) ? 1.5 : -1.5
    }

    /// Warm off-white at low alpha rather than a solid, so the one paper
    /// flourish still reads in both light and dark appearance.
    @ViewBuilder
    private var tape: some View {
        if item.kind == .image {
            RoundedRectangle(cornerRadius: 1)
                .fill(OmeletteTheme.amber.opacity(0.62))
                .frame(width: 34, height: 10)
                .rotationEffect(.degrees(-45))
                .offset(x: -8, y: 5)
        }
    }

    private var iconName: String {
        switch item.kind {
        case .text: return "text.alignleft"
        case .image: return "photo"
        case .file: return "doc"
        }
    }

    private var displayTitle: String {
        guard item.kind == .text, let textPreview else { return item.title }
        return textPreview
    }

    private static func previewText(_ text: String) -> String {
        let collapsed = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if collapsed.count <= 84 { return collapsed }
        return String(collapsed.prefix(81)) + "..."
    }

    private func relativeAge(from date: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "\(seconds)s" }

        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }

        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }

        let days = hours / 24
        if days < 7 { return "\(days)d" }

        let weeks = days / 7
        if weeks < 5 { return "\(weeks)w" }

        let months = days / 30
        return "\(max(1, months))mo"
    }

    nonisolated private static func makeThumbnailCGImage(data: Data, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
    }
}
