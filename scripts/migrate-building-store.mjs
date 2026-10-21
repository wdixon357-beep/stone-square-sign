import { stageBuildingSource, verifyBuildingStage, stageBuildingTarget, verifyBuildingTarget,
  activateBuildingTarget } from '../building-store-migration.js';

const [command, ...args] = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const required = name => { const value = option(name); if (!value || value.startsWith('--')) throw new Error(`Missing ${name}.`); return value; };
const summary = result => result.manifest ? {
  snapshotId: result.manifest.snapshotId, manifestSha256: result.manifestSha256,
  keyCount: result.manifest.keyCount, recordCount: result.manifest.recordCount,
} : result;
let connected = false;
try {
  let result;
  if (command === 'stage') result = await stageBuildingSource(required('--source'), required('--out'));
  else if (command === 'verify') result = await verifyBuildingStage(required('--dir'));
  else if (['stage-target', 'verify-target', 'activate-target'].includes(command)) {
    if (!args.includes('--confirm-target')) throw new Error('Target writes require --confirm-target after source review.');
    const sourceStage = command === 'stage-target' ? await verifyBuildingStage(required('--dir')) : null;
    const snapshotId = command === 'stage-target' ? null : required('--snapshot');
    const expectedManifest = command === 'activate-target' ? required('--manifest-sha256') : null;
    // Never load a repository .env implicitly. The operator supplies the existing
    // database configuration to this process after checking the target identity.
    if (!process.env.DATABASE_URL && !process.env.PGLITE_DIR) throw new Error('An explicit DATABASE_URL or PGLITE_DIR target is required.');
    const { connect } = await import('../db.js');
    const { initBuildingStoreSchema } = await import('../building-store.js');
    await connect(); connected = true; await initBuildingStoreSchema();
    if (command === 'stage-target') result = await stageBuildingTarget(sourceStage);
    if (command === 'verify-target') result = await verifyBuildingTarget(snapshotId);
    if (command === 'activate-target') result = await activateBuildingTarget(snapshotId, expectedManifest);
  } else throw new Error('Use stage, verify, stage-target, verify-target, or activate-target.');
  console.log(JSON.stringify(summary(result), null, 2));
} catch (error) {
  // Errors describe verification states, never source values or credentials.
  console.error(error.message); process.exitCode = 1;
} finally {
  if (connected) { const { close } = await import('../db.js'); await close(); }
}
