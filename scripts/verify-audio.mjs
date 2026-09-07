// Validates actual encoded samples without submitting audio to a paid provider.
// Usage: node scripts/verify-audio.mjs path/to/audio.m4a
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inspectAudio, splitCompressedAudio } from '../src/shared/compressed-audio.js';

if(!process.argv[2]) throw new Error('Pass a local M4A file to validate.');
const bytes=await readFile(process.argv[2]);
const metadata=inspectAudio(bytes);
const start=performance.now();
const parts=await splitCompressedAudio(bytes,{seconds:120,maxBytes:45_000_000});
const preparationMs=performance.now()-start;
const playwright=process.env.BILI_PLAYWRIGHT_PATH?await import(pathToFileURL(process.env.BILI_PLAYWRIGHT_PATH).href):await import('playwright');
const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.BILI_BROWSER_PATH || undefined});
try {
  const page=await browser.newPage();
  const decoded=[];
  for(const [index,part] of parts.entries()) {
    const buffer=Buffer.from(await part.blob.arrayBuffer());
    const audio=await page.evaluate(async base64=>{
      const context=new AudioContext({sampleRate:16000});
      try {
        const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
        const pcm=await context.decodeAudioData(bytes.buffer);
        let power=0;for(const sample of pcm.getChannelData(0)) power+=sample*sample;
        return {duration:pcm.duration,channels:pcm.numberOfChannels,rms:Math.sqrt(power/pcm.length)};
      } finally {await context.close();}
    },buffer.toString('base64'));
    assert.ok(Math.abs(audio.duration-part.duration)<0.10,`Part ${index} duration mismatch`);
    assert.ok(audio.rms>0.00001,`Part ${index} unexpectedly silent`);
    decoded.push({offset:part.offset,duration:part.duration,decodedSeconds:audio.duration,bytes:part.blob.size});
  }
  assert.ok(Math.abs(parts.at(-1).offset+parts.at(-1).duration-metadata.duration)<0.01);
  console.log(JSON.stringify({metadata,preparationMs,totalBytes:bytes.byteLength,partCount:parts.length,decoded},null,2));
} finally {await browser.close();}
