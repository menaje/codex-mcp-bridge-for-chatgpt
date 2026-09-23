import CodexBridgeKit
import Foundation
import SwiftUI

struct ModelDescriptionEdit: Equatable {
    static let maximumLength = 2_000
    var text: String
    var expectedOverride: String?
    private let initialText: String
    private let initialOverride: String?

    init(officialDescription: String?, override: String?) {
        text = override ?? officialDescription ?? ""
        initialText = text
        initialOverride = override
        expectedOverride = override
    }

    var isTooLong: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > Self.maximumLength }

    func valueToSave(officialDescription: String?) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Opening and saving untouched official text must not freeze a catalog snapshot.
        if trimmed == initialText.trimmingCharacters(in: .whitespacesAndNewlines) { return initialOverride }
        if trimmed.isEmpty || trimmed == officialDescription?.trimmingCharacters(in: .whitespacesAndNewlines) { return nil }
        return trimmed
    }
}

struct ModelDescriptionsSettingsSection: View {
    let snapshot: SettingsSnapshot
    @State private var edits: [String: ModelDescriptionEdit] = [:]

    private var models: [String: CatalogModel] {
        snapshot.catalog.models.filter { $0.hidden != true }.reduce(into: [:]) { result, model in
            result[model.id] = model
        }
    }

    private var modelIDs: [String] {
        Set(models.keys)
            .union(snapshot.settings.modelDescriptionOverrides?.keys.map { $0 } ?? [])
            .union(snapshot.modelDescriptionHistoryModelIds ?? [])
            .union(edits.keys)
            .sorted()
    }

    var body: some View {
        Section("settings.modelDescriptions.title") {
            Text("settings.modelDescriptions.hint")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(modelIDs, id: \.self) { id in
                ModelDescriptionSettingsRow(
                    modelID: id,
                    catalogModel: models[id],
                    override: snapshot.settings.modelDescriptionOverrides?[id],
                    historyAvailable: snapshot.modelDescriptionHistoryModelIds != nil,
                    edit: Binding(get: { edits[id] }, set: { edits[id] = $0 })
                )
            }
        }
    }
}

private struct ModelDescriptionSettingsRow: View {
    @EnvironmentObject private var model: AppModel
    let modelID: String
    let catalogModel: CatalogModel?
    let override: String?
    let historyAvailable: Bool
    @Binding var edit: ModelDescriptionEdit?
    @State private var officialExpanded = false
    @State private var failed = false
    @State private var historyOpen = false
    @State private var historyVersions: [ModelDescriptionVersion] = []
    @State private var nextHistoryVersion: Int?
    @State private var historyLoaded = false
    @State private var historyLoading = false
    @State private var historyError: String?
    @State private var historyRequestGeneration = 0

    private var busy: Bool { model.isBusy || model.generalSettingsSaveState.isActive }
    private var officialText: String {
        catalogModel?.description ?? BridgeAppLocalization.string("settings.modelDescriptions.empty", locale: model.interfaceLocale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(catalogModel?.displayName ?? modelID)
                    .font(.headline)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Text(BridgeAppLocalization.string(override == nil ? "settings.modelDescriptions.official" : "settings.modelDescriptions.user", locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if edit == nil {
                    Button("macos.edit") {
                        edit = ModelDescriptionEdit(officialDescription: catalogModel?.description, override: override)
                        failed = false
                    }
                    .disabled(busy)
                }
            }
            if catalogModel == nil {
                Text("settings.modelDescriptions.unavailable")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let currentEdit = edit {
                if failed {
                    Text(override ?? officialText)
                        .font(.caption)
                        .textSelection(.enabled)
                }
                TextEditor(text: Binding(get: { edit?.text ?? "" }, set: { edit?.text = $0 }))
                    .font(.body)
                    .frame(minHeight: 90, maxHeight: 180)
                    .padding(5)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .accessibilityLabel(BridgeAppLocalization.string("settings.modelDescriptions.label", locale: model.interfaceLocale))
                    .disabled(busy)
                Text("settings.modelDescriptions.limit")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if currentEdit.isTooLong {
                    Text("settings.modelDescriptions.tooLong")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                HStack {
                    Button("settings.modelDescriptions.save") {
                        Task {
                            let saved = await model.saveModelDescription(
                                modelID: modelID,
                                description: currentEdit.valueToSave(officialDescription: catalogModel?.description),
                                expectedOverride: currentEdit.expectedOverride
                            )
                            if saved {
                                edit = nil; failed = false
                                if historyOpen { await loadHistory() }
                            }
                            else {
                                failed = true
                                edit?.expectedOverride = model.settings?.settings.modelDescriptionOverrides?[modelID]
                            }
                        }
                    }
                    .disabled(busy || currentEdit.isTooLong)
                    Button("common.cancel") { edit = nil; failed = false }
                        .disabled(busy)
                }
            } else {
                Text(override ?? officialText)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            if override != nil || edit != nil {
                FullRowDisclosure("settings.modelDescriptions.compare", isExpanded: $officialExpanded) {
                    Text(officialText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 4)
                }
                .font(.caption)
            }
            if override != nil, edit == nil {
                Button("settings.modelDescriptions.restore") {
                    Task {
                        failed = !(await model.saveModelDescription(modelID: modelID, description: nil, expectedOverride: override))
                        if !failed, historyOpen { await loadHistory() }
                    }
                }
                .disabled(busy)
            }
            if historyAvailable {
                Button("settings.modelDescriptions.history") {
                    historyOpen.toggle()
                    if historyOpen { Task { await loadHistory() } }
                }
                .disabled(busy)
                if historyOpen {
                    VStack(alignment: .leading, spacing: 8) {
                        if historyLoading { ProgressView().controlSize(.small) }
                        if let historyError {
                            Text(historyError).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                        }
                        if historyLoaded && historyVersions.isEmpty {
                            Text("settings.modelDescriptions.historyEmpty")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(historyVersions) { version in
                            DisclosureGroup(historyTitle(version)) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("settings.modelDescriptions.historyVersionText")
                                        .font(.caption).bold()
                                    Text(version.description ?? BridgeAppLocalization.string(
                                        "settings.modelDescriptions.official", locale: model.interfaceLocale
                                    ))
                                        .textSelection(.enabled)
                                    Text("settings.modelDescriptions.historyCurrent")
                                        .font(.caption).bold()
                                    Text(override ?? officialText).textSelection(.enabled)
                                    Text("settings.modelDescriptions.official")
                                        .font(.caption).bold()
                                    Text(officialText).textSelection(.enabled)
                                    if edit == nil && version.description != override {
                                        Button("settings.modelDescriptions.historyApply") {
                                            Task {
                                                failed = !(await model.saveModelDescription(
                                                    modelID: modelID,
                                                    description: version.description,
                                                    expectedOverride: override
                                                ))
                                                if !failed { await loadHistory() }
                                            }
                                        }
                                        .disabled(busy)
                                    }
                                }
                                .font(.caption)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 4)
                            }
                        }
                        if nextHistoryVersion != nil {
                            Button("settings.modelDescriptions.historyMore") {
                                Task { await loadHistory(append: true) }
                            }
                            .disabled(busy || historyLoading)
                        }
                    }
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.25)))
                }
            }
            if failed, let message = model.settingsErrorMessage {
                Text(message).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .padding(.vertical, 6)
    }

    private func historyTitle(_ version: ModelDescriptionVersion) -> String {
        let label = BridgeAppLocalization.string(
            "settings.modelDescriptions.historyVersion", locale: model.interfaceLocale
        ) + " \(version.version)"
        let preview = version.description.map { String($0.prefix(80)) } ?? BridgeAppLocalization.string(
            "settings.modelDescriptions.official", locale: model.interfaceLocale
        )
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let value = version.createdAt,
              let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else {
            return label + " · " + BridgeAppLocalization.string(
                "settings.modelDescriptions.historyImported", locale: model.interfaceLocale
            ) + " · " + preview
        }
        return label + " · " + date.formatted(date: .abbreviated, time: .shortened) + " · " + preview
    }

    private func loadHistory(append: Bool = false) async {
        if append && (historyLoading || nextHistoryVersion == nil) { return }
        historyRequestGeneration += 1
        let generation = historyRequestGeneration
        historyLoading = true
        historyError = nil
        do {
            let page = try await model.modelDescriptionHistory(
                modelID: modelID,
                beforeVersion: append ? nextHistoryVersion : nil
            )
            guard generation == historyRequestGeneration else { return }
            guard page.kind == "model-description-history", page.modelId == modelID else {
                throw NSError(domain: "MODEL_DESCRIPTION_HISTORY_INVALID", code: 1)
            }
            historyVersions = append ? historyVersions + page.versions : page.versions
            nextHistoryVersion = page.nextBeforeVersion
            historyLoaded = true
        } catch {
            guard generation == historyRequestGeneration else { return }
            historyError = error.localizedDescription
        }
        historyLoading = false
    }
}
