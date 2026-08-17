import AppKit
import SwiftUI
import UniformTypeIdentifiers

enum SignTheme {
    static let navy = Color(red: 0.03, green: 0.11, blue: 0.19)
    static let blue = Color(red: 0.05, green: 0.24, blue: 0.39)
    static let gold = Color(red: 0.78, green: 0.60, blue: 0.26)
    static let ivory = Color(red: 0.96, green: 0.94, blue: 0.89)
}

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @State private var showRequiredSignature = false

    var body: some View {
        Group {
            if model.user == nil { AuthenticationView() }
            else { WorkspaceView() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) {
            if !model.message.isEmpty {
                Label(
                    model.message,
                    systemImage: model.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
                )
                .font(.callout.weight(.semibold))
                .foregroundStyle(model.isError ? .red : .green)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .shadow(radius: 12)
                .padding(.bottom, 18)
            }
        }
        .task { await model.restoreSession() }
        .onChange(of: model.user) { _, user in
            showRequiredSignature = user?.hasSignature == false
        }
        .sheet(isPresented: $showRequiredSignature) {
            SignatureSetupView(required: true)
                .interactiveDismissDisabled(true)
        }
    }
}

struct AuthenticationView: View {
    @EnvironmentObject var model: AppModel
    @State private var mode = 0
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var password = ""
    @State private var code = ""

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                LinearGradient(
                    colors: [SignTheme.navy, SignTheme.blue],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                Circle()
                    .fill(SignTheme.gold.opacity(0.16))
                    .frame(width: 420)
                    .offset(x: 240, y: -190)
                VStack(alignment: .leading, spacing: 24) {
                    Text("STONE SQUARE 22")
                        .font(.caption.weight(.bold))
                        .tracking(3)
                        .foregroundStyle(SignTheme.gold)
                    Text("Documents move.\nRecords remain.")
                        .font(.system(size: 54, weight: .medium, design: .serif))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .minimumScaleFactor(0.72)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("A private signing desk for Lodge officers and retained records.")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.68))
                        .frame(maxWidth: 460, alignment: .leading)
                    HStack(spacing: 28) {
                        LoginStep(number: "01", text: "Upload")
                        LoginStep(number: "02", text: "Identify")
                        LoginStep(number: "03", text: "Sign")
                    }
                    .padding(.top, 32)
                }
                .padding(58)
            }
            .frame(minWidth: 560, maxHeight: .infinity)

            VStack(spacing: 26) {
                Picker("Access", selection: $mode) {
                    Text("Sign in").tag(0)
                    Text("Owner setup").tag(1)
                    Text("Reset").tag(2)
                }
                .pickerStyle(.segmented)

                VStack(alignment: .leading, spacing: 14) {
                    Text(mode == 0 ? "Sign in to continue" : mode == 1 ? "Create owner account" : "Reset by phone")
                        .font(.system(size: 30, weight: .semibold, design: .serif))
                        .foregroundStyle(SignTheme.navy)
                    if mode == 1 { TextField("Full name", text: $name).textContentType(.name) }
                    if mode != 2 { TextField("Email address", text: $email).textContentType(.emailAddress) }
                    if mode > 0 { TextField("Mobile phone", text: $phone).textContentType(.telephoneNumber) }
                    if mode == 2 {
                        TextField("Six digit code", text: $code)
                        SecureField("New password", text: $password)
                    } else {
                        SecureField(mode == 1 ? "Create password" : "Password", text: $password)
                    }
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if model.isBusy { ProgressView().controlSize(.small) }
                            Text(buttonTitle)
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(SignTheme.navy)
                    .controlSize(.large)
                    .disabled(model.isBusy)
                    if mode == 2 {
                        Button("Send reset code") {
                            Task { await model.requestReset(phone: phone) }
                        }
                        .buttonStyle(.link)
                    }
                    Divider().padding(.vertical, 4)
                    TextField("Signing service address", text: $model.serverAddress)
                        .font(.caption)
                        .textFieldStyle(.roundedBorder)
                    Text("Use http://localhost:3000 for the local service. Replace it with the permanent HTTPS address after deployment.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 420)
            .padding(54)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private var buttonTitle: String {
        mode == 0 ? "Sign in securely" : mode == 1 ? "Create owner account" : "Set new password"
    }

    private func submit() {
        Task {
            if mode == 0 { await model.signIn(email: email, password: password) }
            else if mode == 1 { await model.createOwner(name: name, email: email, phone: phone, password: password) }
            else { await model.resetPassword(phone: phone, code: code, password: password) }
        }
    }
}

struct LoginStep: View {
    let number: String
    let text: String
    var body: some View {
        VStack(alignment: .leading) {
            Text(number).foregroundStyle(SignTheme.gold).font(.headline)
            Text(text).foregroundStyle(.white.opacity(0.65)).font(.caption)
        }
        .frame(width: 90, alignment: .leading)
        .padding(.top, 10)
        .overlay(alignment: .top) { Divider().overlay(.white.opacity(0.2)) }
    }
}

struct WorkspaceView: View {
    @EnvironmentObject var model: AppModel
    @State private var selection: AppSection? = .documents

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("STONE SQUARE").font(.headline).tracking(1.5)
                    Text("DOCUMENT SIGN").font(.caption2).tracking(2).foregroundStyle(SignTheme.gold)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
                List(selection: $selection) {
                    Label("Live Queue", systemImage: "list.number").tag(AppSection.documents)
                    if model.user?.role == "owner" {
                        Label("Officer Access", systemImage: "person.badge.key.fill").tag(AppSection.access)
                    }
                    Label("Signature Profile", systemImage: "signature").tag(AppSection.profile)
                    Label("Service Settings", systemImage: "network").tag(AppSection.settings)
                }
                .scrollContentBackground(.hidden)
                VStack(alignment: .leading, spacing: 5) {
                    Label(
                        model.isLive ? "Live queue connected" : "Reconnecting",
                        systemImage: model.isLive ? "circle.fill" : "circle.dotted"
                    )
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(model.isLive ? .green : .secondary)
                    Divider().padding(.vertical, 5)
                    Text(model.user?.name ?? "").font(.callout.weight(.semibold))
                    Text(model.user?.roleLabel ?? "").font(.caption).foregroundStyle(.secondary)
                    Button("Sign out") { model.signOut() }.buttonStyle(.link).padding(.top, 5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .background(SignTheme.navy.opacity(0.055))
        } detail: {
            switch selection {
            case .access: OfficerAccessView()
            case .profile: SignatureProfileView()
            case .settings: SettingsView()
            default: DocumentsView()
            }
        }
        .task { await model.refresh() }
    }
}

struct DocumentsView: View {
    @EnvironmentObject var model: AppModel
    @State private var showImporter = false
    @State private var signingDocument: LodgeDocument?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("REAL TIME SIGNING QUEUE")
                            .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
                        Text("Dispensation desk")
                            .font(.system(size: 40, weight: .semibold, design: .serif))
                            .foregroundStyle(SignTheme.navy)
                        Text("New requests and signatures load automatically.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.user?.role == "owner" {
                        Button("Upload Dispensation", systemImage: "arrow.up.doc.fill") {
                            showImporter = true
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(SignTheme.navy)
                        .controlSize(.large)
                    }
                }
                HStack(spacing: 16) {
                    MetricBox(label: "All records", value: model.documents.count)
                    MetricBox(label: "Awaiting signatures", value: model.documents.filter { !$0.isComplete }.count)
                    MetricBox(label: "Completed", value: model.documents.filter(\.isComplete).count)
                }
                VStack(spacing: 0) {
                    if model.documents.isEmpty {
                        ContentUnavailableView(
                            "The queue is clear",
                            systemImage: "checkmark.seal",
                            description: Text("New dispensations will appear here automatically.")
                        )
                        .frame(minHeight: 320)
                    } else {
                        ForEach(Array(model.documents.enumerated()), id: \.element.id) { index, document in
                            DocumentRow(
                                document: document,
                                queueNumber: document.isComplete ? nil : index + 1,
                                open: { Task { await model.open(document: document) } },
                                sign: { signingDocument = document }
                            )
                            if document.id != model.documents.last?.id { Divider() }
                        }
                    }
                }
                .padding(20)
                .background(.background, in: RoundedRectangle(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator.opacity(0.5)) }
            }
            .padding(36)
        }
        .background(SignTheme.ivory.opacity(0.45))
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.pdf]) { result in
            if case .success(let url) = result { Task { await model.upload(url: url) } }
        }
        .sheet(item: $signingDocument) { document in SignatureApprovalView(document: document) }
    }
}

struct MetricBox: View {
    let label: String
    let value: Int
    var body: some View {
        HStack {
            Text(label).font(.callout.weight(.medium)).foregroundStyle(.secondary)
            Spacer()
            Text("\(value)").font(.system(size: 30, weight: .medium, design: .serif)).foregroundStyle(SignTheme.navy)
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.45)) }
    }
}

struct DocumentRow: View {
    let document: LodgeDocument
    let queueNumber: Int?
    let open: () -> Void
    let sign: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Text(queueNumber.map(String.init) ?? "✓")
                .font(.caption.weight(.bold))
                .foregroundStyle(SignTheme.navy)
                .frame(width: 28, height: 28)
                .background(SignTheme.gold.opacity(0.25), in: Circle())
            Image(systemName: "doc.richtext.fill")
                .font(.title2).foregroundStyle(.red)
                .frame(width: 42, height: 48)
                .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 6) {
                Text(document.displayTitle).font(.headline).foregroundStyle(SignTheme.navy)
                HStack {
                    ForEach(document.signers) { signer in SignerStatusView(signer: signer) }
                }
                .font(.caption)
            }
            Spacer()
            Text(document.isComplete ? "Completed" : document.needsSignature ? "Your signature" : "Awaiting")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10).padding(.vertical, 6)
                .foregroundStyle(document.isComplete ? .green : SignTheme.navy)
                .background((document.isComplete ? Color.green : SignTheme.gold).opacity(0.11), in: Capsule())
            Button("View", action: open).buttonStyle(.borderless)
            if document.needsSignature && !document.isComplete {
                Button("Review and sign", action: sign)
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
            }
        }
        .padding(.vertical, 13)
    }
}

struct SignerStatusView: View {
    let signer: Signer
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: signer.signedAt == nil ? "circle" : "checkmark.circle.fill")
            Text(signer.signerName)
        }
        .foregroundStyle(signer.signedAt == nil ? Color.secondary : Color.green)
    }
}

struct OfficerAccessView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var role = "secretary"
    @State private var privateLink = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Officer access")
                    .font(.system(size: 40, weight: .semibold, design: .serif))
                    .foregroundStyle(SignTheme.navy)
                Text("Create one private invitation for each officer. They choose their own password.")
                    .foregroundStyle(.secondary)
                HStack(spacing: 16) {
                    OfficerCard(
                        name: model.officers.first { $0.role == "secretary" }?.name ?? "William McDuffie",
                        office: "Secretary",
                        active: model.officers.contains { $0.role == "secretary" }
                    )
                    OfficerCard(
                        name: model.officers.first { $0.role == "assistant_secretary" }?.name ?? "Adrian Reese",
                        office: "Assistant Secretary",
                        active: model.officers.contains { $0.role == "assistant_secretary" }
                    )
                }
                Form {
                    Picker("Office", selection: $role) {
                        Text("Secretary").tag("secretary")
                        Text("Assistant Secretary").tag("assistant_secretary")
                    }
                    TextField("Full name", text: $name)
                    TextField("Email address", text: $email)
                    TextField("Mobile phone", text: $phone)
                    Button("Create private invitation") {
                        Task {
                            if let invite = await model.invite(name: name, email: email, phone: phone, role: role) {
                                privateLink = invite.inviteUrl
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                    if !privateLink.isEmpty {
                        TextField("Private link", text: $privateLink)
                        Button("Copy private link") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(privateLink, forType: .string)
                        }
                    }
                }
                .formStyle(.grouped)
                .frame(maxWidth: 660)
            }
            .padding(38)
        }
        .background(SignTheme.ivory.opacity(0.45))
    }
}

struct OfficerCard: View {
    let name: String
    let office: String
    let active: Bool
    var body: some View {
        HStack {
            Image(systemName: "person.crop.circle.fill").font(.largeTitle).foregroundStyle(SignTheme.gold)
            VStack(alignment: .leading) {
                Text(name).font(.headline)
                Text("\(office) · \(active ? "Active" : "Invitation needed")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Circle().fill(active ? .green : .gray.opacity(0.4)).frame(width: 9)
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.4)) }
    }
}

struct SignatureProfileView: View {
    @EnvironmentObject var model: AppModel
    @State private var showEditor = false
    @State private var image: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Signature profile")
                .font(.system(size: 40, weight: .semibold, design: .serif))
                .foregroundStyle(SignTheme.navy)
            Text("This saved signature is applied only after you review a document and confirm consent.")
                .foregroundStyle(.secondary)
            Group {
                if let image { Image(nsImage: image).resizable().scaledToFit().padding(24) }
                else { ContentUnavailableView("No signature saved", systemImage: "signature") }
            }
            .frame(maxWidth: 680, minHeight: 210)
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator.opacity(0.5)) }
            Button(model.user?.hasSignature == true ? "Change signature" : "Create signature") {
                showEditor = true
            }
            .buttonStyle(.borderedProminent).tint(SignTheme.navy)
            Spacer()
        }
        .padding(38)
        .background(SignTheme.ivory.opacity(0.45))
        .task { image = try? await model.signatureImage() }
        .sheet(isPresented: $showEditor, onDismiss: {
            Task { image = try? await model.signatureImage() }
        }) { SignatureSetupView(required: false) }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Form {
            Section("Shared signing service") {
                TextField("Service address", text: $model.serverAddress)
                Text("Use an HTTPS address for officer access. The Mac app and web users must use the same service.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Test and refresh") { Task { await model.refresh() } }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Service Settings")
    }
}

struct SignatureApprovalView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let document: LodgeDocument
    @State private var consent = false
    @State private var signatureImage: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("ELECTRONIC SIGNATURE")
                .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text("Sign \(document.displayTitle)")
                .font(.system(size: 30, weight: .semibold, design: .serif))
                .foregroundStyle(SignTheme.navy)
            Text("Review the PDF before applying your saved signature. The action is added to the document audit history.")
                .foregroundStyle(.secondary)
            Group {
                if let signatureImage {
                    Image(nsImage: signatureImage).resizable().scaledToFit().padding(18)
                } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, minHeight: 170)
            .background(.white, in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(.gray.opacity(0.4)) }
            Toggle(
                "I agree that this electronic signature represents my signature on this document.",
                isOn: $consent
            )
            HStack {
                Button("View PDF") { Task { await model.open(document: document) } }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Apply saved signature") {
                    Task { if await model.sign(document: document) { dismiss() } }
                }
                .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                .disabled(!consent || signatureImage == nil || model.isBusy)
            }
        }
        .padding(30)
        .frame(width: 760)
        .task { signatureImage = try? await model.signatureImage() }
    }
}

struct SignatureSetupView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let required: Bool
    @State private var mode = 0
    @State private var name = ""
    @State private var selectedStyle = 0
    @State private var paths: [[CGPoint]] = []
    @State private var currentPath: [CGPoint] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            Text("SIGNATURE PROFILE")
                .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text(required ? "Create your signature to continue" : "Change your saved signature")
                .font(.system(size: 30, weight: .semibold, design: .serif))
                .foregroundStyle(SignTheme.navy)
            Text(required
                 ? "Draw your signature or type your name and choose one of five professional styles."
                 : "The new signature will be used on documents you approve after it is saved.")
                .foregroundStyle(.secondary)
            Picker("Signature method", selection: $mode) {
                Text("Draw it").tag(0)
                Text("Type my name").tag(1)
            }
            .pickerStyle(.segmented)
            if mode == 0 {
                DrawingPad(paths: $paths, currentPath: $currentPath)
                    .frame(height: 200)
                    .background(.white, in: RoundedRectangle(cornerRadius: 9))
                    .overlay { RoundedRectangle(cornerRadius: 9).stroke(.gray.opacity(0.5)) }
                Button("Clear drawing") { paths = []; currentPath = [] }
            } else {
                TextField("Name as it should appear", text: $name)
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(0..<5, id: \.self) { style in
                            Button {
                                selectedStyle = style
                            } label: {
                                Image(nsImage: renderTypedSignature(name: name.isEmpty ? "Your Name" : name, style: style))
                                    .resizable().scaledToFit().padding(7)
                                    .frame(height: 92)
                                    .background(.white, in: RoundedRectangle(cornerRadius: 8))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 8)
                                            .stroke(selectedStyle == style ? SignTheme.gold : .gray.opacity(0.3), lineWidth: selectedStyle == style ? 2 : 1)
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(height: 285)
            }
            HStack {
                if !required { Button("Cancel") { dismiss() } }
                Spacer()
                Button("Save my signature") { save() }
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                    .disabled(model.isBusy || (mode == 0 ? paths.isEmpty : name.trimmingCharacters(in: .whitespaces).isEmpty))
            }
        }
        .padding(30)
        .frame(width: 780)
        .onAppear { if name.isEmpty { name = model.user?.name ?? "" } }
    }

    private func save() {
        let dataURL: String?
        let type: String
        let style: String
        if mode == 0 {
            dataURL = renderDrawnSignature(paths: paths, size: NSSize(width: 760, height: 200))
            type = "drawn"
            style = "drawn"
        } else {
            dataURL = signatureDataURL(image: renderTypedSignature(name: name, style: selectedStyle))
            type = "typed"
            style = "professional-\(selectedStyle + 1)"
        }
        guard let dataURL else { return }
        Task { if await model.saveSignature(dataURL: dataURL, type: type, style: style) { dismiss() } }
    }
}

struct DrawingPad: View {
    @Binding var paths: [[CGPoint]]
    @Binding var currentPath: [CGPoint]
    var body: some View {
        Canvas { context, _ in
            for points in paths + (currentPath.isEmpty ? [] : [currentPath]) {
                guard let first = points.first else { continue }
                var path = Path()
                path.move(to: first)
                points.dropFirst().forEach { path.addLine(to: $0) }
                context.stroke(path, with: .color(SignTheme.navy), lineWidth: 2.5)
            }
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { currentPath.append($0.location) }
                .onEnded { _ in
                    if !currentPath.isEmpty { paths.append(currentPath) }
                    currentPath = []
                }
        )
    }
}

func renderDrawnSignature(paths: [[CGPoint]], size: NSSize) -> String? {
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()
    NSColor(calibratedRed: 0.03, green: 0.11, blue: 0.19, alpha: 1).setStroke()
    for points in paths {
        guard let first = points.first else { continue }
        let line = NSBezierPath()
        line.lineWidth = 2.5
        line.lineCapStyle = .round
        line.move(to: NSPoint(x: first.x, y: size.height - first.y))
        for point in points.dropFirst() {
            line.line(to: NSPoint(x: point.x, y: size.height - point.y))
        }
        line.stroke()
    }
    image.unlockFocus()
    return signatureDataURL(image: image)
}

func renderTypedSignature(name: String, style: Int) -> NSImage {
    let size = NSSize(width: 620, height: 145)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()
    let fontNames = ["SnellRoundhand", "AppleChancery", "SavoyeLetPlain", "Baskerville-Italic", "BradleyHandITCTT-Bold"]
    let fontSizes: [CGFloat] = [62, 53, 58, 51, 55]
    let font = NSFont(name: fontNames[style], size: fontSizes[style])
        ?? NSFont.systemFont(ofSize: fontSizes[style], weight: .regular)
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(calibratedRed: 0.03, green: 0.11, blue: 0.19, alpha: 1),
        .paragraphStyle: paragraph,
    ]
    NSString(string: name).draw(in: NSRect(x: 25, y: 37, width: 570, height: 82), withAttributes: attributes)
    let flourish = NSBezierPath()
    flourish.lineWidth = style == 2 ? 2 : 1.4
    flourish.lineCapStyle = .round
    flourish.move(to: NSPoint(x: 105 + CGFloat(style * 8), y: 32))
    flourish.curve(
        to: NSPoint(x: 535 - CGFloat(style * 5), y: 34),
        controlPoint1: NSPoint(x: 260, y: 18 + CGFloat(style * 3)),
        controlPoint2: NSPoint(x: 430, y: 48 - CGFloat(style * 2))
    )
    NSColor(calibratedRed: 0.03, green: 0.11, blue: 0.19, alpha: 1).setStroke()
    flourish.stroke()
    image.unlockFocus()
    return image
}

func signatureDataURL(image: NSImage) -> String? {
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64,\(png.base64EncodedString())"
}
