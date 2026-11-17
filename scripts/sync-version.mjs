import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'manifest.json');

const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const manifestText = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);

const upstreamVersion = String(pkg.version ?? '').trim();
if (!upstreamVersion) {
  throw new Error('package.json version is required');
}

const fork = process.env.BBI_FORK_REPOSITORY;
if (fork && !/^[\w-]+\/[\w.-]+$/.test(fork)) {
  throw new Error('BBI_FORK_REPOSITORY must be owner/repo');
}
const build = process.env.BBI_FORK_BUILD ?? '1';
if (!/^[1-9][0-9]*$/.test(build)) throw new Error('BBI_FORK_BUILD must be a positive integer');
const version = fork ? upstreamVersion + '-retention.' + build : upstreamVersion;
if (fork) manifest.homePage = 'https://github.com/' + fork;

const expectedJs = `dist/index.js?ver=${encodeURIComponent(version)}`;
manifest.version = version;
manifest.js = expectedJs;

const nextManifestText = `${JSON.stringify(manifest, null, 2)}\n`;
if (nextManifestText !== manifestText) {
  await writeFile(manifestPath, nextManifestText, 'utf8');
  console.log(`Synced manifest.json to version ${version}`);
} else {
  console.log(`manifest.json already synced to version ${version}`);
}
