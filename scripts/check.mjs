import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
const paths=[manifest.background.service_worker,manifest.action.default_popup,manifest.options_page,'offscreen.html',...Object.values(manifest.icons || {}),...manifest.content_scripts.flatMap(c=>[...c.js,...c.css])];
for(const file of paths) await access(path.join(root,file));
async function walk(dir) {
  const entries=await readdir(dir,{withFileTypes:true});
  return (await Promise.all(entries.map(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]))).flat();
}
const files=(await walk(path.join(root,'src'))).filter(f=>/\.m?js$/.test(f));
for(const file of files) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0) throw new Error(result.stderr);
  const source=await readFile(file,'utf8');
  for(const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) await access(path.resolve(path.dirname(file),match[1]));
  if(/\beval\s*\(|new\s+Function\s*\(/.test(source)) throw new Error(`Forbidden dynamic execution in ${file}`);
}
for(const file of ['popup.html','options.html','offscreen.html']) {
  const html=await readFile(path.join(root,file),'utf8');
  if(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html) || /\son\w+\s*=/.test(html)) throw new Error(`Inline script violates MV3 CSP in ${file}`);
  for(const match of html.matchAll(/(?:src|href)="((?:src|styles)\/[^"#]+)"/g)) await access(path.join(root,match[1]));
}
console.log(`Manifest, ${files.length} scripts, imports and CSP checks passed.`);
