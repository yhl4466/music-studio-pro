/* [share.js] source: Pro.html 2351-2494（分享链接：deflate/LZSS 压缩 + Base64 + URL hash） */
import { serializeProject, applyProjectData } from './project.js';
import { proj } from '../core/state.js';
import { toast } from '../core/util.js';
import { resolveSiteBase, buildShareUrl } from './siteUrl.js';
import { hasApi, createShortLink } from './shortlink.js';   // 分享短链后端（server/）：主应用也走它，否则只有长链接
import { fetchShortLink, shortIdFromHash } from './shortlink.js';

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
/* =========================================================================
   解析上限（防载荷 DoS）—— 见下方 lzDecode / inflateB64 的具体说明
   MAX_JSON_BYTES：解压/解码后允许的 JSON 文本上限。
   正常工程远小于它：实测 24 小节 / 5 轨的工程序列化后约 96 KB，
   后端单份上限是 512 KB（见 server/handler.js 的 MAX_BYTES）。
   取 4 MB 是"比任何合法工程都宽松、同时把内存放大限制在可接受范围"的折中。
   ========================================================================= */
export const MAX_JSON_BYTES=4*1024*1024;

export async function inflateB64(b64){
  /* ⚠ 原来的实现是 `await new Response(stream).text()` —— 对解压产物**没有任何上限**。
     而后端的 512 KB 限制只约束**压缩后**的请求体，所以一个 500 KB 的 deflate
     解压炸弹（例如把 5 亿个重复字符压进去）能让页面先分配几百 MB 字符串，
     且发生在任何字段校验之前。现在边读边累计，超限立即 abort。
     abort 会取消流并释放已解压的部分，因此内存不会按最终产物大小增长。 */
  const stream=new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader=stream.getReader();
  const dec=new TextDecoder();
  let total=0, out='';
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.length;
      if(total>MAX_JSON_BYTES){
        try{ await reader.cancel() }catch(e){}
        throw new Error('分享数据解压后超过 '+Math.round(MAX_JSON_BYTES/1048576)+' MB 上限，已停止');
      }
      out+=dec.decode(value,{stream:true});
    }
    out+=dec.decode();
  }finally{
    try{ reader.releaseLock() }catch(e){}
  }
  return out;
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
  /* ⚠ 两处加固，缺一不可（原实现可被单条链接打成假死）：
     ① 长度头与输入长度必须自洽。原来 `len` 完全取自载荷的前 4 字节，
        且数据耗尽后 `rb()` 因 `bytes[pos++]===undefined` 静默返回 0 ——
        于是 `while(out.length<len)` 永不收敛。代理实测：伪造长度头 3,000,000
        → 536ms 返回 300 万个 0 且**不报错**；线性外推 0xFFFFFFFF ≈ 13 分钟
        + 4.29e9 元素数组，必然 OOM。
        压缩数据每个字节最多产出 1 位，所以"1 个输出字节"至少需要 1 个输入位，
        即 len 不可能超过 (输入字节数 * 8)。以此作为硬上限。
     ② 再加一个绝对上限 MAX_JSON_BYTES，防止"输入本身很大"时仍能撑出巨量输出。 */
  const nIn=(bytes&&bytes.length)||0;
  if(nIn<4)throw new Error('lz 数据太短');
  const rawLen=((bytes[0]<<24)|(bytes[1]<<16)|(bytes[2]<<8)|bytes[3])>>>0;
  const cap=Math.min(rawLen, (nIn-4)*8, MAX_JSON_BYTES);
  if(rawLen>cap)throw new Error('lz 数据损坏（长度头与内容不符）');
  const len=rawLen;

  let pos=4,acc=0,nbits=0;
  const rb=()=>{
    if(nbits===0){
      /* 读越界必须报错，不能静默当 0 —— 否则循环条件永远成立（见上方说明） */
      if(pos>=nIn)throw new Error('lz 数据损坏（提前结束）');
      acc=bytes[pos++];nbits=8;
    }
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
/**
 * 复制「分享链接」到剪贴板。
 * -------------------------------------------------------------------------
 * ⚠ 这里原来**只**复制长链接（实测 24 小节工程就有 33004 字符）——
 *   短链后端此前只接在可视化页的分享卡片上，主应用这个按钮从没走过它。
 *   后果：用户从这里拿到的链接是一大串 base64，二维码根本装不下、聊天软件里也会被截断。
 *   现在改为优先产短链：装了后端就得到 `…/index.html#p=<8位ID>`（约 60 字节，可印二维码）；
 *   未配后端或请求失败时**如实回退**到长链接，并在提示里说明原因，不假装成功。
 */
export async function shareLink(){
  try{
    const h=await buildShareHash();
    const kb=(h.hash.length/1024).toFixed(1);
    let url=buildShareUrl(h.hash);
    let note='约 '+kb+' KB';
    let short=null;
    if(hasApi()){
      /* 失败不抛：短链只是优化，拿不到就用长链接，功能不能因此不可用 */
      try{ short=await createShortLink(h.hash) }catch(e){ short={ok:false,message:(e&&e.message)||'请求异常'} }
    }
    if(short&&short.ok){
      url=buildShareUrl(short.url);
      note='短链 '+short.id+'（'+url.length+' 字节）';
    }else{
      note='长链接约 '+kb+' KB'+(short&&short.message?('（短链不可用：'+short.message+'）'):(hasApi()?'':'（未配置短链后端）'));
    }
    const done=()=>toast('分享链接已复制到剪贴板：'+note+' → 粘贴到浏览器打开即还原工程，或发给别人。','ok','check');
    copyToClip(url,done);
  }catch(e){toast('分享失败：'+e.message,'err')}
}
/**
 * 只算出分享用 hash（'#s=' / '#z=' / '#l='），不复制、不做 UI ——
 * 分享卡片要用同一份编码结果去填二维码，所以拆出来复用。
 * ⚠ 必须先确认工程已载入：serializeProject() 会直接 proj.tracks.map(...)，
 *   工程为空时抛的是 "Cannot read properties of undefined (reading 'map')" 这种
 *   完全看不懂的错误（可视化页在数据装载完成前就可能被调用，实测踩到）。
 * @returns {{hash:string,codec:string,kb:number}}
 * @throws {Error} 工程尚未载入时抛出可读错误（调用方应 try/catch 并提示用户）
 */
export async function buildShareHash(){
  if(!proj||!Array.isArray(proj.tracks)||!proj.tracks.length)
    throw new Error('工程还没载入，暂时无法生成分享链接');
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
  return {hash:best,codec:label,kb:(best.length-1)/1024};
}
export function copyToClip(url,done){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(done).catch(()=>{prompt('复制下面的分享链接：',url);done()});
  }else prompt('复制下面的分享链接：',url);
}
export async function loadShareFromHash(){
  try{
    const h=location.hash||'';
    /* 短链（后端）：#p=<8位ID>。先把载荷取回来，再走下面同一套解码，
       所以后端不需要懂任何音乐格式（见 server/worker.js 的设计说明）。 */
    const sid=shortIdFromHash(h);
    if(sid){
      const r=await fetchShortLink(sid);
      if(!r.ok){
        /* 明确告知失败原因，别静默退回示例工程让用户以为"打开成功了" */
        try{ toast('短链打开失败：'+r.message,'err') }catch(e){}
        return false;
      }
      return applySharePayload(r.data);
    }
    return applySharePayload(h);
  }catch(e){return false}
}
/** 把 '#s=' / '#z=' / '#l=' 载荷解码并应用到工程（短链取回后也走这里） */
async function applySharePayload(h){
  try{
    const s=String(h||'');
    if(s.startsWith('#s=')){ // 旧版/无压缩：纯 Base64
      const j=decodeURIComponent(escape(atob(s.slice(3))));
      const data=JSON.parse(j);
      if(!data.tracks||!data.steps)return false;
      applyProjectData(data);
      return true;
    }
    if(s.startsWith('#z=')){ // deflate 压缩（异步）
      const txt=await inflateB64(s.slice(3));
      const data=JSON.parse(txt);
      if(!data.tracks||!data.steps)throw new Error('bad');
      applyProjectData(data);
      return true;
    }
    if(s.startsWith('#l=')){ // 纯 JS LZSS（同步、全浏览器可用）
      const txt=lzDecode(b64ToBytes(s.slice(3)));
      const data=JSON.parse(txt);
      if(!data.tracks||!data.steps)throw new Error('bad');
      applyProjectData(data);
      return true;
    }
    return false;
  }catch(e){ return false }
}
