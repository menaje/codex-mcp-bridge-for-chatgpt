import CodexBridgeKit
import SwiftUI

struct RuntimeLifecycleNoticeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let operation = model.lifecycleOperation, operation.isPending || operation.phase == "failed" {
            if operation.kind == "start", operation.isPending {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("macos.checkingthebridgeconnection")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    if operation.cancellable {
                        Button("macos.cancelreservation") { Task { await model.cancelLifecycle() } }
                            .buttonStyle(.borderless)
                            .controlSize(.small)
                            .disabled(model.isBusy)
                    }
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("runtime-lifecycle-reservation")
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Label(text(actionKey(operation.kind)), systemImage: operation.isExecuting ? "arrow.triangle.2.circlepath" : "clock")
                            .font(.caption.weight(.semibold))
                        Spacer()
                        if operation.cancellable {
                            Button("macos.cancelreservation") { Task { await model.cancelLifecycle() } }
                                .disabled(model.isBusy)
                        }
                    }
                    Text(operation.phase == "failed"
                        ? BridgeAppLocalization.lifecycleFailureDescription(operation.error, locale: model.interfaceLocale)
                        : text(phaseKey(operation)))
                        .font(.caption)
                    ForEach(Array(operation.reasons.enumerated()), id: \.offset) { _, reason in
                        Text(reasonText(reason)).font(.caption).foregroundStyle(.secondary)
                    }
                    if let target = operation.targetDescription, !target.isEmpty {
                        Text(verbatim: target).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("runtime-lifecycle-reservation")
            }
        }
    }

    private func text(_ key: String) -> String { BridgeAppLocalization.string(key, locale: model.interfaceLocale) }

    private func actionKey(_ kind: String) -> String {
        switch kind {
        case "start": return "macos.serverstartreserved"
        case "restart": return "macos.serverrestartreserved"
        case "stop": return "macos.serverstopreserved"
        case "configure": return "macos.settingschangereserved"
        case "repair": return "macos.profilerepairreserved"
        case "shutdown": return "macos.appexitreserved"
        case "mode-switch": return "macos.switchtoremotemodereserved"
        default: return "macos.helperupdatereserved"
        }
    }

    private func phaseKey(_ operation: RuntimeLifecycleOperation) -> String {
        switch operation.phase {
        case "executing": return "macos.stoppingtheserversafely"
        case "reconnecting": return "macos.checkingtheconnectionwiththenewsettings"
        case "handoff-ready", "handing-off": return "macos.theserverhasstoppedtheappisfinishing"
        default: return "macos.thiswillproceedautomaticallywhenreadythereservation"
        }
    }

    private func reasonText(_ reason: RuntimeLifecycleOperation.Reason) -> String {
        switch reason.code {
        case "active-jobs", "pending-admissions":
            return BridgeAppLocalization.format("macos.runningorstartingtasks", locale: model.interfaceLocale, reason.count ?? 0)
        case "memory-only-threads": return text("macos.protectingunsavedconversationswaitforconnectionreleaseor")
        case "pending-interactions": return text("macos.waitingforapprovalorareply")
        case "background-processes": return text("macos.waitingforbackgroundprocessestofinish")
        case "background-state-unknown": return text("macos.checkingbackgroundprocessstatus")
        default: return text("macos.recheckingtheruntimeyourreservationisretained")
        }
    }
}
