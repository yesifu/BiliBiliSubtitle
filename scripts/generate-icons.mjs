import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output=path.resolve(import.meta.dirname,'../icons');
await mkdir(output,{recursive:true});
function crc32(bytes) {
  let c=0xffffffff;
  for(const b of bytes) {c^=b;for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0);}
  return (c^0xffffffff)>>>0;
}
function chunk(type,data) {
  const body=Buffer.concat([Buffer.from(type),data]);
  const result=Buffer.alloc(data.length+12);
  result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE(crc32(body),result.length-4);
  return result;
}
for(const size of [16,32,48,128]) {
  const pixels=Buffer.alloc((size*4+1)*size);
  const rect=(x,y,l,t,r,b)=>x>=l&&x<=r&&y>=t&&y<=b;
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=(x+0.5)/size,v=(y+0.5)/size;
    const cx=Math.max(0.19,Math.min(0.81,u)),cy=Math.max(0.19,Math.min(0.81,v));
    const alpha=Math.hypot(u-cx,v-cy)<=0.17?255:0;
    const white=(rect(u,v,0.20,0.24,0.80,0.72)&&!rect(u,v,0.26,0.30,0.74,0.66)) || rect(u,v,0.31,0.49,0.47,0.54) || rect(u,v,0.52,0.49,0.68,0.54) || rect(u,v,0.31,0.58,0.61,0.62) || rect(u,v,0.39,0.78,0.61,0.82);
    const at=y*(size*4+1)+1+x*4;
    pixels.set(white?[255,252,245,alpha]:[237,77,77,alpha],at);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  await writeFile(path.join(output,`icon${size}.png`),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
