import SwiftUI

struct AccessCapability: Decodable, Identifiable { let id: String; let label: String }
struct AccessAccount: Decodable, Identifiable {
    var id: String { key }
    let key: String; let name: String; let email: String; let role: String
    let pending: Bool; let revoked: Bool; let permissions: [String]
}
enum AccessPermissions {
    static let duesManagerRoles = User.duesManagerRoles
    static func normalized(_ selected: Set<String>, role: String? = nil) -> Set<String> {
        var values = selected
        if let role, !duesManagerRoles.contains(role) { values.remove("dues.manage") }
        if values.contains("building.decide") { values.insert("building.view") }
        if values.contains("calendar.manage") { values.insert("calendar.view") }
        if values.contains("minutes.prepare") { values.insert("minutes.view") }
        if values.contains("treasury.prepare") || values.contains("treasury.upload") { values.insert("treasury.view") }
        if values.contains("documents.sign") { values.insert("documents.status") }
        if values.contains("candidates.edit") { values.insert("candidates.view") }
        if let role, ["secretary", "assistant_secretary", "treasurer", "assistant_treasurer", "treasury_preparer", "warden", "officer"].contains(role) {
            values.insert("minutes.view"); values.insert("treasury.view")
        }
        return values
    }
}

struct AccountAccessResponse: Decodable { let capabilities: [AccessCapability]; let accounts: [AccessAccount] }

struct NativeAccountPermissionsView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var hasUnsavedChanges: Bool
    @State private var accounts: [AccessAccount] = []
    @State private var capabilities: [AccessCapability] = []
    @State private var drafts: [String: Set<String>] = [:]
    @State private var busy = false
    @State private var loading = true
    @State private var message = ""
    @State private var selectedAccountKey = ""
    @State private var selectedWorkArea = ""

    private func workArea(for capability: AccessCapability) -> String {
        String(capability.id.split(separator: ".", maxSplits: 1).first ?? "other")
    }

    private var workAreas: [String] {
        Array(Set(capabilities.map(workArea))).sorted()
    }

    private func workAreaTitle(_ key: String) -> String {
        switch key {
        case "minutes": return "Meeting Minutes"
        case "treasury": return "Treasurer Reports"
        case "dues": return "Dues And Finance"
        case "documents": return "Documents And Approvals"
        case "building": return "Building Requests"
        case "calendar": return "Lodge Calendar"
        case "candidates": return "Candidate Tracker"
        default: return key.capitalized
        }
    }
    private func capabilityTitle(_ label: String) -> String {
        label.capitalized
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose An Account And Work Area To Review Access. Save Any Changes Before Closing This Window.")
                .font(.callout).foregroundStyle(.secondary)
            if loading { ProgressView("Loading Account Permissions…") }
            if !loading && accounts.isEmpty && message.isEmpty {
                Text("No Accounts Are Available To Manage.").foregroundStyle(.secondary)
            }
            if !accounts.isEmpty {
                Picker("Account", selection: $selectedAccountKey) {
                    ForEach(accounts) { account in
                        Text("\(account.name) · \(account.email)\(account.pending ? " · Invited" : account.revoked ? " · Revoked" : "")").tag(account.key)
                    }
                }
                .pickerStyle(.menu)
            }
            if let account = accounts.first(where: { $0.key == selectedAccountKey }) {
                Text("\(User.roleLabel(for: account.role)) · \(account.email)")
                    .font(.callout).foregroundStyle(.secondary)
                Divider()
                if account.role == "owner" {
                    Text("The Worshipful Master Retains Full Access.")
                } else {
                    Picker("Work Area", selection: $selectedWorkArea) {
                        Text("Choose A Work Area").tag("")
                        ForEach(workAreas, id: \.self) { key in
                            Text(workAreaTitle(key)).tag(key)
                        }
                    }
                    .pickerStyle(.menu)
                    if selectedWorkArea.isEmpty {
                        Text("Choose A Work Area To Review Its Permissions.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        ForEach(capabilities.filter { workArea(for: $0) == selectedWorkArea && ($0.id != "dues.manage" || AccessPermissions.duesManagerRoles.contains(account.role) || account.permissions.contains("dues.manage")) }) { capability in
                            Toggle(capabilityTitle(capability.label), isOn: Binding(get: { (drafts[account.key] ?? Set(account.permissions)).contains(capability.id) }, set: { enabled in
                                var values = drafts[account.key] ?? Set(account.permissions)
                                if enabled && (capability.id != "dues.manage" || AccessPermissions.duesManagerRoles.contains(account.role)) { values.insert(capability.id) }
                                else { values.remove(capability.id) }
                                drafts[account.key] = values == Set(account.permissions) ? nil : values
                            }))
                            .toggleStyle(.checkbox)
                            .disabled((!["owner", "secretary", "assistant_secretary", "treasurer", "assistant_treasurer"].contains(account.role) && capability.id == "dues.manage" && !(drafts[account.key] ?? Set(account.permissions)).contains("dues.manage")) || (["secretary", "assistant_secretary", "treasurer", "assistant_treasurer", "treasury_preparer", "warden", "officer"].contains(account.role) && ["minutes.view", "treasury.view"].contains(capability.id)))
                        }
                    }
                    Button("Save Permissions") { Task { await save(account) } }
                        .disabled(drafts[account.key] == nil || drafts[account.key] == Set(account.permissions))
                }
            }
            if hasUnsavedChanges {
                Button("Discard Changes") { drafts = [:] }
            }
            if busy { ProgressView() }
            if !message.isEmpty { Text(message) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(busy)
        .task { await refresh() }
        .onChange(of: drafts) { _, newValue in hasUnsavedChanges = !newValue.isEmpty }
        .updateDraftGuard(active: !drafts.isEmpty || busy, reason: "Save your permission changes before updating.")
    }
    private func refresh() async {
        loading = true
        message = ""
        defer { loading = false }
        do {
            let response: AccountAccessResponse = try await model.request("/api/admin/access")
            accounts = response.accounts; capabilities = response.capabilities
            if !accounts.contains(where: { $0.key == selectedAccountKey }) {
                selectedAccountKey = accounts.first(where: { $0.role != "owner" && !$0.revoked })?.key ?? accounts.first?.key ?? ""
            }
        } catch {
            accounts = []
            capabilities = []
            message = "Account permissions could not load: \(error.localizedDescription)"
        }
    }
    private func save(_ account: AccessAccount) async {
        guard !busy, account.role != "owner", let values = drafts[account.key] else { return }
        let normalized = AccessPermissions.normalized(values, role: account.role)
        busy = true; defer { busy = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["key": account.key, "permissions": normalized.sorted()])
            let _: EmptyResponse = try await model.request("/api/admin/access", method: "PUT", body: body)
            let result: AccountAccessResponse = try await model.request("/api/admin/access")
            accounts = result.accounts; capabilities = result.capabilities
            guard result.accounts.first(where: { $0.key == account.key }).map({ Set($0.permissions) == normalized }) == true else {
                message = "The saved permissions differ from your selection. Review this person's permissions again."
                return
            }
            drafts[account.key] = nil
            message = "Permissions saved for \(account.name)." + (normalized == values ? "" : " The related record view was enabled too.")
        } catch { message = error.localizedDescription }
    }
}
