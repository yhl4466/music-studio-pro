/* [share.js] source: Pro.html 2351-2494（分享链接：deflate/LZSS 压缩 + Base64 + URL hash） */
import { serializeProject, applyProjectData } from './project.js';
import { toast } from '../core/util.js';

/* =========================================================================
   6c. 分享链接（压缩 JSON → Base64 → URL hash）
   ========================================================================= */
/* ---------- 分享链接（deflate 压缩 → 链接明显变短） ---------- */
export function bytesToB64(bytes){
  let bin='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk){
    bin+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  }
  return btoa(bin);
}
export function b64ToBytes(b64){
  const bin=atob(b64);
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
}
export async function deflateStr(str){
  const stream=new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf=await new Response(stream).arrayBuffer();
  return bytesToB64(new Uint8Array(buf));
}
export async function inflateB64(b64){
  const stream=new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}
/* ---------- 纯 JS LZSS（无需 CompressionStream，任何浏览器可用且同步解码） ---------- */
export function toUtf8(str){
  if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(str);
  const s=unescape(encodeURIComponent(str));
  const u=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);
  return u;
}
export function fromUtf8(u){
  if(typeof TextDecoder!=='undefined')return new TextDecoder().decode(u);
  let s='';
  for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
  try{return decodeURIComponent(escape(s))}catch(e){return s}
}
export function lzEncode(str){
  const src=toUtf8(str);
  const n=src.length;
  const out=[(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255];
  let acc=0,nbits=0;
  const wb=v=>{acc=(acc<<1)|v;if(++nbits===8){out.push(acc);acc=0;nbits=0;}};
  const wbN=(val,bits)=>{for(let i=bits-1;i>=0;i--)wb((val>>>i)&1);};
  for(let i=0;i<n;){
    let bestLen=0,bestDist=0;
    const start=Math.max(0,i-4096);
    const maxLen=Math.min(n-i,34);
    for(let p=start;p<i;p++){
      let l=0;
      while(l<maxLen&&src[p+l]===src[i+l])l++;
      if(l>=3&&l>bestLen){bestLen=l;bestDist=i-p;}
    }
    if(bestLen>=3&&bestLen<=34&&bestDist<=4095){
      wb(1);wbN(bestDist,12);wbN(bestLen-3,5);
      i+=bestLen;
    }else{
      wb(0);wbN(src[i],8);i++;
    }
  }
  if(nbits>0){out.push((acc<<(8-nbits))&255);}
  return new Uint8Array(out);
}
export function lzDecode(bytes){
  const len=((bytes[0]<<24)|(bytes[1]<<16)|(bytes[2]<<8)|bytes[3])>>>0;
  let pos=4,acc=0,nbits=0;
  const rb=()=>{
    if(nbits===0){acc=bytes[pos++];nbits=8;}
    return (acc>>>(--nbits))&1;
  };
  const rbN=bits=>{let v=0;for(let i=0;i<bits;i++)v=(v<<1)|rb();return v;};
  const out=[];
  while(out.length<len){
    if(rb()===0){out.push(rbN(8));}
    else{
      const dist=rbN(12);
      const l=rbN(5)+3;
      for(let k=0;k<l;k++){
        const idx=out.length-dist;
        if(idx<0||idx>=out.length)throw new Error('lz 数据损坏');
        out.push(out[idx]);
      }
    }
  }
  return fromUtf8(new Uint8Array(out));
}
export async function shareLink(){
  try{
    const j=serializeProject();
    // 两种压缩都算一次，选更短：deflate（现代浏览器，需异步解压） vs 纯 JS LZSS（全兼容、同步解码）
    let best='#s='+btoa(unescape(encodeURIComponent(j))); // 基线：不压缩
    let label='未压缩';
    try{
      if(typeof CompressionStream!=='undefined'){
        const z=await deflateStr(j);
        if(z.length<best.length){best='#z='+z;label='deflate';}
      }
    }catch(e){}
    try{
      const lz=bytesToB64(lzEncode(j));
      if(lz.length<best.length){best='#l='+lz;label='LZSS';}
    }catch(e){}
    const url=location.href.split('#')[0]+best; // best 自带 '#' 前缀（'#s='/'#z='/'#l='），此处不再补 '#'，否则 URL 变成 base+"##l=…" 导致分享链接打不开
    const kb=((best.length-1)/1024).toFixed(1);  // 真实 hash 长度（不含前缀 '#'）；不能用 url.split('#')[1]，多重 '#' 时会取到空串显示 0.0
    const done=()=>toast('分享链接已复制到剪贴板（约 '+kb+' KB）→ 粘贴到浏览器打开即还原工程，或发给别人。','ok','check');
    copyToClip(url,done);
  }catch(e){toast('分享失败：'+e.message,'err')}
}
export function copyToClip(url,done){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(done).catch(()=>{prompt('复制下面的分享链接：',url);done()});
  }else prompt('复制下面的分享链接：',url);
}
export async function loadShareFromHash(){
  try{
    const h=location.hash||'';
    if(h.startsWith('#s=')){ // 旧版/无压缩：纯 Base64
      const j=decodeURIComponent(escape(atob(h.slice(3))));
      const data=JSON.parse(j);
      if(!data.tracks||!data.steps)return false;
      applyProjectData(data);
      return true;
    }
    if(h.startsWith('#z=')){ // deflate 压缩（异步）
      const txt=await inflateB64(h.slice(3));
      const data=JSON.parse(txt);
      if(!data.tracks||!data.steps)throw new Error('bad');
      applyProjectData(data);
      return true;
    }
    if(h.startsWith('#l=')){ // 纯 JS LZSS（同步、全浏览器可用）
      const txt=lzDecode(b64ToBytes(h.slice(3)));
      const data=JSON.parse(txt);
      if(!data.tracks||!data.steps)throw new Error('bad');
      applyProjectData(data);
      return true;
    }
    return false;
  }catch(e){return false}
}
