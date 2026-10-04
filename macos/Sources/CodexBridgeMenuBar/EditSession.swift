import AppKit
import CodexBridgeKit
import SwiftUI

/// Field semantics stay in TextIntegrity. A session owns drafts for one form or
/// document, never for the application or the window's shared field editor.
enum BridgeEditField: String, CaseIterable, Sendable {
    case name, description, content, path, cwd, endpoint, displayName
    case deviceName, profileName, apiKey, adminKey, invitation, tunnelID
    case organizationID, projectID, query, number

    var policy: BridgeEditPolicy {
        switch self {
        case .name, .displayName, .deviceName, .profileName: .human()
        case .description: .human(multiline: true)
        case .apiKey, .adminKey, .invitation: .secret
        case .number: .integer(1...Int.max)
        default: .verbatim
        }
    }
}

enum BridgeEditPolicy {
    case human(maximum: Int? = nil, multiline: Bool = false)
    case verbatim, secret
    case integer(ClosedRange<Int>)

    func prepare(_ value: String) throws -> String {
        switch self {
        case .human(let maximum, let multiline):
            return try BridgeTextIntegrity.canonicalHumanText(value, options: .init(
                allowEmpty: true, maxCharacters: maximum,
                rejectControlCharacters: !multiline, trim: true
            ))
        case .verbatim, .secret:
            return try BridgeTextIntegrity.verbatimText(value, options: .init(
                allowEmpty: true, rejectControlCharacters: false
            ))
        case .integer(let range):
            // Keep empty/partial input in the draft. Parse only at an explicit
            // commit, accepting Unicode decimal digits without converting it to 0.
            let digits = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !digits.isEmpty, digits.unicodeScalars.allSatisfy({ $0.properties.numericType == .decimal }),
                  let number = Int(digits.compactMap(\.wholeNumberValue).map(String.init).joined()),
                  range.contains(number) else { throw BridgeEditError.invalidNumber }
            return String(number)
        }
    }

    func equivalent(_ lhs: String, _ rhs: String) -> Bool {
        let left = (try? prepare(lhs)) ?? lhs
        let right = (try? prepare(rhs)) ?? rhs
        return left.utf8.elementsEqual(right.utf8)
    }
}

enum BridgeEditError: Error { case synchronization, conflict, invalidNumber, invalidValue, submission }

/// Only retained by the submitting task. No draft history, payload logging, or
/// printable secrets. Identity and revision belong to the request, not the view.
struct BridgeEditSubmission: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let id: UUID
    let sessionID: UUID
    let targetID: String
    let revision: UInt64
    let expectedVersion: String?
    fileprivate let externalSequence: UInt64
    private let rawValues: [BridgeEditField: String]
    private let preparedValues: [BridgeEditField: String]

    @MainActor fileprivate init(session: BridgeEditSession, prepared: [BridgeEditField: String]) {
        id = UUID(); sessionID = session.id; targetID = session.targetID
        revision = session.revision; expectedVersion = session.baseVersion; externalSequence = session.externalSequence
        rawValues = session.values; preparedValues = prepared
    }

    func value(_ field: BridgeEditField) -> String { preparedValues[field] ?? "" }
    fileprivate func raw(_ field: BridgeEditField) -> String { rawValues[field] ?? "" }
    fileprivate var fields: [BridgeEditField] { Array(preparedValues.keys) }
    var description: String { "BridgeEditSubmission(\(sessionID), revision: \(revision), payload: <redacted>)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["payload": "<redacted>"]) }
}

struct BridgeEditReceipt: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    var version: String?
    var target: String?
    var confirmed: [BridgeEditField: String] = [:]
    var description: String { "BridgeEditReceipt(<redacted>)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["payload": "<redacted>"]) }
}

@MainActor
final class BridgeEditSession: ObservableObject, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    private(set) var id = UUID()
    private(set) var targetID: String
    private(set) var revision: UInt64 = 0
    private(set) var baseVersion: String?
    fileprivate var values: [BridgeEditField: String]
    private var baseline: [BridgeEditField: String]
    // A native preedit is a draft, but echoing it through SwiftUI can commit or
    // replace the IME marked range. Bindings retain their last delivered value.
    private var bindingValues: [BridgeEditField: String]
    private var policies: [BridgeEditField: BridgeEditPolicy]
    private var external: [BridgeEditField: String] = [:]
    private var externalVersion: String?
    fileprivate var externalSequence: UInt64 = 0
    private var versionReview: (sequence: UInt64, version: String?)?
    private var pending: Set<BridgeEditField> = []
    private var protectedAfterFailure: Set<BridgeEditField> = []
    private(set) var conflicts: Set<BridgeEditField> = []
    private var owners: [UUID: WeakInputOwner] = [:]
    private var inFlight: UUID?
    private var committedQuery = ""
    private var candidateReturnEvent: TimeInterval?
    @Published private(set) var change: UInt64 = 0
    @Published private(set) var problem: BridgeEditError?

    init(target: String, values: [BridgeEditField: String], version: String? = nil,
         policies: [BridgeEditField: BridgeEditPolicy] = [:]) {
        targetID = target; self.values = values; baseline = values; bindingValues = values
        baseVersion = version; self.policies = policies
        committedQuery = values[.query] ?? ""
    }

    nonisolated var description: String { "BridgeEditSession(<redacted>)" }
    nonisolated var debugDescription: String { description }
    nonisolated var customMirror: Mirror { Mirror(self, children: ["payload": "<redacted>"]) }
    var isSubmitting: Bool { inFlight != nil }
    var hasConflicts: Bool { !conflicts.isEmpty || versionReview != nil }
    var canResolveConflicts: Bool {
        guard let review = versionReview else { return hasConflicts }
        guard externalSequence > review.sequence else { return false }
        return (externalVersion != nil && externalVersion != review.version) ||
            external.contains { !policy($0.key).equivalent(baseline[$0.key] ?? "", $0.value) }
    }
    var hasMarkedText: Bool { liveOwners.contains { $0.hasMarkedText } }
    var hasUnsavedChanges: Bool { isDirty || hasMarkedText || hasConflicts }
    var isDirty: Bool { values.keys.contains { isDirty($0) } }
    var canSubmit: Bool { !isSubmitting && (hasUnsavedChanges || hasConflicts) }
    var searchValue: String { hasMarkedText ? committedQuery : value(.query) }

    func value(_ field: BridgeEditField) -> String { values[field] ?? "" }
    private func policy(_ field: BridgeEditField) -> BridgeEditPolicy { policies[field] ?? field.policy }
    private func isDirty(_ field: BridgeEditField) -> Bool {
        !policy(field).equivalent(value(field), baseline[field] ?? "")
    }
    func binding(_ field: BridgeEditField) -> Binding<String> {
        let identity = id
        return Binding(get: { self.bindingValues[field] ?? "" }, set: {
            guard self.id == identity else { return }
            self.edit(field, $0)
        })
    }
    func edit(_ field: BridgeEditField, _ value: String) {
        bindingValues[field] = value
        recordDraft(field, value)
    }
    private func recordDraft(_ field: BridgeEditField, _ value: String) {
        guard !self.value(field).utf8.elementsEqual(value.utf8) else { return }
        values[field] = value
        revision &+= 1
        problem = nil
        if field == .query, !hasMarkedText { committedQuery = value }
        changed()
    }

    /// A different target (including reopening the same document) is a new
    /// session. An old task can no longer acknowledge this object.
    func reset(target: String, values: [BridgeEditField: String], version: String? = nil) {
        id = UUID(); targetID = target; revision = 0; inFlight = nil
        self.values = values; baseline = values; bindingValues = values; baseVersion = version
        external = [:]; pending = []; protectedAfterFailure = []; conflicts = []; problem = nil; versionReview = nil; externalSequence = 0
        committedQuery = values[.query] ?? ""
        changed()
    }

    /// Observe live drafts without changing focus or accepting/discarding an IME
    /// candidate. Used before navigation/close/quit, separately from submission.
    @discardableResult
    func observeInputs() -> Bool { synchronize(commit: false) }

    /// Intent comes first: even a previously clean/stale UI must synchronize its
    /// own native buffer before testing changes or validity.
    func prepareSubmission(requireChanges: Bool = false, returnKey: Bool = false,
                           validate: (BridgeEditSubmission) throws -> Void = { _ in }) -> BridgeEditSubmission? {
        guard !isSubmitting else { return nil }
        liveOwners.forEach { $0.captureCandidateReturn() }
        let event = NSApp?.currentEvent
        let enter = returnKey || (event?.type == .keyDown && [36, 76].contains(event?.keyCode ?? 0) && event?.modifierFlags.contains(.command) != true)
        if enter && (hasMarkedText || (event != nil && candidateReturnEvent == event?.timestamp)) { return nil }
        guard synchronize(commit: true) else { problem = .synchronization; return nil }
        guard !hasConflicts else { problem = .conflict; return nil }
        if requireChanges && !isDirty { return nil }
        do {
            let prepared = try values.mapValuesWithKeys { field, value in try policy(field).prepare(value) }
            let submitted = BridgeEditSubmission(session: self, prepared: prepared)
            try validate(submitted)
            inFlight = submitted.id
            problem = nil
            changed()
            return submitted
        } catch let error as BridgeEditError { problem = error }
        catch { problem = .invalidValue }
        return nil
    }

    /// Forms with a Boolean API share response/failure/exit handling as well as
    /// preparation. The operation receives a guard for any feature-specific UI
    /// selection it performs before returning its receipt.
    func submit(validate: @escaping (BridgeEditSubmission) throws -> Void = { _ in },
                isConflict: @escaping @MainActor () -> Bool = { false },
                operation: @escaping @MainActor (BridgeEditSubmission, @escaping @MainActor () -> Bool) async -> Bool,
                onClean: @escaping @MainActor () -> Void = {}) {
        submitReceipt(validate: validate, isConflict: isConflict, operation: { submitted, isCurrent in
            await operation(submitted, isCurrent) ? BridgeEditReceipt() : nil
        }, onClean: onClean)
    }

    func submitReceipt(validate: @escaping (BridgeEditSubmission) throws -> Void = { _ in },
                       isConflict: @escaping @MainActor () -> Bool = { false },
                       operation: @escaping @MainActor (BridgeEditSubmission, @escaping @MainActor () -> Bool) async -> BridgeEditReceipt?,
                       onClean: @escaping @MainActor () -> Void = {}) {
        guard let submitted = prepareSubmission(validate: validate) else { return }
        Task { @MainActor in
            let receipt = await operation(submitted, {
                guard self.accepts(submitted), self.observeInputs() else { return false }
                return self.revision == submitted.revision
            })
            guard accepts(submitted) else { return }
            if let receipt {
                if acknowledge(submitted, version: receipt.version, confirmed: receipt.confirmed, target: receipt.target) { onClean() }
            } else { fail(submitted, conflict: isConflict()) }
        }
    }

    func matches(_ submission: BridgeEditSubmission) -> Bool {
        submission.sessionID == id && submission.targetID == targetID
    }
    func accepts(_ submission: BridgeEditSubmission) -> Bool { matches(submission) && submission.id == inFlight }

    func confirmInput() -> Bool {
        guard synchronize(commit: true) else { problem = .synchronization; return false }
        return true
    }

    /// Confirm only the submitted values. Later keystrokes stay dirty; callers
    /// may close/switch to preview only if this returns true.
    @discardableResult
    func acknowledge(_ submission: BridgeEditSubmission, version: String? = nil, confirmed: [BridgeEditField: String] = [:], target: String? = nil) -> Bool {
        guard accepts(submission) else { return false }
        let synchronized = observeInputs()
        inFlight = nil
        let unchanged = synchronized && revision == submission.revision
        for field in submission.fields {
            if case .secret = policy(field) {
                baseline[field] = ""
                let active = liveOwners.filter { $0.field == field }
                if synchronized && value(field).utf8.elementsEqual(submission.raw(field).utf8) && !active.contains(where: \.hasMarkedText) {
                    active.forEach { $0.replaceBuffer(with: "") }
                    values[field] = ""; bindingValues[field] = ""
                }
            } else {
                let sameDraft = value(field).utf8.elementsEqual(submission.raw(field).utf8)
                let saved = confirmed[field] ?? submission.value(field)
                baseline[field] = saved
                if synchronized && sameDraft && !liveOwners.contains(where: { $0.field == field && $0.hasMarkedText }) {
                    values[field] = saved; bindingValues[field] = saved
                }
            }
            protectedAfterFailure.remove(field)
        }
        baseVersion = version ?? submission.expectedVersion
        targetID = target ?? targetID
        // Server notifications can arrive before the awaited API returns. The
        // response confirms that exact version, never a newer external value.
        if (baseVersion != nil && externalVersion == baseVersion) || external.allSatisfy({ policy($0.key).equivalent(baseline[$0.key] ?? "", $0.value) }) {
            external = [:]; pending = []; conflicts = []
        } else { reconcilePending() }
        if !synchronized { problem = .synchronization }
        changed()
        return unchanged && !hasUnsavedChanges && !hasConflicts
    }

    func fail(_ submission: BridgeEditSubmission, conflict: Bool = false) {
        guard accepts(submission) else { return }
        let synchronized = observeInputs()
        // Returning to the old baseline after submitting is still a newer edit.
        // A failed request must not let a later server notification erase it.
        protectedAfterFailure.formUnion(submission.fields.filter { !value($0).utf8.elementsEqual(submission.raw($0).utf8) })
        if conflict {
            versionReview = (submission.externalSequence, submission.expectedVersion)
            problem = .conflict
        } else { problem = synchronized ? .submission : .synchronization }
        inFlight = nil
        reconcilePending()
        changed()
    }

    func receive(_ next: [BridgeEditField: String], version: String? = nil) {
        _ = observeInputs()
        external.merge(next) { _, value in value }; externalVersion = version; externalSequence &+= 1
        for (field, value) in next {
            if isSubmitting || liveOwners.contains(where: { $0.field == field && $0.isEditing }) {
                pending.insert(field)
            } else { reconcile(field, value) }
        }
        if !isSubmitting && !hasConflicts && pending.isEmpty { baseVersion = version ?? baseVersion }
        changed()
    }

    /// Explicit choices only. Reload discards the conflicted fields; keeping
    /// edits adopts the displayed server baseline for the next guarded request.
    func resolveConflicts(keepingDraft: Bool) {
        guard canResolveConflicts else { return }
        guard synchronize(commit: true) else { problem = .synchronization; return }
        let fields = versionReview == nil ? conflicts : conflicts.union(values.keys.filter { isDirty($0) })
        for field in fields {
            guard let latest = external[field] ?? baseline[field] else { continue }
            baseline[field] = latest
            if !keepingDraft { values[field] = latest; bindingValues[field] = latest; revision &+= 1; liveOwners.filter { $0.field == field }.forEach { $0.replaceBuffer(with: latest) } }
        }
        conflicts = []; versionReview = nil; baseVersion = externalVersion ?? baseVersion; problem = nil
        protectedAfterFailure = []
        changed()
    }

    /// Explicit discard never submits. Invalidate receipts and erase secrets.
    func discard() {
        for owner in liveOwners {
            owner.discardComposition()
            let value: String
            if case .secret = policy(owner.field) { value = "" } else { value = baseline[owner.field] ?? "" }
            owner.replaceBuffer(with: value)
        }
        reset(target: targetID, values: baseline.mapValuesWithKeys { field, value in
            if case .secret = policy(field) { return "" }; return value
        }, version: baseVersion)
    }

    fileprivate func attach(_ owner: BridgeNativeInputOwner) {
        owners[owner.registration] = WeakInputOwner(owner)
    }
    fileprivate func detach(_ owner: BridgeNativeInputOwner) {
        owners.removeValue(forKey: owner.registration)
        // Dismantling a hosting view must not publish into the SwiftUI graph
        // while that graph is being invalidated. Reconcile on the next turn.
        Task { @MainActor [weak self] in self?.reconcilePending(); self?.changed() }
    }
    fileprivate func compositionEndedOnReturn(_ timestamp: TimeInterval) { candidateReturnEvent = timestamp }
    fileprivate func nativeInputChanged(_ owner: BridgeNativeInputOwner, finalText: String? = nil) {
        guard owner.sessionID == id else { return }
        let marked = owner.hasMarkedText
        let compositionChanged = owner.recordCompositionState(marked)
        if let text = owner.liveText ?? finalText {
            if !marked { bindingValues[owner.field] = text }
            recordDraft(owner.field, text)
        }
        if owner.endedCompositionOnReturn { candidateReturnEvent = NSApp?.currentEvent?.timestamp }
        if owner.field == .query, !marked { committedQuery = value(.query) }
        let hadPending = !pending.isEmpty
        reconcilePending()
        if compositionChanged || hadPending { changed() }
    }
    private var liveOwners: [BridgeNativeInputOwner] {
        owners.values.compactMap(\.value).filter { $0.sessionID == id }
    }
    private func synchronize(commit: Bool) -> Bool {
        for owner in liveOwners {
            guard owner.synchronize(commit: commit) else { return false }
        }
        reconcilePending(confirmed: commit)
        return true
    }
    private func reconcilePending(confirmed: Bool = false) {
        guard !isSubmitting else { return }
        for field in pending where confirmed || !liveOwners.contains(where: { $0.field == field && $0.isEditing }) {
            if let next = external[field] { reconcile(field, next) }
            pending.remove(field)
        }
        if pending.isEmpty && !hasConflicts { baseVersion = externalVersion ?? baseVersion }
    }
    private func reconcile(_ field: BridgeEditField, _ next: String) {
        if (!isDirty(field) && !protectedAfterFailure.contains(field)) || policy(field).equivalent(value(field), next) {
            values[field] = next; bindingValues[field] = next; baseline[field] = next; conflicts.remove(field)
            protectedAfterFailure.remove(field)
        } else if !policy(field).equivalent(baseline[field] ?? "", next) {
            conflicts.insert(field)
        } else { conflicts.remove(field) }
    }
    private func changed() { change &+= 1 }
}

private extension Dictionary {
    func mapValuesWithKeys<T>(_ transform: (Key, Value) throws -> T) rethrows -> [Key: T] {
        try Dictionary<Key, T>(uniqueKeysWithValues: map { (key, value) in (key, try transform(key, value)) })
    }
}

@MainActor
private final class WeakInputOwner {
    weak var value: BridgeNativeInputOwner?
    init(_ value: BridgeNativeInputOwner) { self.value = value }
}

/// Owns a single native control, while retaining SwiftUI's TextField/SecureField
/// and their AppKit delegates. The enclosing host is an explicit boundary, so
/// no private SwiftUI hierarchy or global firstResponder lookup identifies it.
@MainActor
final class BridgeNativeInputOwner: NSObject {
    let registration = UUID()
    private(set) var sessionID: UUID
    private(set) var field: BridgeEditField
    private weak var session: BridgeEditSession?
    private weak var root: NSView?
    private weak var scope: BridgeEditScope?
    private let search: Bool
    private var observing = false
    private var previouslyMarked = false
    private var notificationScheduled = false
    private var endedEditing = false
    private var finalText: String?
    private(set) var endedCompositionOnReturn = false
    var onCommit: (() -> Void)?

    init(session: BridgeEditSession, field: BridgeEditField, search: Bool = false) {
        self.session = session; sessionID = session.id; self.field = field; self.search = search
    }
    func connect(root: NSView, session: BridgeEditSession, field: BridgeEditField? = nil, scope: BridgeEditScope? = nil) {
        let nextField = field ?? self.field
        if self.session !== session || sessionID != session.id || self.field != nextField {
            self.session?.detach(self); self.session = session; sessionID = session.id
            self.field = nextField
            notificationScheduled = false; endedEditing = false; finalText = nil; previouslyMarked = false
        }
        self.root = root
        if self.scope !== scope { self.scope?.detach(owner: registration); self.scope = scope }
        scope?.attach(session, owner: registration)
        session.attach(self)
        if !observing {
            observing = true
            for name in [NSText.didChangeNotification, NSTextView.didChangeSelectionNotification,
                         NSControl.textDidChangeNotification, NSControl.textDidEndEditingNotification] {
                NotificationCenter.default.addObserver(self, selector: #selector(inputNotification(_:)), name: name, object: nil)
            }
        }
    }
    func disconnect() {
        NotificationCenter.default.removeObserver(self)
        observing = false; session?.detach(self); scope?.detach(owner: registration); root = nil; onCommit = nil
    }
    private var control: NSView? {
        guard let scope = search ? root?.window?.contentView : root else { return nil }
        func collect(_ view: NSView, excluding findBar: NSView? = nil) -> [NSView] {
            if view === findBar { return [] }
            if search {
                if view is NSSearchField { return [view] }
            } else if let field = view as? NSTextField, field.isEditable { return [field] }
            else if let editor = view as? NSTextView, !editor.isFieldEditor, editor.isEditable { return [view] }
            // AppKit owns the Find bar's inputs. Its public container view is
            // separate from the document and the window's sidebar search.
            let excluded = (view as? NSScrollView)?.findBarView ?? findBar
            return view.subviews.flatMap { collect($0, excluding: excluded) }
        }
        let found = collect(scope)
        return found.count == 1 ? found[0] : nil
    }
    private var editor: NSTextView? {
        guard let control else { return nil }
        if let field = control as? NSTextField {
            // One field editor is shared by many controls in a window. It must
            // still be this control's editor, with this control as its delegate.
            guard let editor = field.currentEditor() as? NSTextView,
                  editor.delegate === field, editor.window?.firstResponder === editor else { return nil }
            return editor
        }
        return control as? NSTextView
    }
    var isEditing: Bool { editor.map { $0.window?.firstResponder === $0 } ?? false }
    var hasMarkedText: Bool { isEditing && editor?.hasMarkedText() == true }
    var liveText: String? { isEditing ? editor?.string : nil }

    func captureCandidateReturn() {
        guard previouslyMarked, !hasMarkedText, let event = NSApp?.currentEvent,
              event.type == .keyDown, [36, 76].contains(event.keyCode), !event.modifierFlags.contains(.command) else { return }
        session?.compositionEndedOnReturn(event.timestamp)
    }
    func recordCompositionState(_ marked: Bool) -> Bool {
        let event = NSApp?.currentEvent
        endedCompositionOnReturn = previouslyMarked && !marked && event?.type == .keyDown && [36, 76].contains(event?.keyCode ?? 0)
        defer { previouslyMarked = marked }
        return previouslyMarked != marked
    }
    func synchronize(commit: Bool) -> Bool {
        // A detached form has no native buffer. A mounted but ambiguous control
        // cannot safely confirm synchronization and must block submission.
        guard root?.window != nil else { return true }
        guard control != nil else { return false }
        if let editor, isEditing {
            if commit && editor.hasMarkedText() {
                editor.unmarkText(); editor.inputContext?.discardMarkedText(); editor.didChangeText()
                guard !editor.hasMarkedText() else { return false }
            }
            session?.nativeInputChanged(self)
        }
        return true
    }
    func replaceBuffer(with value: String) {
        guard let control else { return }
        if let editor, isEditing { editor.string = value }
        if let field = control as? NSTextField { field.stringValue = value }
        else if let editor = control as? NSTextView { editor.string = value }
    }
    func discardComposition() {
        guard isEditing, let editor else { return }
        editor.unmarkText(); editor.inputContext?.discardMarkedText()
    }
    @objc private func inputNotification(_ notification: Notification) {
        guard let object = notification.object as? NSView,
              object === control || object === editor else { return }
        captureCandidateReturn()
        // Selection notifications may fire inside setMarkedText, before AppKit
        // installs the marked range. Observe after the input event finishes.
        if notification.name == NSControl.textDidEndEditingNotification {
            endedEditing = true
            finalText = (control as? NSTextField)?.stringValue
        }
        guard !notificationScheduled else { return }
        notificationScheduled = true
        let identity = sessionID
        let changedField = field
        Task { @MainActor [weak self] in
            guard let self, observing, sessionID == identity, field == changedField else { return }
            notificationScheduled = false
            let ended = endedEditing
            let text = finalText
            endedEditing = false; finalText = nil
            session?.nativeInputChanged(self, finalText: text)
            if ended { onCommit?() }
        }
    }
}

private struct BridgeOwnedInput<Content: View>: NSViewRepresentable {
    let content: Content
    @Environment(\.bridgeEditScope) private var scope
    @ObservedObject var session: BridgeEditSession
    let field: BridgeEditField
    var onCommit: (() -> Void)?

    func makeCoordinator() -> BridgeNativeInputOwner { BridgeNativeInputOwner(session: session, field: field) }
    func makeNSView(context: Context) -> NSHostingView<AnyView> {
        let view = NSHostingView(rootView: AnyView(content.environment(\.self, context.environment)))
        view.sizingOptions = [.intrinsicContentSize]
        context.coordinator.connect(root: view, session: session, field: field, scope: scope)
        context.coordinator.onCommit = onCommit
        return view
    }
    func updateNSView(_ view: NSHostingView<AnyView>, context: Context) {
        let changedIdentity = context.coordinator.sessionID != session.id || context.coordinator.field != field
        if changedIdentity {
            context.coordinator.discardComposition()
            context.coordinator.replaceBuffer(with: session.value(field))
        }
        if changedIdentity || !context.coordinator.hasMarkedText {
            view.rootView = AnyView(content.environment(\.self, context.environment))
        }
        context.coordinator.connect(root: view, session: session, field: field, scope: scope)
        context.coordinator.onCommit = onCommit
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSHostingView<AnyView>, context: Context) -> CGSize? {
        let natural = nsView.intrinsicContentSize
        return CGSize(width: proposal.width ?? max(120, natural.width), height: proposal.height ?? max(22, natural.height))
    }
    static func dismantleNSView(_ view: NSHostingView<AnyView>, coordinator: BridgeNativeInputOwner) { coordinator.disconnect() }
}

private struct BridgeSearchOwner: NSViewRepresentable {
    let session: BridgeEditSession
    func makeCoordinator() -> BridgeNativeInputOwner { BridgeNativeInputOwner(session: session, field: .query, search: true) }
    func makeNSView(context: Context) -> NSView {
        let view = NSView(); context.coordinator.connect(root: view, session: session); return view
    }
    func updateNSView(_ view: NSView, context: Context) { context.coordinator.connect(root: view, session: session) }
    static func dismantleNSView(_ view: NSView, coordinator: BridgeNativeInputOwner) { coordinator.disconnect() }
}

private struct BridgeFormOwner: NSViewRepresentable {
    let session: BridgeEditSession
    @Environment(\.bridgeEditScope) private var scope
    final class Coordinator {
        let id = UUID()
        weak var scope: BridgeEditScope?
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { let view = NSView(); updateNSView(view, context: context); return view }
    func updateNSView(_ view: NSView, context: Context) {
        if context.coordinator.scope !== scope { context.coordinator.scope?.detach(owner: context.coordinator.id) }
        context.coordinator.scope = scope
        scope?.attach(session, owner: context.coordinator.id)
    }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.scope?.detach(owner: coordinator.id) }
}

extension View {
    func bridgeEditForm(_ session: BridgeEditSession) -> some View { background(BridgeFormOwner(session: session)) }
    func bridgeInput(_ session: BridgeEditSession, field: BridgeEditField, onCommit: (() -> Void)? = nil) -> some View {
        BridgeOwnedInput(content: self, session: session, field: field, onCommit: onCommit)
    }
    func bridgeSearchInput(_ session: BridgeEditSession) -> some View { background(BridgeSearchOwner(session: session)) }
}

struct BridgeEditStatus: View {
    @ObservedObject var session: BridgeEditSession
    var reloadLatest: (() -> Void)?
    var body: some View {
        if session.hasConflicts {
            VStack(alignment: .leading, spacing: 6) {
                Text("macos.input.externalChange").foregroundStyle(.orange)
                HStack {
                    if session.canResolveConflicts {
                        Button("macos.input.reload") { session.resolveConflicts(keepingDraft: false) }
                        Button("macos.input.keepDraft") { session.resolveConflicts(keepingDraft: true) }
                    } else if let reloadLatest {
                        Button("macos.input.refresh") { reloadLatest() }
                    }
                }
            }.font(.caption)
        } else if let problem = session.problem {
            Text(message(problem)).font(.caption).foregroundStyle(.red)
        }
    }
    private func message(_ problem: BridgeEditError) -> LocalizedStringKey {
        switch problem {
        case .synchronization: "macos.input.synchronizationFailed"
        case .conflict: "macos.input.externalChange"
        case .invalidNumber: "macos.input.invalidNumber"
        case .invalidValue: "macos.input.invalidValue"
        case .submission: "common.error"
        }
    }
}

/// A window-local exit guard. It only references mounted forms; it does not own
/// their drafts and never commits composition or sends a save on navigation.
@MainActor
final class BridgeEditScope {
    private var forms: [UUID: WeakEditSession] = [:]
    private var shutdownApproval: [ObjectIdentifier: (UUID, UInt64)] = [:]
    fileprivate func attach(_ session: BridgeEditSession, owner: UUID) { forms[owner] = WeakEditSession(session) }
    fileprivate func detach(owner: UUID) { forms.removeValue(forKey: owner) }
    private var sessions: [BridgeEditSession] {
        var seen: Set<ObjectIdentifier> = []
        return forms.values.compactMap(\.value).filter { seen.insert(ObjectIdentifier($0)).inserted }
    }
    var hasPendingDrafts: Bool { !unsaved.isEmpty }
    private var unsaved: [BridgeEditSession] {
        sessions.filter { !$0.observeInputs() || $0.hasUnsavedChanges || $0.isSubmitting }
    }
    func confirmDiscardIfNeeded(_ decision: () -> Bool) -> Bool {
        let drafts = unsaved
        guard !drafts.isEmpty else { return true }
        guard decision() else { return false }
        drafts.forEach { $0.discard() }
        return true
    }
    func confirmDiscardForApplicationShutdown(_ decision: () -> Bool) -> Bool {
        let drafts = unsaved
        guard !drafts.isEmpty else { return true }
        if drafts.allSatisfy({ session in
            guard let approved = shutdownApproval[ObjectIdentifier(session)] else { return false }
            return approved.0 == session.id && approved.1 == session.revision
        }) { return true }
        guard decision() else { return false }
        shutdownApproval = Dictionary(uniqueKeysWithValues: drafts.map { (ObjectIdentifier($0), ($0.id, $0.revision)) })
        return true
    }
    func completeApplicationShutdownDiscard() {
        for session in sessions where shutdownApproval[ObjectIdentifier(session)] != nil { session.discard() }
        shutdownApproval = [:]
    }
    func cancelApplicationShutdownDiscard() { shutdownApproval = [:] }
}

@MainActor
private final class WeakEditSession {
    weak var value: BridgeEditSession?
    init(_ value: BridgeEditSession) { self.value = value }
}
private struct BridgeEditScopeKey: EnvironmentKey { static let defaultValue: BridgeEditScope? = nil }
extension EnvironmentValues {
    var bridgeEditScope: BridgeEditScope? {
        get { self[BridgeEditScopeKey.self] }
        set { self[BridgeEditScopeKey.self] = newValue }
    }
}

@MainActor
enum BridgeDiscardAlert {
    static func confirm(locale: Locale) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = BridgeAppLocalization.string("macos.input.discard", locale: locale)
        alert.addButton(withTitle: BridgeAppLocalization.string("macos.discardedits", locale: locale))
        alert.addButton(withTitle: BridgeAppLocalization.string("common.cancel", locale: locale))
        return alert.runModal() == .alertFirstButtonReturn
    }
}
