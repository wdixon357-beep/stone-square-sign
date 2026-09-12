import Foundation

@main struct MinutesDateTests {
    static func main() {
        var passed = 0
        func check(_ name: String, _ value: @autoclosure () -> Bool) {
            precondition(value(), name)
            passed += 1
            print("PASS: \(name)")
        }
        let human = "Thursday, September 17, 2026"
        check("blank dates stay blank", MinutesDateText.display(nil).isEmpty && MinutesDateText.display("").isEmpty)
        check("ISO date includes weekday month day and year", MinutesDateText.display("2026-09-17") == human)
        check("weekday before ISO date is not duplicated", MinutesDateText.display("Thursday, 2026-09-17") == human)
        check("existing human date has the same presentation", MinutesDateText.display(human) == human)
        check("US numeric date has the same presentation", MinutesDateText.display("9/17/2026") == human)
        check("weekday before numeric date is not duplicated", MinutesDateText.display("Thu, 9/17/2026") == human)
        check("month abbreviations have the same presentation", MinutesDateText.display("Thu, Sept. 17, 2026") == human)
        let details = "Next communication: September 17, 2026 at 7:30 PM in the meeting hall."
        check("display retains next meeting prose time and location", MinutesDateText.display(details) == "Next communication: \(human) at 7:30 PM in the meeting hall.")
        let selected = MinutesDateText.match("2026-10-01")!.date
        check("calendar changes only next meeting date", MinutesDateText.replacingDate(in: details, with: selected, preservingDetails: true) == "Next communication: Thursday, October 1, 2026 at 7:30 PM in the meeting hall.")
        check("calendar keeps meeting date storage compatible", MinutesDateText.replacingDate(in: "2026-09-17", with: selected, preservingDetails: false) == "2026-10-01")
        check("choosing date for time-only text preserves all details", MinutesDateText.replacingDate(in: "7:30 PM in the meeting hall", with: selected, preservingDetails: true) == "Thursday, October 1, 2026 7:30 PM in the meeting hall")
        check("incomplete dates never acquire an invented year", MinutesDateText.display("September 17 at 7:30 PM") == "September 17 at 7:30 PM")
        check("invalid calendar dates remain available for correction", MinutesDateText.match("2026-02-30") == nil && MinutesDateText.display("2026-02-30") == "2026-02-30")
        let twoDates = "September 17, 2026 or October 1, 2026"
        check("multiple possible dates require deliberate editing", MinutesDateText.match(twoDates) == nil && MinutesDateText.display(twoDates) == twoDates)
        let invalidAndValid = "2026-02-30 or September 17, 2026"
        check("invalid and valid date candidates remain ambiguous", MinutesDateText.match(invalidAndValid) == nil && MinutesDateText.display(invalidAndValid) == invalidAndValid)
        print("\(passed) native minutes date checks passed.")
    }
}
