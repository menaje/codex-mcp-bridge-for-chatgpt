import SwiftUI

/// Both the first-load and retained-content paths use the same recovery action.
struct DashboardReadFailureNotice: View {
    var onOpenConnectionSettings: () -> Void
    @EnvironmentObject private var model: AppModel

    private var actionKey: String {
        switch model.dashboardRecoveryAction {
        case .reload: return "macos.dashboard.reload"
        case .checkConnection: return "macos.dashboard.checkConnection"
        case .reconnect: return model.isRemoteClient ? "macos.reconnectserver" : "macos.reconnecthelper"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(BridgeAppLocalization.string("macos.dashboard.readFailed", locale: model.interfaceLocale),
                  systemImage: "clock.badge.exclamationmark")
                .foregroundStyle(.orange)
            if let checked = model.lastDashboardRefresh {
                HStack {
                    Text("macos.lastchecked")
                    Text(checked, style: .time)
                }
            }
            HStack {
                Button(BridgeAppLocalization.string(actionKey, locale: model.interfaceLocale)) {
                    Task { await model.recoverDashboardRead() }
                }
                .accessibilityIdentifier("dashboard-read-recovery")
                .disabled(model.isDashboardRefreshing || model.dashboardConnectionCheckPending || model.isBusy)
                if model.isDashboardRefreshing { ProgressView().controlSize(.small) }
                if model.dashboardReadFailureCount > 1 {
                    Button("macos.connectionsettings", action: onOpenConnectionSettings)
                }
            }
            if let failure = model.dashboardReadFailure {
                // Metadata only: no remote error text, prompt, result or credential.
                DisclosureGroup(BridgeAppLocalization.string("macos.dashboard.diagnostics", locale: model.interfaceLocale)) {
                    Text(verbatim: "dashboard.snapshot · \(failure.kind.rawValue)" +
                         (failure.phase.map { " · \($0.rawValue)" } ?? ""))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("dashboard-read-failure")
    }
}
