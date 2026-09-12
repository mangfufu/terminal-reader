// Run after collecting signed Windows and Linux assets into one release directory.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'artifacts/release');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const platforms = {};
const sums = [];
for (const [platform, name] of [
  ['windows-x86_64', `TerminalReader-${version}-win-x64-setup.exe`],
  ['linux-x86_64', `TerminalReader-${version}-linux-x64.AppImage`],
]) {
  const signature = (await readFile(path.join(directory, `${name}.sig`), 'utf8')).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error(`Invalid signature encoding for ${name}`);
  await readFile(path.join(directory, name));
  platforms[platform] = { signature, url: `https://github.com/mangfufu/terminal-reader/releases/download/v${version}/${name}` };
}
await writeFile(path.join(directory, 'latest.json'), JSON.stringify({ version, notes: `Terminal Reader ${version}`, platforms }, null, 2) + '\n');
for (const name of [
  `TerminalReader-${version}-win-x64.exe`, `TerminalReader-${version}-win-x64-setup.exe`,
  `TerminalReader-${version}-win-x64-setup.exe.sig`, `TerminalReader-${version}-linux-x64.deb`,
  `TerminalReader-${version}-linux-x64.AppImage`, `TerminalReader-${version}-linux-x64.AppImage.sig`,
  'terminal-reader-linux-x64', 'latest.json',
]) sums.push(`${createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')}  ${name}`);
await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Created signed-update manifest and checksums for ${version}.`);
