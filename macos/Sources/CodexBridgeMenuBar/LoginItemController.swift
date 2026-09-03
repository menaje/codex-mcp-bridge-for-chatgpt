import ServiceManagement

enum MenuBarLoginItemStatus: Equatable {
    case notRegistered
    case enabled
    case requiresApproval
    case notFound
    case unknown

    var isEnabled: Bool {
        self == .enabled
    }
}

@MainActor
protocol LoginItemControlling: AnyObject {
    var status: MenuBarLoginItemStatus { get }
    func register() throws
    func unregister() throws
    func openSystemSettings()
}

@MainActor
final class ServiceManagementLoginItemController: LoginItemControlling {
    private let service: SMAppService

    init(service: SMAppService = .mainApp) {
        self.service = service
    }

    var status: MenuBarLoginItemStatus {
        switch service.status {
        case .notRegistered:
            return .notRegistered
        case .enabled:
            return .enabled
        case .requiresApproval:
            return .requiresApproval
        case .notFound:
            return .notFound
        @unknown default:
            return .unknown
        }
    }

    func register() throws {
        try service.register()
    }

    func unregister() throws {
        try service.unregister()
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
