import { describe, expect, it } from "vitest";
import { checkInventory, inspectInputs } from "../scripts/native-input-contract.mjs";

describe("native input structural guard", () => {
  it("recognizes native bindings, multiline labels and intervening modifiers", () => {
    const entries = inspectInputs(`struct Form: View {
      TextField(text: input.binding(.name)) { EmptyView() }
        .focused($focus, equals: .name).textFieldStyle(.roundedBorder)
        .bridgeInput(input, field: .name)
      BridgeTextEditor(text: input.binding(.content), font: .systemFont(ofSize: size))
        .bridgeInput(input, field: .content)
      SecureField("Synthetic", text: input.binding(.apiKey)).bridgeInput(input, field: .apiKey)
      BridgeSearchField(text: search.binding(.query), prompt: "Search")
        .bridgeSearchInput(search)
    }`);
    expect(entries.map((entry) => entry.field)).toEqual(["name", "content", "apiKey", "query"]);
    checkInventory(entries, entries);
  });
  it("rejects an unconnected control even if another field has an adapter", () => {
    expect(() => inspectInputs(`TextField("A", text: input.binding(.name))
      TextField("B", text: input.binding(.path)).bridgeInput(input, field: .path)`)).toThrow("native owner");
  });
  it("rejects an adapter for a different field or session", () => {
    for (const owner of ["input, field: .path", "other, field: .name"]) {
      expect(() => inspectInputs(`TextField("A", text: input.binding(.name)).bridgeInput(${owner})`)).toThrow("native owner");
    }
  });
  it("rejects raw state bindings, raw editors and global composition commits", () => {
    expect(() => inspectInputs('SecureField("A", text: $secret)')).toThrow("session binding");
    expect(() => inspectInputs('TextEditor(text: input.binding(.content))')).toThrow("BridgeTextEditor");
    expect(() => inspectInputs('NavigationSplitView {} detail: {}.searchable(text: search.binding(.query)).bridgeSearchInput(search)')).toThrow("BridgeSearchField");
    expect(() => inspectInputs("BridgeTextInput.commitPendingComposition()")).toThrow("global");
  });
  it("requires a scoped query owner for native search", () => {
    expect(() => inspectInputs('BridgeSearchField(text: search.binding(.query), prompt: "Search")')).toThrow("native owner");
    expect(() => inspectInputs('BridgeSearchField(text: search.binding(.query), prompt: "Search").bridgeSearchInput(other)')).toThrow("native owner");
    expect(() => inspectInputs('BridgeSearchField(text: search.binding(.name), prompt: "Search").bridgeSearchInput(search)')).toThrow("query field");
  });
  it("ignores quoted examples and comments", () => {
    expect(inspectInputs('// TextField("A", text: $raw)\nlet label = "TextEditor(text:) BridgeTextInput.commitPendingComposition()"')).toEqual([]);
  });
  it("rejects new direct AppKit inputs outside the reviewed native editor implementation", () => {
    for (const type of ["NSTextField", "NSSecureTextField", "NSSearchField", "NSTextView", "BridgeEditableTextView"]) {
      expect(() => inspectInputs(`${type}(frame: .zero)`)).toThrow("native input constructor");
    }
    expect(inspectInputs("BridgeEditableTextView(frame: .zero)", "TextInputViews.swift")).toEqual([]);
  });
  it("requires an inventory review for added declarations and duplicate identities", () => {
    const entries = inspectInputs('TextField("A", text: input.binding(.name)).bridgeInput(input, field: .name)');
    expect(() => checkInventory(entries, [])).toThrow("inventory changed");
    expect(() => checkInventory([...entries, ...entries], entries)).toThrow("Duplicate");
  });
});
