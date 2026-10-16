import SwiftUI

/// All retained content uses the same display-only connection observation.
struct ConnectionObservationNotice: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if model.hasRetainedBridgeObservation {
            VStack(alignment: .leading, spacing: 3) {
                Label(BridgeAppLocalization.string(model.isBridgeConnectionChecking
                    ? "macos.checkingthebridgeconnection" : "macos.cannotconnecttothebridgeserver", locale: model.interfaceLocale),
                      systemImage: "clock.badge.exclamationmark")
                if let checked = model.lastConfirmedConnectionCheck {
                    HStack {
                        Text("macos.lastchecked")
                        Text(checked, style: .time)
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .accessibilityIdentifier("connection-observation-unconfirmed")
        }
    }
}
