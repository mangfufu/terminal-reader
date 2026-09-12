import { mkdir, readFile, copyFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const {version} = JSON.parse(await readFile('package.json','utf8'));
const output = 'artifacts/release/linux';
await mkdir(output,{recursive:true});
const files = [
  [`src-tauri/target/release/bundle/deb/Terminal Reader_${version}_amd64.deb`, `TerminalReader-${version}-linux-x64.deb`],
  [`src-tauri/target/release/bundle/appimage/Terminal Reader_${version}_amd64.AppImage`, `TerminalReader-${version}-linux-x64.AppImage`],
  ['src-tauri/target/release/terminal-reader', 'terminal-reader-linux-x64'],
];
const hashes = [];
for (const [source,name] of files) {
  await copyFile(source,`${output}/${name}`);
  if (name.endsWith('.AppImage') && await access(`${source}.sig`).then(() => true, () => false)) await copyFile(`${source}.sig`, `${output}/${name}.sig`);
  hashes.push(`${createHash('sha256').update(await readFile(source)).digest('hex')}  ${name}`);
}
for (const name of ['KEYBOARD.md','PRIVATE-LIBRARY.md',`RELEASE-${version}.md`]) await copyFile(name,`${output}/${name}`);
await writeFile(`${output}/SHA256SUMS.txt`,hashes.join('\n')+'\n');
console.log(`Collected Linux ${version} release assets.`);
