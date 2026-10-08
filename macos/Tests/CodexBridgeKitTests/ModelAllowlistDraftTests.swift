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

    func testExistingModelSpecificChoicesBecomeOneCommonEffortList() {
        let saved = [choices[1], choices[3]]
        let draft = ModelAllowlistDraft(selections: saved)
        XCTAssertEqual(draft.commonEfforts, ["low", "high"])
        XCTAssertEqual(draft.selections(choices: choices), Set([choices[0], choices[1], choices[3], choices[4]]))
        XCTAssertEqual(draft.availableEfforts(choices: choices), ["low", "high", "ultra"])
    }

    func testModelChangesNeverRestoreAPerModelEffortException() {
        var draft = ModelAllowlistDraft(selections: [choices[1], choices[3]])
        draft.setEffort("low", selected: false)
        draft.setModel("older", selected: false, choices: choices)
        draft.setModel("older", selected: true, choices: choices)
        XCTAssertEqual(draft.commonEfforts, ["high"])
        XCTAssertEqual(draft.selections(choices: choices), Set([choices[1], choices[4]]))
        let added = ModelChoice(model: "added", reasoningEffort: "high")
        draft.setModel("added", selected: true, choices: choices + [added])
        XCTAssertEqual(draft.selections(choices: choices + [added]), Set([choices[1], choices[4], added]))
    }

    func testUnsupportedEffortsAreHiddenAndExplainedWithoutCreatingInvalidPairs() {
        var draft = ModelAllowlistDraft(selections: [choices[2]])
        draft.setModel("older", selected: true, choices: choices)
        XCTAssertEqual(draft.selections(choices: choices), [choices[2]])
        XCTAssertEqual(draft.unsupportedEfforts(for: "older", catalogChoices: choices), ["ultra"])
        draft.setModel("new", selected: false, choices: choices)
        XCTAssertEqual(draft.availableEfforts(choices: choices), ["low", "high"])
        XCTAssertTrue(draft.selections(choices: choices).isEmpty)
        XCTAssertFalse(draft.commonEfforts.contains("ultra"))
        draft.setModel("new", selected: true, choices: choices)
        draft.setEffort("ultra", selected: true)
        draft.setEffort("high", selected: true)
        XCTAssertEqual(draft.selections(choices: choices), Set([choices[1], choices[2], choices[4]]))
    }

    func testRemovedCatalogChoicesAreNeverProjectedIntoThePolicy() {
        let removed = ModelChoice(model: "removed", reasoningEffort: "retired")
        var draft = ModelAllowlistDraft(selections: [choices[1], removed])
        XCTAssertEqual(draft.selections(choices: choices), [choices[1]])
        XCTAssertEqual(draft.unsupportedEfforts(for: "removed", catalogChoices: choices), ["high", "retired"])
        draft.setModel("removed", selected: false, choices: choices)
        XCTAssertEqual(draft.selections(choices: choices), [choices[1]])
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
