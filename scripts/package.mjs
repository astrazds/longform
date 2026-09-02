import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
const packageFiles = [
  'background.js',
  'content.js',
  'manifest.json',
  'popup.css',
  'popup.html',
  'popup.js',
];
const iconFiles = [
  'icon16.png',
  'icon32.png',
  'icon48.png',
  'icon128.png',
];

async function copyReleaseFiles(releaseDir) {
  for (const file of packageFiles) {
    await cp(path.join(repoRoot, file), path.join(releaseDir, file));
  }

  await mkdir(path.join(releaseDir, 'icons'), { recursive: true });
  for (const icon of iconFiles) {
    await cp(path.join(repoRoot, 'icons', icon), path.join(releaseDir, 'icons', icon));
  }
}

async function zipRelease(releaseDir, zipPath) {
  await rm(zipPath, { force: true });
  await execFileAsync('zip', ['-rq', zipPath, '.'], { cwd: releaseDir });
}

const manifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
const releaseName = `longform-${manifest.version}`;
const releaseDir = path.join(distRoot, 'chrome-web-store', releaseName);
const zipPath = path.join(distRoot, `${releaseName}.zip`);

await rm(releaseDir, { force: true, recursive: true });
await mkdir(releaseDir, { recursive: true });
await copyReleaseFiles(releaseDir);
await zipRelease(releaseDir, zipPath);

console.log(JSON.stringify({
  ok: true,
  version: manifest.version,
  releaseDir,
  zipPath,
  included: [
    ...packageFiles,
    ...iconFiles.map((icon) => `icons/${icon}`),
  ],
}, null, 2));
