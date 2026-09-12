import SwiftUI
import AppKit

struct ActivityPerson: Decodable, Identifiable {var id:Int;var name:String;var role:String;var revoked:Bool}
struct OfficerEvent: Decodable, Identifiable {var id:Int;var userId:Int?;var actor:String;var action:String;var label:String;var at:String;var detail:String}
struct OfficerSession: Decodable, Identifiable {var id:Int;var userId:Int;var actor:String;var startedAt:String?;var firstSeenAt:String;var lastSeenAt:String;var endedAt:String?;var endReason:String?;var activeSeconds:Int;var measured:Bool;var client:String;var area:String;var status:String}
struct ActivityPayload: Decodable {var users:[ActivityPerson];var events:[OfficerEvent];var eventNext:Int?;var sessions:[OfficerSession];var sessionNext:Int?;var measuredFrom:String?}
private func activityDate(_ value:String?) -> String {
 guard let value else{return "Not recorded"};let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
 guard let date=parser.date(from:value) else{return value};let formatter=DateFormatter();formatter.timeZone=TimeZone(identifier:"America/New_York");formatter.dateFormat="EEE, MMM d, yyyy h:mm a z";return formatter.string(from:date)
}
private func activeDuration(_ seconds:Int)->String {seconds<60 ? "\(seconds) sec" : "\(seconds/60) min \(seconds%60) sec"}

@MainActor final class ActivityPresence: ObservableObject {
 private weak var model:AppModel?;private var timer:Timer?;private var eventMonitor:Any?;private var lastInteraction=Date();private var busy=false
 var area="home"
 func start(_ model:AppModel){stop();self.model=model;lastInteraction=Date();eventMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.leftMouseDown,.rightMouseDown,.scrollWheel]){[weak self] event in self?.lastInteraction=Date();return event};timer=Timer.scheduledTimer(withTimeInterval:30,repeats:true){[weak self] _ in Task{@MainActor in await self?.pulse()}};Task{await pulse()}}
 func visit(_ section:AppSection?){area=section.map{String(describing:$0)} ?? "home";Task{await pulse()}}
 func pulse() async {guard !busy,let model,model.user != nil else{return};busy=true;defer{busy=false};let active=NSApp?.isActive == true && Date().timeIntervalSince(lastInteraction)<120;let body=try? JSONSerialization.data(withJSONObject:["area":area,"active":active]);let _:EmptyResponse?=try? await model.request("/api/activity/heartbeat",method:"POST",body:body)}
 func stop(){timer?.invalidate();timer=nil;if let eventMonitor {NSEvent.removeMonitor(eventMonitor)};eventMonitor=nil;model=nil}
}

@MainActor final class OfficerActivityWorkspace:ObservableObject {
 @Published var data:ActivityPayload?;@Published var person=0;@Published var days=30;@Published var busy=false;@Published var message=""
 let transport=MinutesWorkspace()
 func configure(_ model:AppModel){transport.configure(model)}
 func load(_ more:String?=nil) async {
  guard !busy else{return};busy=true;defer{busy=false}
  do{var path="/api/admin/activity?days=\(days)&userId=\(person)";if more=="events",let next=data?.eventNext {path+="&eventBefore=\(next)"};if more=="sessions",let next=data?.sessionNext{path+="&sessionBefore=\(next)"};var result=try JSONDecoder().decode(ActivityPayload.self,from:await transport.request(path));if let previous=data {if more=="events"{result.events=previous.events+result.events;result.sessions=previous.sessions;result.sessionNext=previous.sessionNext};if more=="sessions"{result.sessions=previous.sessions+result.sessions;result.events=previous.events;result.eventNext=previous.eventNext}};data=result;message=""}catch{message=error.localizedDescription}
 }
 func changeRole(_ id:Int,_ role:String) async {do{_=try await transport.request("/api/admin/accounts/\(id)/role",method:"PUT",body:JSONSerialization.data(withJSONObject:["role":role]));await load()}catch{message=error.localizedDescription}}
}
struct OfficerActivityView:View {
 @EnvironmentObject var model:AppModel
 @StateObject var workspace=OfficerActivityWorkspace()
 @State private var section = 0
 var body: some View {
  VStack(spacing: 0) {
   NativeWorkspaceHeader(title: "Officer Activity", subtitle: "Sign-ins, actions and estimated active time", symbol: "clock.arrow.circlepath") {
    Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.load() } }
   }
   HStack {
    Picker("Officer", selection: $workspace.person) { Text("All officers").tag(0); ForEach(workspace.data?.users ?? []) { user in Text(user.name + (user.revoked ? " (access revoked)" : "")).tag(user.id) } }
    Picker("Show", selection: $workspace.days) { ForEach([1,7,30,90], id: \.self) { days in Text("Last \(days) day\(days == 1 ? "" : "s")").tag(days) } }
    Spacer()
   }.padding(16)
   Picker("Activity section", selection: $section) { Text("Sign-ins").tag(0); Text("Actions").tag(1); Text("Account roles").tag(2) }.pickerStyle(.segmented).padding(.horizontal, 16).padding(.bottom, 12)
   Divider()
   List {
    if !workspace.message.isEmpty { Text(workspace.message).foregroundStyle(.red) }
    if section == 0 {
     Section("Sign-ins and time") {
      ForEach(workspace.data?.sessions ?? []) { entry in
       VStack(alignment: .leading, spacing: 6) {
        HStack { Text(entry.actor).font(.headline); Spacer(); Text(entry.status).foregroundStyle(.secondary) }
        Text("\(entry.client) · \(entry.area)").font(.callout)
        LabeledContent("Signed in", value: entry.startedAt == nil ? "Existing sign-in; start not recorded" : activityDate(entry.startedAt))
        LabeledContent("Last seen", value: activityDate(entry.lastSeenAt))
        LabeledContent("Estimated active time", value: entry.measured ? activeDuration(entry.activeSeconds) : "Not yet measured")
        if let ended = entry.endedAt { LabeledContent(entry.endReason ?? "Ended", value: activityDate(ended)) }
       }.font(.caption).padding(.vertical, 8)
      }
      if workspace.data?.sessions.isEmpty != false { Text("No session measurements in this period.").foregroundStyle(.secondary) }
      if workspace.data?.sessionNext != nil { Button("More sessions") { Task { await workspace.load("sessions") } } }
     }
    } else if section == 1 {
     Section("Recorded actions") {
      ForEach(workspace.data?.events ?? []) { event in
       VStack(alignment: .leading, spacing: 6) {
        HStack { Text(event.actor).font(.headline); Spacer(); Text(activityDate(event.at)).font(.caption).foregroundStyle(.secondary) }
        Text(event.label)
        if !event.detail.isEmpty { Text(event.detail).font(.caption).textSelection(.enabled) }
       }.padding(.vertical, 8)
      }
      if workspace.data?.events.isEmpty != false { Text("No recorded actions in this period.").foregroundStyle(.secondary) }
      if workspace.data?.eventNext != nil { Button("More actions") { Task { await workspace.load("events") } } }
     }
    } else {
     Section("Manage account roles") {
      Text("Your WM administrator access is permanent. Invitations and revocation remain in Officer Access. Bank record upload permissions are managed in Treasurer Reports.").font(.caption).foregroundStyle(.secondary)
      ForEach((workspace.data?.users ?? []).filter { !$0.revoked }) { user in
       if user.role == "owner" { Text("\(user.name) · WM Administrator · Full access").font(.headline) }
       else { ActivityRoleRow(user: user, workspace: workspace) }
      }
     }
    }
    Section {
     DisclosureGroup("About activity measurements") {
      Text("Times are Eastern. Active time is estimated from interaction within the past two minutes while the app is in the foreground. Idle, background and disconnected intervals do not count. Sessions shown were seen within the selected period; time totals cover each recorded sign-in. Older actions may have no timing information.").font(.caption).foregroundStyle(.secondary)
      if let start = workspace.data?.measuredFrom { Text("Time tracking began \(activityDate(start)).").font(.caption) }
     }
    }
   }.listStyle(.inset)
  }.background(Color(nsColor: .windowBackgroundColor)).disabled(workspace.busy)
   .task { workspace.configure(model); await workspace.load() }
   .onChange(of: workspace.person) { _, _ in Task { await workspace.load() } }
   .onChange(of: workspace.days) { _, _ in Task { await workspace.load() } }
 }
}
struct ActivityRoleRow:View {
 let user:ActivityPerson;@ObservedObject var workspace:OfficerActivityWorkspace
 @State private var role="member";@State private var confirm=false
 var body:some View {HStack{Text(user.name).frame(maxWidth:.infinity,alignment:.leading);Picker("Role",selection:$role){Text("Lodge Member").tag("member");Text("Lodge Viewer").tag("viewer");Text("Secretary").tag("secretary");Text("Assistant Secretary").tag("assistant_secretary");Text("Treasurer").tag("treasurer");Text("Assistant Treasurer").tag("assistant_treasurer");Text("Warden").tag("warden")};Button("Save role"){confirm=true}}.padding(.vertical,8).onAppear{role=user.role}.onChange(of:user.role){_,new in role=new}.alert("Change \(user.name)’s role?",isPresented:$confirm){Button("Save role"){Task{await workspace.changeRole(user.id,role)}};Button("Cancel",role:.cancel){}}message:{Text("Their current sign-ins will end. Their records and history will remain.")}}
}
