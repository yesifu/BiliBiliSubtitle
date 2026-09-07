// RFC 1321 MD5, used exclusively for Bilibili's public WBI request signature.
// This is not used for credential storage or security decisions.
export function md5(value) {
  const data = new TextEncoder().encode(value);
  const bytes = new Uint8Array(Math.ceil((data.length+9)/64)*64);
  bytes.set(data);
  bytes[data.length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length-8,(data.length*8)>>>0,true);
  view.setUint32(bytes.length-4,Math.floor(data.length/0x20000000),true);
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  for(let offset=0;offset<bytes.length;offset+=64) {
    let a=a0,b=b0,c=c0,d=d0;
    for(let i=0;i<64;i++) {
      let f,g;
      if(i<16) {f=(b&c)|(~b&d);g=i;}
      else if(i<32) {f=(d&b)|(~d&c);g=(5*i+1)%16;}
      else if(i<48) {f=b^c^d;g=(3*i+5)%16;}
      else {f=c^(b|~d);g=(7*i)%16;}
      const n=(a+f+Math.floor(Math.abs(Math.sin(i+1))*2**32)+view.getUint32(offset+g*4,true))|0;
      const shift=shifts[Math.floor(i/16)*4+i%4];
      const next=(b+((n<<shift)|(n>>>(32-shift))))|0;
      a=d;d=c;c=b;b=next;
    }
    a0=(a0+a)|0;b0=(b0+b)|0;c0=(c0+c)|0;d0=(d0+d)|0;
  }
  const output=new DataView(new ArrayBuffer(16));
  [a0,b0,c0,d0].forEach((v,i)=>output.setInt32(i*4,v,true));
  return Array.from(new Uint8Array(output.buffer),b=>b.toString(16).padStart(2,'0')).join('');
}
