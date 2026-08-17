import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const watchTargets = [
  path.join(root, 'server.js'),
  path.join(root, 'db.js'),
  path.join(root, 'package.json'),
  path.join(root, 'public'),
  path.join(root, 'assets'),
];

let child;
let restartTimer;
let shuttingDown = false;

const startServer = () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('exit', () => {
    if (!shuttingDown && !restartTimer) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startServer();
      }, 800);
    }
  });
};

const restartServer = () => {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!child || child.killed) return startServer();
    child.once('exit', startServer);
    child.kill('SIGTERM');
  }, 350);
};

for (const target of watchTargets) {
  fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, restartServer);
}

const stop = () => {
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (child && !child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500).unref();
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
startServer();
