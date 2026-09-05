import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') { console.log('Mac session tests require macOS.'); process.exit(0); }
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch=mkdtempSync(path.join(tmpdir(),'sign-session-test-'));
try {
 const binary=path.join(scratch,'session-test');
 const build=spawnSync('swiftc',['-parse-as-library','macos/Sources/StoneSquareSign/Models.swift','macos/Sources/StoneSquareSign/APIClient.swift','test/mac-session.swift','-o',binary],{cwd:root,stdio:'inherit'});
 if(build.status!==0) process.exitCode=1;
 else process.exitCode=spawnSync(binary,[],{cwd:root,stdio:'inherit'}).status ?? 1;
} finally {rmSync(scratch,{recursive:true,force:true});}
