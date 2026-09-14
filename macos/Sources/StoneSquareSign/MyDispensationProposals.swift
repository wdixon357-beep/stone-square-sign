import SwiftUI

struct MyDispensationProposalsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var draft = DispensationProposalDraft()
    @State private var showingForm = false
    @State private var confirmSubmit = false
    @State private var confirmDiscard = false
    @State private var submitting = false
    @State private var message = ""
    @State private var messageIsWarning = false

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "My Dispensation Proposals", subtitle: "Submit a request and follow its progress", symbol: "square.and.pencil") {
                Button("Refresh") { Task { await model.loadProposals() } }.disabled(model.proposalsLoading)
                Button("New proposal") { showingForm = true }.buttonStyle(.borderedProminent)
            }
            Form {
                if showingForm {
                    Section("New dispensation proposal") {
                        Text("Requested activity (required)").font(.headline)
                        Text("Describe the activity and permission requested. Enter its date, time and venue below.").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $draft.requestDetails).frame(minHeight: 110).accessibilityLabel("Requested activity")
                        TextField("Event date (YYYY-MM-DD, required)", text: $draft.eventDate)
                        TextField("Event time", text: $draft.eventTime)
                        TextField("Venue name", text: $draft.locationName)
                        TextField("Street address", text: $draft.streetAddress)
                        TextField("City and state", text: $draft.cityState)
                        DisclosureGroup("Additional context for the Worshipful Master (optional)") {
                            TextField("Additional context", text: $draft.proposerNote, axis: .vertical).lineLimit(3...6)
                        }
                        Text("The Worshipful Master reviews the proposal before a dispensation is prepared.").font(.caption).foregroundStyle(.secondary)
                        if draft.hasContent, let validation = draft.validationMessage { Text(validation).font(.caption).foregroundStyle(.secondary) }
                        HStack {
                            Button("Discard proposal", role: .destructive) { confirmDiscard = true }.disabled(!draft.hasContent || submitting)
                            Spacer()
                            Button("Submit proposal") { confirmSubmit = true }.buttonStyle(.borderedProminent).disabled(!draft.isReady || submitting)
                        }
                    }.disabled(submitting)
                }
                Section("Your proposals") {
                    if model.proposalsLoading && model.proposals.isEmpty { ProgressView("Loading proposals…") }
                    else if model.proposals.isEmpty { Text("Your submitted proposals will appear here.").foregroundStyle(.secondary) }
                    ForEach(model.proposals) { proposal in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(proposal.displayTitle).font(.headline)
                                Spacer()
                                Text(proposal.verdict).font(.subheadline.weight(.medium))
                            }
                            if let date = proposal.eventDate, !date.isEmpty { Text("Event date: \(LodgeCalendarDates.displayDate(date))") }
                            if let details = proposal.requestDetails, !details.isEmpty { Text(details).textSelection(.enabled) }
                            if let note = proposal.wmNote, !note.isEmpty {
                                Text("Worshipful Master's response: \(note)").font(.callout)
                            }
                            if let document = proposal.document {
                                if let status = document.status { Text("Dispensation status: \(status.replacingOccurrences(of: "_", with: " ").capitalized)") }
                                if let approval = document.approvalStatus { Text("Approval status: \(approval.replacingOccurrences(of: "_", with: " ").capitalized)") }
                                if let submitted = document.submittedAt, !submitted.isEmpty { Text("Submitted: \(LodgeDateTime.display(submitted))").font(.caption) }
                            }
                        }.padding(.vertical, 8)
                    }
                }
                if !model.proposalsError.isEmpty { Text(model.proposalsError).foregroundStyle(.red) }
                if !message.isEmpty {
                    if messageIsWarning { Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Text(message).foregroundStyle(.secondary) }
                }
            }.formStyle(.grouped)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await model.loadProposals() }
        .updateDraftGuard(active: draft.hasContent || submitting, reason: "Finish your dispensation proposal before updating. Your entered details are still open.")
        .alert("Submit this proposal?", isPresented: $confirmSubmit) {
            Button("Submit proposal") {
                submitting = true
                Task {
                    if await model.submitProposal(draft) {
                        draft = DispensationProposalDraft(); showingForm = false
                        message = model.message
                        messageIsWarning = model.messageIsWarning
                    }
                    submitting = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The Worshipful Master will receive your request and note.") }
        .alert("Discard this proposal draft?", isPresented: $confirmDiscard) {
            Button("Discard proposal", role: .destructive) { draft = DispensationProposalDraft(); showingForm = false }
            Button("Keep editing", role: .cancel) {}
        } message: { Text("The proposal details entered here have not been submitted.") }
    }
}
