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

    private static var relativeFormatters: [String: RelativeDateTimeFormatter] = [:]
    private static var dateFormatters: [String: DateFormatter] = [:]
    private static var durationFormatters: [String: DateComponentsFormatter] = [:]

    public static func parseDate(_ value: String) -> Date? {
        fractionalISO.date(from: value) ?? standardISO.date(from: value)
    }

    public static func relative(
        _ value: String,
        relativeTo now: Date = Date(),
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        guard let date = parseDate(value) else { return value }
        let key = locale.identifier
        if let formatter = relativeFormatters[key] {
            return formatter.localizedString(for: date, relativeTo: now)
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = locale
        relativeFormatters[key] = formatter
        return formatter.localizedString(for: date, relativeTo: now)
    }

    public static func dateTime(
        _ value: String,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        guard let date = parseDate(value) else { return value }
        let key = locale.identifier
        if let formatter = dateFormatters[key] {
            return formatter.string(from: date)
        }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.locale = locale
        dateFormatters[key] = formatter
        return formatter.string(from: date)
    }

    public static func duration(
        _ milliseconds: Int,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let seconds = max(0, milliseconds / 1_000)
        let units: NSCalendar.Unit
        let range: String
        if seconds < 60 {
            units = [.second]
            range = "seconds"
        } else if seconds < 3_600 {
            units = [.minute, .second]
            range = "minutes"
        } else {
            units = [.hour, .minute]
            range = "hours"
        }
        let key = "\(locale.identifier):\(range)"
        if let formatter = durationFormatters[key] {
            return formatter.string(from: TimeInterval(seconds)) ?? String(seconds)
        }
        let formatter = DateComponentsFormatter()
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        formatter.calendar = calendar
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = [.dropLeading]
        formatter.allowedUnits = units
        durationFormatters[key] = formatter
        return formatter.string(from: TimeInterval(seconds)) ?? String(seconds)
    }
}
