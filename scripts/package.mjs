import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildExtension, extensionFiles, outputDirectory, projectRoot } from './build.mjs';

await buildExtension();
const dist = path.join(projectRoot, 'dist');
const temporary = await mkdtemp(path.join(dist, '.package-'));
const archive = path.join(dist, 'bili-whole-subtitles.zip');
const temporaryArchive = path.join(temporary, 'bili-whole-subtitles.zip');
try {
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const inputs = extensionFiles.map(file => quote(path.join(outputDirectory, file))).join(',');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'\nCompress-Archive -LiteralPath @(${inputs}) -DestinationPath ${quote(temporaryArchive)} -Force`,
    ], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-q', '-r', temporaryArchive, ...extensionFiles], { cwd: outputDirectory, stdio: 'inherit' });
  }
  await rename(temporaryArchive, archive);
  const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha}  bili-whole-subtitles.zip\n`);
  console.log(`Packaged: ${archive}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
