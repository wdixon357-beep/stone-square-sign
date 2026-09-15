import Foundation

/// Display explicit meeting dates consistently without interpreting incomplete
/// dates or discarding the prose around a next-meeting date.
enum MinutesDateText {
    struct Match {
        let date: Date
        let range: Range<String.Index>
    }

    static var calendar: Calendar {
        var result = Calendar(identifier: .gregorian)
        result.locale = Locale(identifier: "en_US_POSIX")
        result.timeZone = TimeZone(identifier: "America/New_York")!
        return result
    }

    private static let months = [
        "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
        "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
        "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
        "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
    ]

    static func match(_ text: String) -> Match? {
        let weekday = "(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun),?\\s+)?"
        let monthNames = months.keys.sorted().joined(separator: "|")
        let patterns = [
            "(?<![A-Za-z\\d-])" + weekday + "(\\d{4})-(\\d{2})-(\\d{2})(?![\\dT])",
            "(?<![A-Za-z\\d])" + weekday + "(\\d{1,2})/(\\d{1,2})/(\\d{4})(?!\\d)",
            "\\b" + weekday + "(" + monthNames + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)",
        ]
        var found: [Match] = []
        var candidateCount = 0
        for (kind, pattern) in patterns.enumerated() {
            guard let expression = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { continue }
            for result in expression.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                candidateCount += 1
                func group(_ index: Int) -> String {
                    Range(result.range(at: index), in: text).map { String(text[$0]) } ?? ""
                }
                let year = Int(group(kind == 0 ? 1 : 3))
                let month = kind == 2 ? months[group(1).lowercased()] : Int(group(kind == 0 ? 2 : 1))
                let day = Int(group(kind == 0 ? 3 : 2))
                guard let year, let month, let day, (1...9999).contains(year),
                      let date = calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12)),
                      let range = Range(result.range, in: text) else { continue }
                let actual = calendar.dateComponents([.year, .month, .day], from: date)
                guard actual.year == year, actual.month == month, actual.day == day else { continue }
                found.append(Match(date: date, range: range))
            }
        }
        // A sentence containing several dates requires a deliberate text edit.
        return candidateCount == 1 && found.count == 1 ? found[0] : nil
    }

    private static func format(_ date: Date, pattern: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }

    static func display(_ raw: String?) -> String {
        let text = raw ?? ""
        guard let match = match(text) else { return text }
        return text.replacingCharacters(in: match.range, with: format(match.date, pattern: "EEEE, MMMM d, yyyy"))
    }

    static func monthDayYear(_ raw: String?) -> String {
        let text = raw ?? ""
        guard let match = match(text) else { return text.isEmpty ? "Date needs review" : text }
        return format(match.date, pattern: "MMMM d, yyyy")
    }

    static func minutesTitle(_ raw: String?) -> String {
        "Meeting Minutes, \(monthDayYear(raw))"
    }

    static func replacingDate(in raw: String, with date: Date, preservingDetails: Bool) -> String {
        guard preservingDetails else { return format(date, pattern: "yyyy-MM-dd") }
        let formatted = format(date, pattern: "EEEE, MMMM d, yyyy")
        if let match = match(raw) { return raw.replacingCharacters(in: match.range, with: formatted) }
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return formatted }
        return formatted + " " + raw
    }
}
