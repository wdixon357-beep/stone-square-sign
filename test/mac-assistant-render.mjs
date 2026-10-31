// Renders only a temporary synthetic NSHostingView. Never launches or inspects the installed app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('..', import.meta.url).pathname);
if (process.platform !== 'darwin') { console.log('Native offscreen rendering requires macOS.'); process.exit(0); }
const source = fs.readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/AssistantAccess.swift'), 'utf8');
const sharedViews = fs.readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/Views.swift'), 'utf8');
const theme = sharedViews.slice(sharedViews.indexOf('enum SignTheme'), sharedViews.indexOf('private enum GrandViewPortal'));
const header = sharedViews.slice(sharedViews.indexOf('struct NativeWorkspaceHeader'), sharedViews.indexOf('struct AdaptiveWorkspaceSplit'));
const models = fs.readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/Models.swift'), 'utf8');
const date = models.slice(models.indexOf('enum LodgeDateTime'), models.indexOf('struct User:'));
const capabilities = [
  { id: 'minutes.view', label: 'Review minutes and meeting records', group: 'Minutes', mode: 'standing', description: 'Read the current record and its retained source under existing privacy rules.', effects: [] },
  { id: 'minutes.prepare', label: 'Prepare minutes corrections', group: 'Minutes', mode: 'approval', description: 'Propose exact corrections while preserving the preparer, source and original signed submission.', effects: ['Records approved changes without signing or attesting.'] },
  { id: 'minutes.attest', label: 'Master review and attestation', group: 'Minutes', mode: 'personal', description: 'Review the complete current document and confirm with your own tap.', effects: ['Applies your saved signature, files the signed minutes and makes them available internally.'] },
  { id: 'building.decide', label: 'Decide a Building Request', group: 'Building', mode: 'personal', description: 'Approval applies your signature and always requires your own decision.', effects: ['May apply your signature and notify the requester.'] },
  { id: 'treasury.view', label: 'Review treasurer reports', group: 'Treasury', mode: 'standing', description: 'Read authorized financial reports and their current review state.', effects: [] },
  { id: 'candidates.view', label: 'Candidate Tracker', group: 'Other offices', mode: 'unavailable', description: 'This external connection is not exposed to Muse credentials.', effects: [] }
];
const request = { id:'SYNTHETIC-REQUEST', actionId:'minutes.prepare', title:'Review proposed minutes correction', method:'PUT', path:'/api/minutes/SYNTHETIC', body:{revision:4,change:'Synthetic review only'}, status:'pending', fingerprint:'SYNTHETIC-FINGERPRINT', createdAt:'2026-10-31T15:00:00Z', expiresAt:'2026-10-31T16:00:00Z', effects:['Records a correction while retaining the submitted snapshot.','Does not sign, attest, distribute or confirm attendance.'], navigation:{section:'minutes',recordId:'SYNTHETIC-MINUTES'}, receipt:null };
const attestation = { id:'SYNTHETIC-ATTESTATION', kind:'minutes', recordId:'SYNTHETIC-MINUTES', title:'October meeting minutes (synthetic)', status:'awaiting_master_attestation', section:'minutes', actionLabel:'Review and attest as Worshipful Master', attestationText:'I reviewed the current meeting minutes and the corrections shown against the preparing officer’s submitted record. I attest to this current record as Worshipful Master.', effects:['Applies your saved Worshipful Master signature.','Files the signed minutes and makes the completed record available to authorized officers.','Distribution to the Craft remains a separate action.'], revision:'SYNTHETIC-REVISION-4', requestId:null, ready:true, reason:'The preparing officer’s original attestation and attendance review remain attached to this record.' };
const payload = {assistant:{id:'SYNTHETIC-MUSE',name:'Muse',enabled:true,expiresAt:'2026-11-07T15:00:00Z',permissions:['minutes.view','minutes.prepare','treasury.view'],createdAt:null,updatedAt:null},capabilities,requests:[request],attestations:[attestation,{...attestation,id:'SYNTHETIC-BUILDING',kind:'building',recordId:'SYNTHETIC-BUILDING',title:'Community room request (synthetic)',section:'building',actionLabel:'Review Building Request',status:'pending',reason:'Approval applies your saved signature. Review the agreement first.'}],activity:[]};
const raw=x=>`#"${JSON.stringify(x)}"#`;
const out=path.join(root,'output/muse-assistant-build/native'); fs.mkdirSync(out,{recursive:true,mode:0o700}); fs.chmodSync(out,0o700);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'muse-native-render-'));
try {
  const bundle=path.join(scratch,'MuseAssistantRender.app'), contents=path.join(bundle,'Contents'), macos=path.join(contents,'MacOS'); fs.mkdirSync(macos,{recursive:true});
  fs.writeFileSync(path.join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.stonesquare.synthetic.muse.${Date.now()}</string><key>CFBundleExecutable</key><string>MuseAssistantRender</string><key>LSUIElement</key><true/></dict></plist>`);
  const swiftFile=path.join(scratch,'render.swift'), binary=path.join(macos,'MuseAssistantRender');
  fs.writeFileSync(swiftFile,`${source}\n${theme}\n${header}\n${date}
struct CorrespondenceRecord: Decodable {}
struct User { let id: Int; let role: String }
@MainActor final class AppModel: ObservableObject {
    let user: User? = User(id: 987654, role: "owner")
    let assistantAccountContext = "OFFSCREEN-SYNTHETIC-ONLY"
    func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        precondition(path == "/api/assistant/workspace" && method == "GET", "Render fixture cannot mutate or contact a service")
        return try JSONDecoder().decode(T.self, from: Data(${raw(payload)}.utf8))
    }
}
@main struct RenderAssistantViews {
    @MainActor static func main() async throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let model=AppModel(), workspace=AssistantWorkspace()
        await workspace.load(model)
        precondition(workspace.loaded)
        func firstScroll(_ view: NSView) -> NSScrollView? {
            if let scroll=view as? NSScrollView { return scroll }
            for child in view.subviews { if let result=firstScroll(child) { return result } }
            return nil
        }
        func capture<V: View>(_ root: V, name: String, width: CGFloat, height: CGFloat, scrollFraction: CGFloat = 0) async throws {
            let hosting=NSHostingView(rootView: root.environmentObject(model).environment(\\.colorScheme,.light).frame(width:width,height:height).background(Color.white))
            hosting.sizingOptions=[]; hosting.appearance=NSAppearance(named:.aqua)
            let window=NSWindow(contentRect:NSRect(x:0,y:0,width:width,height:height),styleMask:[.titled,.resizable],backing:.buffered,defer:false)
            window.appearance=NSAppearance(named:.aqua)
            window.isReleasedWhenClosed=false; window.contentView=hosting
            window.setContentSize(NSSize(width:width,height:height)); hosting.frame=NSRect(x:0,y:0,width:width,height:height)
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for:.milliseconds(180))
            hosting.layoutSubtreeIfNeeded()
            if scrollFraction > 0, let scroll=firstScroll(hosting), let document=scroll.documentView {
                let offset=max(0,document.bounds.height-scroll.contentView.bounds.height)*scrollFraction
                scroll.contentView.scroll(to:NSPoint(x:0,y:offset)); scroll.reflectScrolledClipView(scroll.contentView)
                hosting.layoutSubtreeIfNeeded(); try await Task.sleep(for:.milliseconds(80))
            }
            hosting.frame=NSRect(x:0,y:0,width:width,height:height); hosting.layoutSubtreeIfNeeded()
            precondition(hosting.bounds.width == width && hosting.bounds.height == height)
            guard let bitmap=hosting.bitmapImageRepForCachingDisplay(in:hosting.bounds) else { preconditionFailure("Could not allocate offscreen bitmap") }
            hosting.cacheDisplay(in:hosting.bounds,to:bitmap)
            guard let png=bitmap.representation(using:.png,properties:[:]) else { preconditionFailure("Could not encode offscreen bitmap") }
            try png.write(to:URL(fileURLWithPath:${JSON.stringify(out)}).appendingPathComponent(name+".png"))
            window.contentView=nil; window.close()
        }
        for (label,width,height) in [("normal",CGFloat(720),CGFloat(880)),("wide",CGFloat(1220),CGFloat(900))] {
            try await capture(MuseAssistantView(workspace:workspace,openReview:{_ in}),name:"access-"+label,width:width,height:height)
            try await capture(MuseAssistantView(workspace:workspace,openReview:{_ in}),name:"grants-"+label,width:width,height:height,scrollFraction:0.62)
            try await capture(MyAttestationsView(workspace:workspace,openReview:{_ in}),name:"queue-"+label,width:width,height:height)
        }
        let item=workspace.attestations[0]
        try await capture(AssistantAttestationReview(item:item,close:{},openReview:{_ in}),name:"personal-review",width:660,height:560)
        workspace.selectedRequest=workspace.requests[0]
        try await capture(AssistantRequestSheet(request:workspace.requests[0],workspace:workspace,openReview:{_ in}),name:"change-review",width:690,height:600)
        print("PASS: eight offscreen synthetic native images; no visible window, installed app, app preference, Keychain or network access")
    }
}
`);
  const compile=spawnSync('swiftc',['-parse-as-library',swiftFile,'-o',binary],{encoding:'utf8'});assert.equal(compile.status,0,`${compile.stdout}\n${compile.stderr}`);
  const render=spawnSync(binary,[],{encoding:'utf8'});assert.equal(render.status,0,`${render.stdout}\n${render.stderr}`);console.log(render.stdout.trim());
  for (const name of fs.readdirSync(out).filter(n=>n.endsWith('.png'))) fs.chmodSync(path.join(out,name),0o600);
  fs.writeFileSync(path.join(out,'render-receipt.json'),JSON.stringify({at:new Date().toISOString(),source:'actual AssistantAccess.swift and actual shared native header/theme',model:'In-memory synthetic stub; no URLSession or credential store',images:fs.readdirSync(out).filter(n=>n.endsWith('.png')),visibleWindow:false,installedApp:false,appPreferences:false,network:false},null,2),{mode:0o600});
} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
