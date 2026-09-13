import SwiftUI

struct AccessCapability: Decodable, Identifiable { let id: String; let label: String }
struct AccessAccount: Decodable, Identifiable {
    var id: String { key }
    let key: String; let name: String; let email: String; let role: String
    let pending: Bool; let revoked: Bool; let permissions: [String]
}
enum AccessPermissions {
    static func normalized(_ selected: Set<String>) -> Set<String> {
        var values = selected
        if values.contains("minutes.prepare") { values.insert("minutes.view") }
        if values.contains("treasury.prepare") || values.contains("treasury.upload") { values.insert("treasury.view") }
        if values.contains("documents.sign") { values.insert("documents.status") }
        return values
    }
}

struct AccountAccessResponse: Decodable { let capabilities: [AccessCapability]; let accounts: [AccessAccount] }

struct NativeAccountPermissionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var accounts: [AccessAccount] = []
    @State private var capabilities: [AccessCapability] = []
    @State private var drafts: [String: Set<String>] = [:]
    @State private var busy = false
    @State private var message = ""
    var body: some View {
        GroupBox("Individual permissions") {
            VStack(alignment: .leading, spacing: 14) {
                Text("Choose the workspaces and actions assigned to each person, then save their permissions. Preparation, upload and signing access also enable the related record view.").font(.callout).foregroundStyle(.secondary)
                ForEach(accounts) { account in
                    DisclosureGroup("\(account.name) · \(account.pending ? "Invited" : account.revoked ? "Revoked" : User.roleLabel(for: account.role))") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(account.email).font(.caption).foregroundStyle(.secondary)
                            if account.role == "owner" { Text("The Worshipful Master retains full access.").font(.callout) }
                            else {
                                ForEach(capabilities) { capability in
                                    Toggle(capability.label, isOn: Binding(get: { (drafts[account.key] ?? Set(account.permissions)).contains(capability.id) }, set: { enabled in
                                        var values = drafts[account.key] ?? Set(account.permissions)
                                        if enabled { values.insert(capability.id) } else { values.remove(capability.id) }
                                        drafts[account.key] = values == Set(account.permissions) ? nil : values
                                    })).toggleStyle(.checkbox)
                                }
                                Button("Save permissions") { Task { await save(account) } }
                                    .disabled(drafts[account.key] == nil || drafts[account.key] == Set(account.permissions))
                            }
                        }.padding(12)
                    }
                }
                if busy { ProgressView() }
                if !message.isEmpty { Text(message).font(.callout) }
            }.padding(12).disabled(busy)
        }
        .task { await refresh() }
        .updateDraftGuard(active: !drafts.isEmpty || busy, reason: "Save your permission changes before updating.")
    }
    private func refresh() async {
        do {
            let response: AccountAccessResponse = try await model.request("/api/admin/access")
            accounts = response.accounts; capabilities = response.capabilities
        } catch { message = error.localizedDescription }
    }
    private func save(_ account: AccessAccount) async {
        guard !busy, account.role != "owner", let values = drafts[account.key] else { return }
        let normalized = AccessPermissions.normalized(values)
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
