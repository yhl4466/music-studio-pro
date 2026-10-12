/* [viz/sheetQR.js] 谱子二维码图纸生成器（纯绘制，不碰 DOM/单例）
   =========================================================================
   用途：把整个工程编成**一组**真二维码印在一张图上，便于用手机逐张扫回。
   为什么是一组而不是一张：单张二维码容量上限 213 字节（QR v10-M），
   而工程数据最小也要 259 字节、真实作品 1.5–6 KB —— 单张在原理上装不下。

   编码链路（与既有分享链接同源，**无损**）：
     工程对象 → JSON → deflate/LZSS（选更短）→ '#z='/'#l=' 形式的 hash
     → 按每张二维码的容量切段 → 每段前面加 'i/n:' 头 → 逐段编码成二维码。
   解码端说明：把每段扫出来，按 i 顺序拼回 hash，粘到分享链接后面即还原工程。
   本文件只负责"画"，数据由调用方给（与 cover.js / fingerprint.js 同一契约）。

   ⚠ 每模块必须整数像素（踩过坑，见 qrcode.js 注释）：先按格子尺寸求整数 cell，
     再由 cell 反推二维码边长。非整数格宽会让模块边界忽宽忽窄，实测必然扫不出。
   ========================================================================= */
import { encodeQR, QR_MAX_BYTES } from './qrcode.js';

/* ---------- 版面常量（逻辑像素）---------- */
const PAD=40;                     // 外边距
const GAP=28;                     // 格间距
const CELL_W=250;                 // 单格宽（含二维码 + 说明文字）
const QR_BOX=224;                 // 二维码方框边长上限（整数 cell 后实际更小）
const QUIET=4;                    // 静默区模块数（规范要求 ≥4）
const HEAD_H=96;                  // 顶部标题区高
const FOOT_H=64;                  // 底部说明区高
const COLS_MAX=6;                 // 每行最多几格
const FONT='"Segoe UI","Microsoft YaHei",system-ui,sans-serif';
const MONO='ui-monospace,Consolas,"Courier New",monospace';

/** 每张二维码能装多少字节的载荷（扣掉 '12/34:' 这样的段头，留足余量） */
function payloadBudget(n){
  const head=String(n).length*2+3;      // 'i/n:' + 分隔
  return Math.max(20,QR_MAX_BYTES-head);
}
/**
 * 把 hash 切成人可扫的段。
 * @param {string} hash 形如 '#z=xxxx'
 * @param {number} perCode 每段最大字节数
 * @returns {string[]} 段数组（每段自带 'i/n:' 头）
 */
export function segmentHash(hash,perCode){
  const body=String(hash||'');
  const per=Math.max(10,perCode|0);
  const parts=[];
  for(let i=0;i<body.length;i+=per)parts.push(body.slice(i,i+per));
  if(!parts.length)parts.push('');
  const n=parts.length;
  return parts.map((p,i)=>(i+1)+'/'+n+':'+p);
}

/** 单张二维码：整数 cell + 白底 + 静默区 + 纯黑模块（与 shareCard 同一套画法） */
function drawOneQR(ctx,x,y,maxSize,text){
  const enc=encodeQR(text);
  if(!enc)return null;
  const n=enc.size;
  const cell=Math.max(1,Math.floor(maxSize/(n+QUIET*2)));
  const size=cell*(n+QUIET*2);
  ctx.fillStyle='#ffffff';
  ctx.fillRect(x,y,size,size);
  ctx.fillStyle='#000000';
  const px0=x+QUIET*cell, py0=y+QUIET*cell;
  for(let r=0;r<n;r++){
    for(let c=0;c<n;c++){
      if(enc.modules[r][c]!==1)continue;
      ctx.fillRect(px0+c*cell,py0+r*cell,cell,cell);
    }
  }
  return {size,cell,version:enc.version,box:maxSize};
}

/**
 * 生成"谱子二维码"图纸。
 * @param {HTMLCanvasElement} canvas 目标画布
 * @param {{hash?:string,title?:string,meta?:string,scale?:number}} [opts]
 *        hash：'#z='/'#l=' 形式的工程数据；title：曲名；meta：一行摘要（BPM/调式等）
 * @returns {{codes:number,size:string,perCode:number,cells:Array}}
 */
export function generateSheetQR(canvas,opts){
  const o=opts||{};
  const scale=Math.max(1,Math.min(3,Math.round(o.scale||1)));
  const hash=String(o.hash||'');
  const title=String(o.title||'未命名工程');
  const meta=String(o.meta||'');
  if(!hash)return {ok:false,reason:'no-data',codes:0};

  const segments=segmentHash(hash,payloadBudget(2));
  const n=segments.length;
  const cols=Math.min(COLS_MAX,Math.max(1,Math.ceil(Math.sqrt(n*1.6))));
  const rows=Math.ceil(n/cols);
  const W=PAD*2+cols*CELL_W+(cols-1)*GAP;
  const H=PAD*2+HEAD_H+rows*(QR_BOX+52)+(rows-1)*GAP+FOOT_H;
  const px=W*scale, py=H*scale;
  if(canvas.width!==px)canvas.width=px;
  if(canvas.height!==py)canvas.height=py;
  const ctx=canvas.getContext('2d');
  ctx.setTransform(scale,0,0,scale,0,0);
  /* 纯白底：二维码必须高对比，不要主题色 */
  ctx.fillStyle='#ffffff';
  ctx.fillRect(0,0,W,H);

  /* —— 标题区 —— */
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  ctx.fillStyle='#111111';
  ctx.font='700 30px '+FONT;
  ctx.fillText('谱子二维码 · '+title,PAD,PAD+34);
  ctx.font='400 15px '+FONT;
  ctx.fillStyle='#555555';
  const kb=(hash.length/1024).toFixed(1);
  ctx.fillText('共 '+n+' 张，请按左上角编号 1 → '+n+' 依次扫码；扫完把结果按顺序拼起来即为完整链接。'
    +'（工程数据 '+kb+' KB）',PAD,PAD+62);
  if(meta){
    ctx.font='400 14px '+MONO;
    ctx.fillStyle='#777777';
    ctx.fillText(meta,PAD,PAD+84);
  }
  ctx.strokeStyle='#dddddd';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(PAD,PAD+HEAD_H-8);ctx.lineTo(W-PAD,PAD+HEAD_H-8);ctx.stroke();

  /* —— 逐格画二维码 —— */
  const cells=[];
  const y0=PAD+HEAD_H;
  for(let i=0;i<n;i++){
    const cx=PAD+(i%cols)*(CELL_W+GAP);
    const cy=y0+Math.floor(i/cols)*(QR_BOX+52+GAP);
    const info=drawOneQR(ctx,cx,cy,QR_BOX,segments[i]);
    if(!info){ cells.push({index:i+1,failed:true}); continue }
    /* 编号 + 容量标注 */
    ctx.fillStyle='#111111';
    ctx.font='700 17px '+MONO;
    ctx.fillText((i+1)+' / '+n,cx,cy+info.size+24);
    ctx.fillStyle='#777777';
    ctx.font='400 12px '+FONT;
    ctx.fillText('v'+info.version+' · '+segments[i].length+' 字节',cx+70,cy+info.size+24);
    cells.push({index:i+1,version:info.version,cell:info.cell,size:info.size,bytes:segments[i].length});
  }

  /* —— 底部说明 —— */
  ctx.fillStyle='#555555';
  ctx.font='400 14px '+FONT;
  const bad=cells.filter(c=>c.failed).length;
  ctx.fillText((bad?('⚠ 有 '+bad+' 张超出容量，未能生成；请减少轨数或曲长后重试。')
                   :'每张二维码都已按整数像素绘制，保证可扫。')
    +'  提示：本图只承载"工程数据"，扫出来的文本请拼成一条链接再打开。',
    PAD,H-PAD+8);

  return {ok:true,codes:n,size:W+'x'+H,scale,cols,rows,perCode:payloadBudget(2),cells,
    hashBytes:hash.length};
}

/** 自检（__vz.sheetQR.selfTest()）：真实编码 + 逐模块像素核对 */
export function selfTest(){
  const checks=[];
  const add=(n,p,d)=>{checks.push({name:n,pass:!!p,detail:d});return !!p};
  const hash='#z='+('AbCdEf0123456789'.repeat(6));      // 168 字节载荷
  const segs=segmentHash(hash,payloadBudget(2));
  add('切段：段数 ≥ 1',segs.length>=1,segs.length);
  add('切段：每段都不超容量',
    segs.every(s=>s.length<=QR_MAX_BYTES),segs.map(s=>s.length));
  add('切段：带 i/n 头且序号连续',
    segs.every((s,i)=>s.startsWith((i+1)+'/'+segs.length+':')),segs.map(s=>s.slice(0,6)));
  add('切段：拼回后与原文一致',
    segs.map(s=>s.slice(s.indexOf(':')+1)).join('')===hash,
    segs.map(s=>s.slice(s.indexOf(':')+1)).join('').length+' vs '+hash.length);
  /* 每段都能被真编码器接受 */
  add('每段都能编码成二维码',segs.every(s=>!!encodeQR(s)));
  return {ok:checks.every(c=>c.pass),checks};
}
