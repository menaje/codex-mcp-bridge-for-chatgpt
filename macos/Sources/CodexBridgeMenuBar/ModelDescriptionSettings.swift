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
            .union(edits.keys)
            .sorted()
    }

    var body: some View {
        Section("모델 설명") {
            Text("자동 모드에서 GPT가 모델을 선택할 때 참고하는 설명입니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(modelIDs, id: \.self) { id in
                ModelDescriptionSettingsRow(
                    modelID: id,
                    catalogModel: models[id],
                    override: snapshot.settings.modelDescriptionOverrides?[id],
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
    @Binding var edit: ModelDescriptionEdit?
    @State private var officialExpanded = false
    @State private var failed = false

    private var busy: Bool { model.isBusy || model.generalSettingsSaveState.isActive }
    private var officialText: String {
        catalogModel?.description ?? BridgeAppLocalization.string("제공된 공식 설명이 없습니다.", locale: model.interfaceLocale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(catalogModel?.displayName ?? modelID)
                    .font(.headline)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Text(BridgeAppLocalization.string(override == nil ? "공식 설명" : "사용자 설명", locale: model.interfaceLocale))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if edit == nil {
                    Button("수정") {
                        edit = ModelDescriptionEdit(officialDescription: catalogModel?.description, override: override)
                        failed = false
                    }
                    .disabled(busy)
                }
            }
            if catalogModel == nil {
                Text("현재 카탈로그에 없는 모델입니다. 사용자 설명은 보관됩니다.")
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
                    .accessibilityLabel(BridgeAppLocalization.string("설명", locale: model.interfaceLocale))
                    .disabled(busy)
                Text("최대 2,000자. 비우면 공식 설명을 사용합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if currentEdit.isTooLong {
                    Text("설명은 2,000자 이내로 입력해 주세요.")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                HStack {
                    Button("설명 저장") {
                        Task {
                            let saved = await model.saveModelDescription(
                                modelID: modelID,
                                description: currentEdit.valueToSave(officialDescription: catalogModel?.description),
                                expectedOverride: currentEdit.expectedOverride
                            )
                            if saved { edit = nil; failed = false }
                            else {
                                failed = true
                                edit?.expectedOverride = model.settings?.settings.modelDescriptionOverrides?[modelID]
                            }
                        }
                    }
                    .disabled(busy || currentEdit.isTooLong)
                    Button("취소") { edit = nil; failed = false }
                        .disabled(busy)
                }
            } else {
                Text(override ?? officialText)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            if override != nil || edit != nil {
                DisclosureGroup("공식 설명 보기", isExpanded: $officialExpanded) {
                    Text(officialText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.vertical, 4)
                }
                .font(.caption)
            }
            if override != nil, edit == nil {
                Button("공식 설명으로 복원") {
                    Task {
                        failed = !(await model.saveModelDescription(modelID: modelID, description: nil, expectedOverride: override))
                    }
                }
                .disabled(busy)
            }
            if failed, let message = model.settingsErrorMessage {
                Text(message).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .padding(.vertical, 6)
    }
}
