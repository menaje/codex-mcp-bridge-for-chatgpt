import CodexBridgeKit
import SwiftUI

struct CodexAccountUsageView: View {
    @Environment(\.locale) private var locale
    @EnvironmentObject private var model: AppModel
    let account: CodexAccountUsage
    var runtimeKind: String? = nil
    @State private var showBilling = false
    @StateObject private var inputSession = BridgeEditSession(target: "billing", values: [.adminKey: "", .organizationID: "", .projectID: ""])

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if account.authMode == "api-key" {
                LabeledContent("macos.authenticationmethod") {
                    Text("macos.openaiapikey")
                }
            } else if account.authMode == "chatgpt" {
                LabeledContent("macos.authenticationmethod", value: "ChatGPT")
            }
            if account.authMode == "chatgpt" {
                if !account.windows.isEmpty {
                    Text("macos.codexusageforthesameaccountisshared")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(sortedWindows) { window in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(Duration.seconds(Int64(window.windowDurationMins * 60)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated).locale(locale)))
                            if let name = window.displayName {
                                Text(name).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(window.remainingPercent / 100, format: .percent.precision(.fractionLength(0)))
                            Text("macos.accountUsage.remainingLabel")
                        }
                        ProgressView(value: max(0, min(100, window.remainingPercent)), total: 100)
                        if let reset = window.resetsAt {
                            HStack {
                                Text("macos.resets")
                                Text(Date(timeIntervalSince1970: reset), style: .relative)
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let credits = account.credits, credits.unlimited || credits.balance != nil {
                    LabeledContent("macos.additionalcredits") {
                        if credits.unlimited {
                            Text("macos.nocreditlimit")
                        } else if let balance = credits.balance {
                            Text(verbatim: balance)
                        }
                    }
                    .help("macos.abalancealonedoesnotshowwhethercredits")
                }
                if let credits = account.resetCredits, credits.availableCount > 0 {
                    LabeledContent("macos.usageresetcoupons", value: credits.availableCount.formatted())
                }
                if !account.windows.isEmpty {
                    HStack {
                        Text("macos.lastchecked")
                        Spacer()
                        Text(Date(timeIntervalSince1970: (account.usageObservedAt ?? account.observedAt) / 1000), style: .relative)
                    }.font(.caption).foregroundStyle(.secondary)
                }
            } else if account.authMode == "api-key" {
                Text("macos.apirequeststokensandorganizationsalsohavelimits")
                    .font(.caption).foregroundStyle(.secondary)
                Link("macos.viewapiusageandcosts", destination: URL(string: "https://platform.openai.com/usage")!)
                if let costs = account.billing?.actualCosts, costs.configured,
                   costs.status == "available", let usd = costs.usd {
                    LabeledContent(costs.projectId == nil ? "macos.organizationcostthismonthutc" : "macos.projectcostthismonthutc", value: usd.formatted(.currency(code: "USD")))
                    Text("macos.includescostsfromworkoutsidethisbridge").font(.caption).foregroundStyle(.secondary)
                    if let organization = costs.organizationId { Text(verbatim: organization).font(.caption) }
                    if let project = costs.projectId { Text(verbatim: project).font(.caption) }
                }
                if let runtimeKind {
                    FullRowDisclosure("macos.apicostconnection", isExpanded: $showBilling) {
                        Text("macos.usesaseparateadminkeyforcostsyour")
                            .font(.caption).foregroundStyle(.secondary)
                        SecureField("macos.openaiadminapikey", text: inputSession.binding(.adminKey))
                            .bridgeInput(inputSession, field: .adminKey)
                        TextField("macos.organizationid", text: inputSession.binding(.organizationID))
                            .bridgeInput(inputSession, field: .organizationID)
                        TextField("macos.projectidoptional", text: inputSession.binding(.projectID))
                            .bridgeInput(inputSession, field: .projectID)
                        Button("macos.connectcostreporting") {
                            inputSession.submit(validate: {
                                if $0.targetID != billingTargetID || $0.value(.adminKey).isEmpty || $0.value(.organizationID).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw BridgeEditError.invalidValue }
                            }, operation: { submitted, _ in
                                let project = submitted.value(.projectID).trimmingCharacters(in: .whitespacesAndNewlines)
                                let input = CodexBillingInput(adminKey: submitted.value(.adminKey),
                                    organizationId: submitted.value(.organizationID).trimmingCharacters(in: .whitespacesAndNewlines), projectId: project.isEmpty ? nil : project)
                                return await model.submitCodexRequest(.init(action: "configure-billing", kind: runtimeKind, billing: input))
                            })
                        }.disabled(inputSession.isSubmitting || model.isBusy || (!inputSession.hasMarkedText && (inputSession.value(.adminKey).isEmpty || inputSession.value(.organizationID).isEmpty)))
                        BridgeEditStatus(session: inputSession)
                        if account.billing?.actualCosts?.configured == true {
                            Button("macos.disconnectcostreporting") { Task { await model.manageCodex(.init(action: "remove-billing", kind: runtimeKind)) } }
                        }
                    }
                }
            } else {
                Text("macos.loginrequired").foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { synchronizeBillingTarget() }
        .onChange(of: account.ownershipKey) { _ in synchronizeBillingTarget() }
        .onChange(of: runtimeKind) { _ in synchronizeBillingTarget() }
        .onChange(of: model.connectionContextID) { _ in synchronizeBillingTarget() }
        .bridgeEditForm(inputSession)
        .onDisappear { inputSession.discard() }
    }

    private var billingTargetID: String { "billing:\(model.connectionContextID):\(runtimeKind ?? "unknown"):\(account.ownershipKey ?? "unknown")" }
    private func synchronizeBillingTarget() {
        guard inputSession.targetID != billingTargetID else { return }
        inputSession.discard()
        inputSession.reset(target: billingTargetID, values: [.adminKey: "", .organizationID: "", .projectID: ""])
    }

    private var sortedWindows: [CodexAccountUsage.Window] {
        account.windows.sorted { left, right in
            if (left.limitId == "codex") != (right.limitId == "codex") { return left.limitId == "codex" }
            if left.limitId != right.limitId { return left.limitId < right.limitId }
            return left.windowDurationMins > right.windowDurationMins
        }
    }
}
