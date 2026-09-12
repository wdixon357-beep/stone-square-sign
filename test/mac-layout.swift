// Read-only geometry check for the installed Mac app. This complements, and
// does not replace, screenshots of the notice, dismissed state and resized UI.
// Run: swift test/mac-layout.swift --page treasury --notice visible
// Run the geometry regression fixtures: swift test/mac-layout.swift --self-test
import AppKit
import ApplicationServices
import Foundation

struct Bounds: Codable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    init(_ rect: CGRect) {
        x = rect.minX; y = rect.minY; width = rect.width; height = rect.height
    }
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct Landmark: Codable {
    let name: String
    let bounds: Bounds
    init(_ name: String, _ rect: CGRect) { self.name = name; bounds = Bounds(rect) }
}

struct LayoutSnapshot: Codable {
    var window: Bounds
    var chromeBottom: Double
    var split: Bounds?
    var selectedPage: String?
    var landmarks: [Landmark]
}

let pageNames = ["home": "Home", "minutes": "Meeting Minutes", "treasury": "Treasurer Reports", "reports": "Report Generator"]
let noticeTitlePrefix = "You will stay signed in for "
let noticeExplanationPrefix = "Your sign-in renews automatically"
let noticeButton = "Dismiss sign-in notice"
let permittedLabels: Set<String> = Set(pageNames.values).union(["STONE SQUARE", "LODGE DASHBOARD", "Got it", noticeButton])

func validate(_ snapshot: LayoutSnapshot, page: String, noticeVisible: Bool) -> [String] {
    var failures: [String] = []
    let window = snapshot.window.rect
    let content = CGRect(x: window.minX, y: snapshot.chromeBottom + 4,
                         width: window.width, height: window.maxY - snapshot.chromeBottom - 4)
    func inside(_ rect: CGRect, _ outer: CGRect) -> Bool {
        rect.width > 0 && rect.height > 0 && outer.insetBy(dx: -1, dy: -1).contains(rect)
    }
    func landmark(_ name: String) -> CGRect? { snapshot.landmarks.first { $0.name == name }?.bounds.rect }
    if snapshot.selectedPage != page { failures.append("Expected selected page \(page); selection differs or is unavailable") }
    if let split = snapshot.split?.rect, !inside(split, window) {
        failures.append("Navigation workspace extends outside the actual window")
    }
    for required in ["sidebar-brand", "sidebar-subtitle", "page-heading"] {
        guard let bounds = landmark(required) else { failures.append("Missing \(required)"); continue }
        if !inside(bounds, content) { failures.append("\(required) is outside visible content or under the title bar") }
    }
    if let brand = landmark("sidebar-brand"), let heading = landmark("page-heading"), brand.intersects(heading) {
        failures.append("Sidebar brand and selected page heading overlap")
    }
    let noticeParts = snapshot.landmarks.filter { $0.name.hasPrefix("notice-") }
    if noticeVisible {
        for required in ["notice-title", "notice-explanation", "notice-dismiss"] {
            if landmark(required) == nil { failures.append("Expected visible \(required)") }
        }
        for part in noticeParts {
            let rect = part.bounds.rect
            if !inside(rect, content) { failures.append("\(part.name) is outside visible content or under the title bar") }
            for other in ["sidebar-brand", "sidebar-subtitle", "page-heading"] {
                if let otherRect = landmark(other), rect.intersects(otherRect) {
                    failures.append("\(part.name) overlaps \(other)")
                }
            }
        }
        if let heading = landmark("page-heading"), let bottom = noticeParts.map({ $0.bounds.rect.maxY }).max(), heading.minY < bottom + 4 {
            failures.append("Selected page heading does not sit below the notice")
        }
    } else if !noticeParts.isEmpty { failures.append("Sign-in notice remains present after dismissal") }
    return failures
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func bounds(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

func label(_ element: AXUIElement) -> String? {
    // Only retain the fixed labels this check needs. Never print form values,
    // account names, report contents, accessibility dumps or credentials.
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let value = attribute(element, key) as? String,
           permittedLabels.contains(value) || value.hasPrefix(noticeTitlePrefix) || value.hasPrefix(noticeExplanationPrefix) {
            return value
        }
    }
    return nil
}

func capture(page: String) throws -> LayoutSnapshot {
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.dstechnology.stonesquare.sign" }) else {
        throw NSError(domain: "MacLayout", code: 1, userInfo: [NSLocalizedDescriptionKey: "Open the installed Stone Square Sign app and select the page first."])
    }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    guard let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
          let window = windows.first(where: { (attribute($0, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole }),
          let windowBounds = bounds(window) else {
        throw NSError(domain: "MacLayout", code: 2, userInfo: [NSLocalizedDescriptionKey: "The native window is unavailable. Confirm it is open and Accessibility access is enabled for this runner."])
    }
    var snapshot = LayoutSnapshot(window: Bounds(windowBounds), chromeBottom: windowBounds.minY + 28, split: nil, selectedPage: nil, landmarks: [])
    var headingCandidates: [CGRect] = []
    var visited = 0
    func scan(_ element: AXUIElement, depth: Int = 0, inRow: Bool = false, selectedRow: Bool = false) {
        guard depth < 24, visited < 12000 else { return }
        visited += 1
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        if role == kAXMenuBarRole { return }
        let isRow = inRow || role == kAXRowRole
        let selected = selectedRow || (role == kAXRowRole && (attribute(element, kAXSelectedAttribute) as? Bool == true))
        let rect = bounds(element)
        // The unified toolbar can extend below the traffic-light controls.
        // A heading inside that extra area is still clipped by window chrome.
        if role == kAXToolbarRole, let rect, rect.minY <= windowBounds.minY + 1 {
            snapshot.chromeBottom = max(snapshot.chromeBottom, rect.maxY)
        }
        if let subrole = attribute(element, kAXSubroleAttribute) as? String,
           [kAXCloseButtonSubrole, kAXMinimizeButtonSubrole, kAXZoomButtonSubrole, "AXFullScreenButton"].contains(subrole), let rect {
            snapshot.chromeBottom = max(snapshot.chromeBottom, rect.maxY)
        }
        if role == kAXSplitGroupRole, snapshot.split == nil, let rect { snapshot.split = Bounds(rect) }
        if let text = label(element), let rect {
            if selected, pageNames.values.contains(text) { snapshot.selectedPage = text }
            if !isRow {
                let key: String?
                if text == "STONE SQUARE" { key = "sidebar-brand" }
                else if text == "LODGE DASHBOARD" { key = "sidebar-subtitle" }
                else if text.hasPrefix(noticeTitlePrefix) { key = "notice-title" }
                else if text.hasPrefix(noticeExplanationPrefix) { key = "notice-explanation" }
                else if text == noticeButton || text == "Got it" { key = "notice-dismiss" }
                else { key = nil }
                if let key, !snapshot.landmarks.contains(where: { $0.name == key }) { snapshot.landmarks.append(Landmark(key, rect)) }
                if text == page { headingCandidates.append(rect) }
            }
        }
        for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
            scan(child, depth: depth + 1, inRow: isRow, selectedRow: selected)
        }
    }
    scan(window)
    // Home includes navigation cards with the same labels as sidebar items.
    // The actual workspace heading is the topmost non-row occurrence.
    if let heading = headingCandidates.min(by: { $0.minY < $1.minY }) { snapshot.landmarks.append(Landmark("page-heading", heading)) }
    return snapshot
}

func selfTest() {
    let base = LayoutSnapshot(
        window: Bounds(CGRect(x: 80, y: 40, width: 1280, height: 850)), chromeBottom: 80,
        split: Bounds(CGRect(x: 80, y: 80, width: 1280, height: 810)), selectedPage: "Treasurer Reports",
        landmarks: [Landmark("sidebar-brand", CGRect(x: 102, y: 104, width: 155, height: 20)),
                    Landmark("sidebar-subtitle", CGRect(x: 102, y: 128, width: 150, height: 15)),
                    Landmark("page-heading", CGRect(x: 430, y: 220, width: 230, height: 26)),
                    Landmark("notice-title", CGRect(x: 430, y: 102, width: 570, height: 20)),
                    Landmark("notice-explanation", CGRect(x: 430, y: 126, width: 740, height: 40)),
                    Landmark("notice-dismiss", CGRect(x: 1230, y: 102, width: 80, height: 26))])
    var count = 0
    func check(_ name: String, _ snapshot: LayoutSnapshot, visible: Bool = true, failure: String? = nil) {
        let result = validate(snapshot, page: "Treasurer Reports", noticeVisible: visible)
        precondition(failure.map { expected in result.contains { $0.contains(expected) } } ?? result.isEmpty, "\(name): \(result)")
        count += 1; print("PASS: \(name)")
    }
    check("notice visible with separate sidebar and page heading", base)
    var dismissed = base; dismissed.landmarks.removeAll { $0.name.hasPrefix("notice-") }
    dismissed.landmarks.removeAll { $0.name == "page-heading" }; dismissed.landmarks.append(Landmark("page-heading", CGRect(x: 430, y: 104, width: 230, height: 26)))
    check("notice dismissed without shifting the heading under the title bar", dismissed, visible: false)
    var overflow = base; overflow.split = Bounds(CGRect(x: 80, y: -747, width: 1280, height: 2424))
    check("oversized navigation workspace is rejected", overflow, failure: "Navigation workspace")
    var wide = base
    wide.window = Bounds(CGRect(x: 0, y: 33, width: 1121, height: 868))
    wide.split = Bounds(CGRect(x: -36, y: 33, width: 1193, height: 868))
    check("split wider than the resized window is rejected", wide, failure: "Navigation workspace")
    var clipped = dismissed; clipped.landmarks.removeAll { $0.name == "page-heading" }; clipped.landmarks.append(Landmark("page-heading", CGRect(x: 430, y: 61, width: 230, height: 26)))
    check("dismissed heading beneath title bar is rejected", clipped, visible: false, failure: "page-heading is outside")
    var overlap = base; overlap.landmarks.removeAll { $0.name == "notice-title" }; overlap.landmarks.append(Landmark("notice-title", CGRect(x: 105, y: 104, width: 780, height: 20)))
    check("notice over sidebar branding is rejected", overlap, failure: "overlaps sidebar-brand")
    var hiddenBrand = base; hiddenBrand.landmarks.removeAll { $0.name == "sidebar-brand" }; hiddenBrand.landmarks.append(Landmark("sidebar-brand", CGRect(x: 102, y: -100, width: 155, height: 20)))
    check("offscreen sidebar branding is rejected", hiddenBrand, failure: "sidebar-brand is outside")
    check("missing notice is rejected when visible state is expected", dismissed, failure: "Expected visible")
    check("undismissed notice is rejected when dismissed state is expected", base, visible: false, failure: "remains present")
    var wrongPage = base; wrongPage.selectedPage = "Home"
    check("wrong selected page cannot pass", wrongPage, failure: "Expected selected page")
    print("\(count) Mac layout geometry regression checks passed.")
}

let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--self-test") { selfTest(); exit(0) }
func option(_ name: String) -> String? {
    guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else { return nil }
    return args[index + 1]
}
guard let key = option("--page"), let page = pageNames[key], let notice = option("--notice"), ["visible", "dismissed"].contains(notice) else {
    print("Usage: swift test/mac-layout.swift --page home|minutes|treasury|reports --notice visible|dismissed [--json]")
    print("Read-only: select the page and notice state in the installed app before running. Also inspect an actual screenshot.")
    exit(2)
}
do {
    let snapshot = try capture(page: page)
    let failures = validate(snapshot, page: page, noticeVisible: notice == "visible")
    if args.contains("--json") {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        print(String(decoding: try encoder.encode(snapshot), as: UTF8.self))
    }
    if failures.isEmpty { print("PASS: \(page), notice \(notice), landmarks contained and separated") }
    else { failures.forEach { print("FAIL: \($0)") } }
    exit(failures.isEmpty ? 0 : 1)
} catch {
    print("UNAVAILABLE: \(error.localizedDescription)")
    exit(2)
}
