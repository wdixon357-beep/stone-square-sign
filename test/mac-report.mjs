import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin'){console.log('Native report tests require macOS.');process.exit(0)}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=mkdtempSync(path.join(tmpdir(),'sign-report-test-'));
try{
 const source=path.join(root,'macos/Sources/StoneSquareSign');
 const files=readdirSync(source).filter(f=>f.endsWith('.swift')&&f!=='StoneSquareSignApp.swift').map(f=>path.join(source,f));
 const binary=path.join(scratch,'report-test');
 const frameworks=path.join(root,'macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64');
 const resolved=spawnSync('swift',['package','--package-path','macos','resolve'],{cwd:root,stdio:'inherit'});
 if(resolved.status!==0) throw new Error('Could not resolve native dependencies');
 const build=spawnSync('swiftc',['-DDEBUG','-F',frameworks,'-framework','Sparkle','-Xlinker','-rpath','-Xlinker',frameworks,'-parse-as-library',...files,'test/mac-report.swift','-o',binary],{cwd:root,stdio:'inherit'});
 process.exitCode=build.status===0?(spawnSync(binary,[],{cwd:root,stdio:'inherit'}).status??1):1;
}finally{rmSync(scratch,{recursive:true,force:true})}
