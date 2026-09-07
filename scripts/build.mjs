import { cp, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(import.meta.dirname, '..');
export const outputDirectory = path.join(projectRoot, 'dist', 'bili-whole-subtitles');
export const extensionFiles = [
  'manifest.json', 'popup.html', 'options.html', 'offscreen.html',
  'src', 'styles', 'icons', 'README.md', 'PRIVACY.md', 'RESEARCH.md', 'VALIDATION.md',
];

export async function buildExtension() {
  // Keep the loaded directory itself stable so Chrome never needs a new path.
  await mkdir(outputDirectory, { recursive: true });
  if ((await lstat(outputDirectory)).isSymbolicLink()) throw new Error('The build output must be a directory, not a symlink.');
  for (const entry of extensionFiles) {
    const source = path.join(projectRoot, entry);
    await lstat(source);
    const destination = path.join(outputDirectory, entry);
    // Replace generated subtrees so deleted source files cannot survive a rebuild.
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, {
      recursive: true,
      filter: file => !path.basename(file).startsWith('.'),
    });
  }
  console.log(`Built: ${outputDirectory}`);
  return outputDirectory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExtension();
}
