import AppKit
import SwiftUI

// Physical IME acceptance uses the production session and native adapters.
// Synthetic drafts and local receipts only; no bridge, credentials or disk writes.
@main
struct NativeInputAcceptance: App {
    var body: some Scene {
        WindowGroup("Bridge Input Acceptance") { AcceptanceView() }
        .defaultSize(width: 900, height: 660)
    }
}

private struct AcceptanceView: View {
    @StateObject private var input = BridgeEditSession(target: "physical-ime", values: [.name: "", .path: "", .content: "", .apiKey: "", .number: "4"], policies: [.number: .integer(1...12)])
    @StateObject private var search = BridgeEditSession(target: "physical-search", values: [.query: ""])
    @State private var tick = 0
    @State private var source = ""
    @State private var receipt = "No submission"
    @State private var submissions = 0
    @State private var baselineField = ""
    @State private var baselineEditor = ""
    @State private var nativeMarked = false
    private var sourceHash: String { Bundle.main.object(forInfoDictionaryKey: "BridgeAcceptanceSourceHash") as? String ?? "unknown" }
    private let refresh = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationSplitView {
            BridgeSearchField(text: search.binding(.query), prompt: "Search")
                .bridgeSearchInput(search)
                .padding(10)
            VStack(alignment: .leading) {
                Text("Committed search: \(search.searchValue)")
                Text("Synthetic drafts only")
            }.padding()
        } detail: {
            VStack(alignment: .leading, spacing: 12) {
                Text("Input source: \(source)").textSelection(.enabled)
                Text(verbatim: "Source: \(sourceHash)").font(.caption2).textSelection(.enabled)
                Text(verbatim: "Refresh \(tick); marked \(input.hasMarkedText); native marked \(nativeMarked); dirty \(input.isDirty); submissions \(submissions)")
                TextField("Name (normalized)", text: input.binding(.name)).bridgeInput(input, field: .name)
                TextField("Verbatim single line", text: input.binding(.path)).textFieldStyle(.roundedBorder).bridgeInput(input, field: .path)
                SecureField("Synthetic secret", text: input.binding(.apiKey)).bridgeInput(input, field: .apiKey)
                TextField("Number (1–12)", text: input.binding(.number)).bridgeInput(input, field: .number)
                BridgeTextEditor(text: input.binding(.content)).bridgeInput(input, field: .content)
                    .frame(minHeight: 170).border(.secondary)
                BridgeEditStatus(session: input)
                HStack {
                    Button("Save") { submit() }.keyboardShortcut("s", modifiers: .command)
                    Button("Submit with Return") { submit() }.keyboardShortcut(.defaultAction)
                    Button("Clear drafts") { input.discard(); search.discard() }
                }
                TextField("Baseline SwiftUI field", text: $baselineField)
                BridgeTextEditor(text: $baselineEditor).frame(height: 55).border(.secondary)
                Text(receipt).textSelection(.enabled).font(.system(.body, design: .monospaced))
            }.padding()
        }
        .onReceive(refresh) { _ in
            tick += 1
            let editor = NSApp.keyWindow?.firstResponder as? NSTextView
            source = editor?.inputContext?.selectedKeyboardInputSource ?? "unfocused"
            nativeMarked = editor?.hasMarkedText() == true
        }
    }

    private func submit() {
        guard let snapshot = input.prepareSubmission() else { return }
        submissions += 1
        receipt = "Submitted name=[\(snapshot.value(.name))] line=[\(snapshot.value(.path))] document=[\(snapshot.value(.content))]"
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(800))
            guard input.accepts(snapshot) else { return }
            let clean = input.acknowledge(snapshot)
            receipt += "\nConfirmed; newer draft retained: \(!clean)"
        }
    }
}
