import XCTest
@testable import CodexBridgeKit
@testable import CodexBridgeMenuBar

final class ModelAllowlistDraftTests: XCTestCase {
    private let choices = [
        ModelChoice(model: "new", reasoningEffort: "low"),
        ModelChoice(model: "new", reasoningEffort: "high"),
        ModelChoice(model: "new", reasoningEffort: "ultra"),
        ModelChoice(model: "older", reasoningEffort: "low"),
        ModelChoice(model: "older", reasoningEffort: "high")
    ]

    func testExistingMixedChoicesArePreservedUntilAnExplicitCommonSelection() {
        let saved = [choices[1], choices[3]]
        var draft = ModelAllowlistDraft(selections: saved, choices: choices)
        XCTAssertEqual(draft.selections, Set(saved))
        XCTAssertTrue(draft.hasModelSpecificChoices(choices: choices))
        XCTAssertTrue(draft.effortState("high", choices: choices).mixed)
        XCTAssertFalse(draft.effortState("high", choices: choices).checked)
        draft.setEffort("high", selected: true, choices: choices)
        XCTAssertEqual(draft.selections, Set(saved + [choices[4]]))
        XCTAssertTrue(draft.effortState("high", choices: choices).checked)
        draft.setEffort("low", selected: false, choices: choices)
        XCTAssertEqual(draft.selections, Set([choices[1], choices[4]]))
        XCTAssertFalse(draft.hasModelSpecificChoices(choices: choices))
    }

    func testNewModelUsesCommonEffortsAndOnlySupportedPairs() {
        var draft = ModelAllowlistDraft(selections: [choices[1], choices[2]], choices: choices)
        draft.setModel("older", selected: true, choices: choices)
        XCTAssertEqual(draft.selections, Set([choices[1], choices[2], choices[4]]))
        XCTAssertEqual(draft.effortState("ultra", choices: choices).supportedModels, 1)
        draft.setModel("new", selected: false, choices: choices)
        XCTAssertEqual(draft.selections, Set([choices[4]]))
        draft.setModel("new", selected: true, choices: choices)
        XCTAssertEqual(draft.selections, Set([choices[1], choices[2], choices[4]]))
    }

    func testRemovedChoicesRemainAvailableForDeliberateRemoval() {
        let removed = ModelChoice(model: "removed", reasoningEffort: "retired")
        var draft = ModelAllowlistDraft(selections: [choices[1], removed], choices: choices)
        XCTAssertEqual(draft.selections, Set([choices[1], removed]))
        XCTAssertTrue(draft.effortState("retired", choices: choices).checked)
        XCTAssertTrue(draft.hasModelSpecificChoices(choices: choices))
        draft.setModel("removed", selected: false, choices: choices)
        XCTAssertEqual(draft.selections, Set([choices[1]]))
        XCTAssertEqual(ModelSettingsOrder.efforts(["ultra", "high", "low", "future"]), ["low", "high", "ultra", "future"])
    }

    func testNewModelUsesTheCurrentlyDisplayedCommonEffortAfterRemovingAnException() {
        let added = ModelChoice(model: "added", reasoningEffort: "high")
        let supported = choices + [added]
        var draft = ModelAllowlistDraft(selections: [choices[1], choices[3]], choices: supported)
        draft.setModel("older", selected: false, choices: supported)
        XCTAssertTrue(draft.effortState("high", choices: supported).checked)
        draft.setModel("added", selected: true, choices: supported)
        XCTAssertEqual(draft.selections, Set([choices[1], added]))
        draft.setModel("older", selected: true, choices: supported)
        XCTAssertEqual(draft.selections, Set([choices[1], choices[3], added]))
        XCTAssertTrue(draft.effortState("high", choices: supported).mixed)
    }

    func testDescriptionOrderingUsesCatalogAndAppendsRemovedModels() throws {
        let catalog = try JSONDecoder().decode([CatalogModel].self, from: Data("""
            [{"id":"gpt-6.1","displayName":"New","supportedReasoningEfforts":[],"serviceTiers":[],"inputModalities":[]},
             {"id":"gpt-5.6","displayName":"Older","supportedReasoningEfforts":[],"serviceTiers":[],"inputModalities":[]}]
            """.utf8))
        XCTAssertEqual(ModelSettingsOrder.ids(catalog: catalog, retained: ["retired-b", "gpt-5.6", "retired-a"]),
            ["gpt-6.1", "gpt-5.6", "retired-a", "retired-b"])
    }
}
