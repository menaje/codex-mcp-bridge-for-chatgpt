import CodexBridgeKit
import SwiftUI

struct CodexAccountUsageView: View {
    @EnvironmentObject private var model: AppModel
    let account: CodexAccountUsage
    var runtimeKind: String? = nil
    @State private var showBilling = false
    @State private var adminKey = ""
    @State private var organizationId = ""
    @State private var projectId = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent("macos.authenticationmethod", value: account.authMode == "api-key" ? "macos.openaiapikey" : account.authMode == "chatgpt" ? "ChatGPT" : "—")
            if account.authMode == "chatgpt" {
                Text("macos.codexusageforthesameaccountisshared")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(sortedWindows) { window in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(Duration.seconds(Int64(window.windowDurationMins * 60)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated)))
                            Text(window.displayName ?? BridgeAppLocalization.string("macos.additionalusage", locale: model.interfaceLocale)).foregroundStyle(.secondary)
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
                if account.windows.isEmpty { Text("macos.usageinformationisunavailable").font(.caption) }
                if let credits = account.credits {
                    LabeledContent("macos.additionalcredits") {
                        if credits.unlimited {
                            Text("macos.nocreditlimit")
                        } else {
                            Text(verbatim: credits.balance ?? "—")
                        }
                    }
                    .help("macos.abalancealonedoesnotshowwhethercredits")
                }
                if let credits = account.resetCredits, credits.availableCount > 0 {
                    LabeledContent("macos.usageresetcoupons", value: credits.availableCount.formatted())
                }
                HStack {
                    Text("macos.lastchecked")
                    Spacer()
                    Text(Date(timeIntervalSince1970: account.observedAt / 1000), style: .relative)
                }.font(.caption).foregroundStyle(.secondary)
            } else if account.authMode == "api-key" {
                Text("macos.apirequeststokensandorganizationsalsohavelimits")
                    .font(.caption).foregroundStyle(.secondary)
                Text("macos.theexecutionkeycannotretrieveinvoicedcosts")
                    .font(.caption).foregroundStyle(.secondary)
                Link("macos.viewapiusageandcosts", destination: URL(string: "https://platform.openai.com/usage")!)
                if let costs = account.billing?.actualCosts, costs.configured {
                    if costs.status == "available", let usd = costs.usd {
                        LabeledContent(costs.projectId == nil ? "macos.organizationcostthismonthutc" : "macos.projectcostthismonthutc", value: usd.formatted(.currency(code: "USD")))
                    } else { Text("macos.costinformationisunavailable").font(.caption) }
                    Text("macos.includescostsfromworkoutsidethisbridge").font(.caption).foregroundStyle(.secondary)
                    if let organization = costs.organizationId { Text(verbatim: organization).font(.caption) }
                    if let project = costs.projectId { Text(verbatim: project).font(.caption) }
                }
                if let runtimeKind {
                    FullRowDisclosure("macos.apicostconnection", isExpanded: $showBilling) {
                        Text("macos.usesaseparateadminkeyforcostsyour")
                            .font(.caption).foregroundStyle(.secondary)
                        SecureField("macos.openaiadminapikey", text: $adminKey)
                        TextField("macos.organizationid", text: $organizationId)
                        TextField("macos.projectidoptional", text: $projectId)
                        Button("macos.connectcostreporting") {
                            let input = CodexBillingInput(adminKey: adminKey, organizationId: organizationId.trimmingCharacters(in: .whitespacesAndNewlines),
                                projectId: projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : projectId.trimmingCharacters(in: .whitespacesAndNewlines))
                            adminKey = ""
                            Task { await model.manageCodex(.init(action: "configure-billing", kind: runtimeKind, billing: input)) }
                        }.disabled(adminKey.isEmpty || organizationId.isEmpty)
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
    }

    private var sortedWindows: [CodexAccountUsage.Window] {
        account.windows.sorted { left, right in
            if (left.limitId == "codex") != (right.limitId == "codex") { return left.limitId == "codex" }
            if left.limitId != right.limitId { return left.limitId < right.limitId }
            return left.windowDurationMins > right.windowDurationMins
        }
    }
}
