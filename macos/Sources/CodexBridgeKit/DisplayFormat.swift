import Foundation

@MainActor
public enum DisplayFormat {
    private static let fractionalISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let standardISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    public static func parseDate(_ value: String) -> Date? {
        fractionalISO.date(from: value) ?? standardISO.date(from: value)
    }

    public static func relative(_ value: String, relativeTo now: Date = Date()) -> String {
        guard let date = parseDate(value) else { return value }
        return relativeFormatter.localizedString(for: date, relativeTo: now)
    }

    public static func dateTime(_ value: String) -> String {
        guard let date = parseDate(value) else { return value }
        return dateFormatter.string(from: date)
    }

    public static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1_000)
        if seconds < 60 { return "\(seconds)초" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)분 \(seconds % 60)초" }
        let hours = minutes / 60
        return "\(hours)시간 \(minutes % 60)분"
    }
}
