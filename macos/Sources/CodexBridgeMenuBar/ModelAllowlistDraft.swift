import CodexBridgeKit
import Foundation

/// Models share one effort list; only supported exact pairs reach the policy.
struct ModelAllowlistDraft: Equatable {
    var modelIDs: Set<String>
    private(set) var commonEfforts: Set<String>

    init(selections: [ModelChoice]) {
        modelIDs = Set(selections.map(\.model))
        commonEfforts = Set(selections.map(\.reasoningEffort))
    }

    func selections(choices: [ModelChoice]) -> Set<ModelChoice> {
        Set(choices.filter { modelIDs.contains($0.model) && commonEfforts.contains($0.reasoningEffort) })
    }

    func availableEfforts(choices: [ModelChoice]) -> [String] {
        ModelSettingsOrder.efforts(Set(choices.filter { modelIDs.contains($0.model) }.map(\.reasoningEffort)))
    }

    func unsupportedEfforts(for model: String, catalogChoices: [ModelChoice]) -> [String] {
        let supported = Set(catalogChoices.filter { $0.model == model }.map(\.reasoningEffort))
        return ModelSettingsOrder.efforts(commonEfforts.subtracting(supported))
    }

    mutating func setModel(_ id: String, selected: Bool, choices: [ModelChoice]) {
        if selected { modelIDs.insert(id) } else { modelIDs.remove(id) }
        commonEfforts.formIntersection(availableEfforts(choices: choices))
    }

    mutating func setEffort(_ effort: String, selected: Bool) {
        if selected { commonEfforts.insert(effort) } else { commonEfforts.remove(effort) }
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
