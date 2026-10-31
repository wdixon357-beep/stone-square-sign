// Offscreen synthetic native fixtures only. Does not launch or inspect the installed app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root=path.resolve(new URL('..',import.meta.url).pathname);
if(process.platform!=='darwin'){console.log('Native offscreen rendering requires macOS.');process.exit(0);}
const source=fs.readFileSync(path.join(root,'macos/Sources/StoneSquareSign/AssistantSignatureAuthorization.swift'),'utf8');
const access=fs.readFileSync(path.join(root,'macos/Sources/StoneSquareSign/AssistantAccess.swift'),'utf8');
const shared=fs.readFileSync(path.join(root,'macos/Sources/StoneSquareSign/Views.swift'),'utf8');
const theme=shared.slice(shared.indexOf('enum SignTheme'),shared.indexOf('private enum GrandViewPortal'));
const header=shared.slice(shared.indexOf('struct NativeWorkspaceHeader'),shared.indexOf('struct AdaptiveWorkspaceSplit'));
const models=fs.readFileSync(path.join(root,'macos/Sources/StoneSquareSign/Models.swift'),'utf8');
const date=models.slice(models.indexOf('enum LodgeDateTime'),models.indexOf('struct User:'));
const stream='BT /F1 18 Tf 48 730 Td (SYNTHETIC REVIEW DOCUMENT) Tj 0 -32 Td /F1 12 Tf (No live record or signature is used in this fixture.) Tj 0 -32 Td (Document version 4. Reviewed with Muse.) Tj ET\n';
let text='%PDF-1.4\n';const offsets=[];
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
const start=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
const pdf=Buffer.from(text);
const pending={id:'SYNTHETIC-SIGNATURE',actionId:'minutes.attest',recordId:'SYNTHETIC-MINUTES',title:'October meeting minutes (synthetic)',kind:'minutes',status:'pending',createdAt:'2026-10-31T20:00:00Z',expiresAt:'2099-11-01T00:00:00Z',artifactSHA256:crypto.createHash('sha256').update(pdf).digest('hex'),fingerprint:'SYNTHETIC-EXACT-REVIEW-4',statement:'I have reviewed these meeting minutes and authorize the system to apply my saved Worshipful Master signature to this exact version.',effects:['Applies your saved Worshipful Master signature.','Files the signed minutes and makes them available to authorized officers.','Notifies the preparing officer. Distribution to the Craft remains separate.'],signingRole:'Worshipful Master',ready:true,reason:null,authorizationUrl:'https://example.invalid/?signatureRequest=SYNTHETIC',receipt:null};
const completed={...pending,status:'completed',ready:false,receipt:{authorizedBy:{userId:987654,name:'Synthetic Owner'},requestedBy:{assistantId:'SYNTHETIC-MUSE',name:'Muse'},appliedBy:'system',recordId:pending.recordId,actionId:pending.actionId,completedAt:'2026-10-31T20:05:00Z',notificationState:'queued',notificationWarnings:[],automaticRetryAllowed:false}};
const uncertain={...pending,status:'uncertain',ready:false,reason:'The signature outcome needs verification. Do not create or submit a duplicate request.'};
const raw=x=>`#"${JSON.stringify(x)}"#`;
const out=path.join(root,'output/signature-authorization-build/native-render');fs.mkdirSync(out,{recursive:true,mode:0o700});fs.chmodSync(out,0o700);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'signature-native-render-'));
try{
 const bundle=path.join(scratch,'SignatureRender.app'),contents=path.join(bundle,'Contents'),bin=path.join(contents,'MacOS');fs.mkdirSync(bin,{recursive:true});
 fs.writeFileSync(path.join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.stonesquare.synthetic.signature.${Date.now()}</string><key>CFBundleExecutable</key><string>SignatureRender</string><key>LSUIElement</key><true/></dict></plist>`);
 const swift=path.join(scratch,'render.swift'),binary=path.join(bin,'SignatureRender');
 fs.writeFileSync(swift,`${access}\n${source}\n${theme}\n${header}\n${date}
struct CorrespondenceRecord:Decodable {}
struct User { let id:Int; let role:String }
@MainActor final class AppModel:ObservableObject {
 var user:User?=User(id:987654,role:"owner")
 let assistantAccountContext="OFFSCREEN-SYNTHETIC-SIGNATURE"
 var current=Data(${raw(pending)}.utf8)
 func request<T:Decodable>(_ path:String,method:String="GET",body:Data?=nil)async throws->T{
  precondition(method=="GET", "A render fixture cannot submit any mutation")
  let object=try JSONSerialization.jsonObject(with:current)
  let bytes:Data
  if path=="/api/assistant/signature-requests"{bytes=try JSONSerialization.data(withJSONObject:["requests":[object]])}
  else if path.hasPrefix("/api/assistant/signature-requests/"){bytes=try JSONSerialization.data(withJSONObject:["request":object])}
  else { precondition(path=="/api/assistant/workspace");bytes=Data(${raw({assistant:null,capabilities:[],requests:[],attestations:[],activity:[]})}.utf8) }
  return try JSONDecoder().decode(T.self,from:bytes)
 }
 func signatureAuthorizationPreview(requestID:String)async throws->Data{
  precondition(requestID=="SYNTHETIC-SIGNATURE");return Data(base64Encoded:"${pdf.toString('base64')}")!
 }
}
@main struct RenderSignature {
 @MainActor static func main()async throws{
  NSApplication.shared.setActivationPolicy(.prohibited)
  let model=AppModel(), workspace=AssistantSignatureWorkspace()
  await workspace.load(model);await workspace.inspect(workspace.requests[0],model:model)
  precondition(workspace.previewVerified)
  let frozen=PDFDocument(data:workspace.preview!)!
  precondition(frozen.page(at:0)?.string?.contains("SYNTHETIC REVIEW DOCUMENT")==true)
  let pageImage=frozen.page(at:0)!.thumbnail(of:NSSize(width:612,height:792),for:.mediaBox)
  let pageBitmap=NSBitmapImageRep(data:pageImage.tiffRepresentation!)!
  try pageBitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:${JSON.stringify(out)}).appendingPathComponent("frozen-artifact-page.png"))
  func scroll(_ view:NSView)->NSScrollView?{
   if let value=view as? NSScrollView{return value};for child in view.subviews{if let value=scroll(child){return value}};return nil
  }
  func preparePDF(_ view:NSView){
   if let pdf=view as? PDFView{
    precondition(pdf.document?.pageCount==1 && pdf.document?.page(at:0)?.string?.contains("SYNTHETIC REVIEW DOCUMENT")==true,"The actual PDFKit view must contain the exact synthetic artifact")
    pdf.layoutDocumentView();pdf.scaleFactor=pdf.scaleFactorForSizeToFit;pdf.needsDisplay=true;pdf.displayIfNeeded();pdf.documentView?.displayIfNeeded()
   }
   for child in view.subviews{preparePDF(child)}
  }
  func capture<V:View>(_ root:V,name:String,width:CGFloat,height:CGFloat,fraction:CGFloat=0)async throws{
   let hosting=NSHostingView(rootView:root.environmentObject(model).environment(\\.colorScheme,.light).frame(width:width,height:height).background(Color.white))
   hosting.sizingOptions=[];hosting.appearance=NSAppearance(named:.aqua)
   let window=NSWindow(contentRect:NSRect(x:0,y:0,width:width,height:height),styleMask:[.titled,.resizable],backing:.buffered,defer:false)
   window.appearance=NSAppearance(named:.aqua);window.isReleasedWhenClosed=false;window.contentView=hosting
   window.setContentSize(NSSize(width:width,height:height));hosting.frame=NSRect(x:0,y:0,width:width,height:height)
   hosting.layoutSubtreeIfNeeded();try await Task.sleep(for:.milliseconds(200));hosting.layoutSubtreeIfNeeded()
   preparePDF(hosting);try await Task.sleep(for:.milliseconds(150));hosting.displayIfNeeded()
   if fraction>0,let target=scroll(hosting),let doc=target.documentView{
    target.contentView.scroll(to:NSPoint(x:0,y:max(0,doc.bounds.height-target.contentView.bounds.height)*fraction));target.reflectScrolledClipView(target.contentView)
    hosting.layoutSubtreeIfNeeded();try await Task.sleep(for:.milliseconds(80))
   }
   guard let bitmap=hosting.bitmapImageRepForCachingDisplay(in:hosting.bounds)else{preconditionFailure("Missing bitmap")}
   hosting.cacheDisplay(in:hosting.bounds,to:bitmap)
   guard let png=bitmap.representation(using:.png,properties:[:])else{preconditionFailure("Missing PNG")}
   try png.write(to:URL(fileURLWithPath:${JSON.stringify(out)}).appendingPathComponent(name+".png"))
   window.contentView=nil;window.close()
  }
  try await capture(AssistantSignatureConfirmation(workspace:workspace),name:"pending-normal",width:640,height:820)
  try await capture(AssistantSignatureConfirmation(workspace:workspace),name:"pending-wide",width:1000,height:900)
  try await capture(AssistantSignatureConfirmation(workspace:workspace),name:"pending-bottom",width:640,height:820,fraction:1)
  model.current=Data(${raw(completed)}.utf8);await workspace.load(model);await workspace.inspect(workspace.requests[0],model:model)
  try await capture(AssistantSignatureConfirmation(workspace:workspace),name:"completed-receipt",width:720,height:820)
  model.current=Data(${raw(uncertain)}.utf8);await workspace.load(model);await workspace.inspect(workspace.requests[0],model:model)
  try await capture(AssistantSignatureConfirmation(workspace:workspace),name:"uncertain-blocked",width:640,height:760)
  let access=AssistantWorkspace();await access.load(model)
  model.current=Data(${raw(pending)}.utf8)
  try await capture(MyAttestationsView(workspace:access,openReview:{_ in}),name:"owner-queue",width:760,height:880)
  print("PASS: six offscreen synthetic signature confirmation, PDF, receipt, uncertain and queue fixtures; no network, visible window, installed app, preference or Keychain access")
 }
}
`);
 const compile=spawnSync('swiftc',['-parse-as-library',swift,'-o',binary],{encoding:'utf8'});assert.equal(compile.status,0,`${compile.stdout}\n${compile.stderr}`);
 const render=spawnSync(binary,[],{encoding:'utf8'});assert.equal(render.status,0,`${render.stdout}\n${render.stderr}`);console.log(render.stdout.trim());
 const images=fs.readdirSync(out).filter(n=>n.endsWith('.png'));for(const name of images)fs.chmodSync(path.join(out,name),0o600);
 fs.writeFileSync(path.join(out,'native-render-receipt.json'),JSON.stringify({at:new Date().toISOString(),sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),images,offscreenSyntheticOnly:true,network:false,visibleWindow:false,installedApp:false,preferences:false,keychain:false,pdfKitViewExactPageAndTextAsserted:true,pdfKitOffscreenCacheLimitation:'PDFKit document content is asserted in the actual NSView; offscreen bitmap cache contains a blank PDF region. Separate direct PDFPage raster is retained for artifact inspection. Installed PDF view rendering remains unverified.'},null,2),{mode:0o600});
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
