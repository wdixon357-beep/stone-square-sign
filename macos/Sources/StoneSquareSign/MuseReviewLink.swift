import Foundation

struct MuseReviewLink: Identifiable, Equatable {
    enum Kind: String {
        case review
        case signature
    }

    let kind: Kind
    let requestID: String
    var id: String { "\(kind.rawValue)/\(requestID)" }

    init?(url: URL) {
        let prefix = "stonesquaresign://muse/"
        let address = url.absoluteString
        guard address.hasPrefix(prefix) else { return nil }
        let path = address.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
        guard path.count == 2, let kind = Kind(rawValue: String(path[0])),
              Self.isRequestID(String(path[1])) else { return nil }
        self.kind = kind
        self.requestID = String(path[1])
    }

    static func isRequestID(_ id: String) -> Bool {
        (1...128).contains(id.utf8.count) && id.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
}
