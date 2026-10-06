import CodexBridgeKit
import Foundation

/// Editor state retains exact pairs, including mixed and temporarily unavailable choices.
struct ModelAllowlistDraft: Equatable {
    var modelIDs: Set<String>
    private(set) var commonEfforts: Set<String>
    private var memory: Set<ModelChoice>

    init(selections: [ModelChoice], choices: [ModelChoice]) {
        let models = Set(selections.map(\.model)), saved = Set(selections)
        modelIDs = models
        memory = saved
        commonEfforts = Set(selections.map(\.reasoningEffort).filter {
            Self.effortState(models: models, effort: $0, choices: choices, selected: saved).checked
        })
    }

    var selections: Set<ModelChoice> { memory.filter { modelIDs.contains($0.model) } }

    func effortState(_ effort: String, choices: [ModelChoice]) -> (checked: Bool, mixed: Bool, supportedModels: Int) {
        let state = Self.effortState(models: modelIDs, effort: effort, choices: choices, selected: selections)
        let retained = selections.contains { $0.reasoningEffort == effort }
        return (state.checked || (state.supportedModels == 0 && (commonEfforts.contains(effort) || retained)), state.mixed, state.supportedModels)
    }

    var retainedEfforts: Set<String> { commonEfforts.union(selections.map(\.reasoningEffort)) }

    func hasModelSpecificChoices(choices: [ModelChoice]) -> Bool {
        let efforts = Set(selections.map(\.reasoningEffort))
        return Set(choices.filter { modelIDs.contains($0.model) && efforts.contains($0.reasoningEffort) }) != selections
    }

    mutating func setModel(_ id: String, selected: Bool, choices: [ModelChoice]) {
        if selected {
            if !modelIDs.isEmpty {
                commonEfforts = Set(retainedEfforts.filter { effortState($0, choices: choices).checked })
            }
            modelIDs.insert(id)
            if !memory.contains(where: { $0.model == id }) {
                memory.formUnion(choices.filter { $0.model == id && commonEfforts.contains($0.reasoningEffort) })
            }
        } else { modelIDs.remove(id) }
    }

    mutating func setEffort(_ effort: String, selected: Bool, choices: [ModelChoice]) {
        if selected {
            commonEfforts.insert(effort)
            memory.formUnion(choices.filter { modelIDs.contains($0.model) && $0.reasoningEffort == effort })
        } else {
            commonEfforts.remove(effort)
            memory = memory.filter { !modelIDs.contains($0.model) || $0.reasoningEffort != effort }
        }
    }

    mutating func setChoice(_ choice: ModelChoice, selected: Bool, choices: [ModelChoice]) {
        if selected { memory.insert(choice) } else { memory.remove(choice) }
        commonEfforts = Set(selections.map(\.reasoningEffort).filter {
            Self.effortState(models: modelIDs, effort: $0, choices: choices, selected: selections).checked
        })
    }

    private static func effortState(models: Set<String>, effort: String, choices: [ModelChoice], selected: Set<ModelChoice>)
        -> (checked: Bool, mixed: Bool, supportedModels: Int) {
        let candidates = Set(choices.filter { models.contains($0.model) && $0.reasoningEffort == effort })
        let count = candidates.intersection(selected).count
        return (!candidates.isEmpty && count == candidates.count, count > 0 && count < candidates.count,
                Set(candidates.map(\.model)).count)
    }
}

enum ModelSettingsOrder {
    static func ids(catalog: [CatalogModel], retained: Set<String>) -> [String] {
        var seen = Set<String>()
        let visible = catalog.filter { $0.hidden != true }.map(\.id).filter { seen.insert($0).inserted }
        return visible + retained.subtracting(seen).sorted()
    }

    static func efforts(_ values: Set<String>) -> [String] {
        let known = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        return known.filter { values.contains($0) } + values.subtracting(known).sorted()
    }
}
