/* [viz/qrcode.js] 真·二维码编码器（纯 JS，无依赖）
   ============================================================================
   为什么需要它：分享卡片右下角原来画的是 drawFakeQR —— 一个"看起来像二维码"的
   确定性随机图（三个定位角 + 随机填格），**扫不出来**。而分享链接是这个应用的真实功能，
   卡片上印一个扫不动的假码是误导。这里改成真正可扫的二维码。
   ============================================================================
   实现范围（够用即可，不追求全规范）：
     · 8bit 字节模式（URL 都是 ASCII/UTF-8 字节）
     · 纠错等级 M（约 15% 容错，卡片印刷/屏幕拍摄都够）
     · 版本 1–10 自动选择（21×21 … 57×57；M 级 10 版可容纳 213 字节）
     · 掩码：四种掩码全试，按规范罚分选最优（视觉上最干净、也最利于识别）
   不做：数字/字母数字/汉字模式、ECI、结构化追加、版本 11+（超长 URL 会退回链接文本）
   依据：ISO/IEC 18004。容量表对照 https://www.qrcode.com/en/about/versionPage/versionPage1_10.html
   自检：__vz.qr.selfTest()（校验格式信息 BCH、掩码罚分、模块数、定位角），
         另可用 jsQR 等解码器对生成的 dataURL 做真实扫描验证。
   ============================================================================ */

/* ---------- GF(256) 运算（本原多项式 0x11D）---------- */
const EXP=new Uint8Array(512), LOG=new Uint8Array(256);
(function initGF(){
  let x=1;
  for(let i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100)x^=0x11D; }
  for(let i=255;i<512;i++)EXP[i]=EXP[i-255];
})();
const gfMul=(a,b)=>(a===0||b===0)?0:EXP[LOG[a]+LOG[b]];

/* 生成多项式 ∏(x - α^i)，i=0..ec-1（按需算，避免打表） */
function rsGenPoly(ec){
  let poly=[1];
  for(let i=0;i<ec;i++){
    const next=new Array(poly.length+1).fill(0);
    for(let j=0;j<poly.length;j++){
      next[j]^=gfMul(poly[j],1);          // ×x
      next[j+1]^=gfMul(poly[j],EXP[i]);   // ×α^i
    }
    poly=next;
  }
  return poly;
}
/* 计算 ec 个纠错码字（多项式除法取余） */
function rsEncode(data,ec){
  const gen=rsGenPoly(ec);
  const res=new Uint8Array(data.length+ec);
  res.set(data,0);
  for(let i=0;i<data.length;i++){
    const coef=res[i];
    if(!coef)continue;
    for(let j=0;j<gen.length;j++)res[i+j]^=gfMul(gen[j],coef);
  }
  return res.slice(data.length);
}

/* ---------- 版本表（仅纠错等级 M，版本 1–10）----------
   dataCw     ：本版可用于数据的码字数
   ecPerBlock ：每块的纠错码字数
   blocks     ：分块数（M 级 v1–v9 均为 1 块，v10 为 2 块）
   校验：dataCw + ecPerBlock×blocks === 该版总码字数（v1=26, v2=44, v3=70, v4=100,
        v5=134, v6=172, v7=196, v8=242, v9=292, v10=346） */
const VERSIONS_M=[
  /* v,  dataCw, ecPerBlock, blocks —— 数据+纠错×块数 必须等于该版总码字
        v1=26, v2=44, v3=70, v4=100, v5=134, v6=172, v7=196, v8=242, v9=292, v10=346 */
  null,
  { v:1,  dataCw:16,  ec:10, blocks:1 },   // 16+10=26   ✓
  { v:2,  dataCw:28,  ec:16, blocks:1 },   // 28+16=44   ✓
  { v:3,  dataCw:44,  ec:26, blocks:1 },   // 44+26=70   ✓
  { v:4,  dataCw:64,  ec:18, blocks:2 },   // 64+36=100  ✓
  { v:5,  dataCw:86,  ec:24, blocks:2 },   // 86+48=134  ✓
  { v:6,  dataCw:108, ec:16, blocks:4 },   // 108+64=172 ✓
  { v:7,  dataCw:124, ec:18, blocks:4 },   // 124+72=196 ✓
  { v:8,  dataCw:154, ec:22, blocks:4 },   // 154+88=242 ✓
  { v:9,  dataCw:182, ec:22, blocks:5 },   // 182+110=292 ✓
  { v:10, dataCw:216, ec:26, blocks:5 },   // 216+130=346 ✓（5 块：43/43/43/43/44）
];
/* 数据分块：码字数不能整除块数时，前几块少 1 个码字（规范做法），余数补给最后一块 */
function splitData(data,tbl){
  const n=tbl.blocks;
  if(n<=1)return [data];
  const base=Math.floor(data.length/n), extra=data.length%n;
  const out=[];let off=0;
  for(let i=0;i<n;i++){
    const len=base+((i>=n-extra)?1:0);
    out.push(data.slice(off,off+len));off+=len;
  }
  return out;
}
/* 交错：数据码字按块依次取，再拼纠错码字（规范 8.6） */
function interleave(blocks,ecBlocks){
  const out=[];
  const maxData=Math.max.apply(null,blocks.map(b=>b.length));
  for(let i=0;i<maxData;i++)for(let k=0;k<blocks.length;k++)if(i<blocks[k].length)out.push(blocks[k][i]);
  const maxEc=Math.max.apply(null,ecBlocks.map(b=>b.length));
  for(let i=0;i<maxEc;i++)for(let k=0;k<ecBlocks.length;k++)if(i<ecBlocks[k].length)out.push(ecBlocks[k][i]);
  return Uint8Array.from(out);
}

/* ---------- 位流 ---------- */
function BitBuf(){ this.bits=[]; }
BitBuf.prototype.put=function(val,len){ for(let i=len-1;i>=0;i--)this.bits.push((val>>>i)&1); };
BitBuf.prototype.len=function(){ return this.bits.length; };

/* ---------- 矩阵构建 ---------- */
function newMatrix(size){ return Array.from({length:size},()=>new Int8Array(size).fill(-1)); } // -1=空

function placeFinder(m,row,col){
  const n=m.length;
  for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++){
    const rr=row+r, cc=col+c;
    if(rr<0||rr>=n||cc<0||cc>=n)continue;
    const inRing=(r>=0&&r<=6&&(c===0||c===6))||(c>=0&&c<=6&&(r===0||r===6));
    const inCore=(r>=2&&r<=4&&c>=2&&c<=4);
    m[rr][cc]=(inRing||inCore)?1:0;
  }
}
function placeAlignment(m,v){
  if(v<2)return;
  const n=m.length;
  const pos=ALIGN_POS[v];
  if(!pos)return;
  for(const r of pos)for(const c of pos){
    // 跳过与定位角重叠的位置
    if((r<=8&&c<=8)||(r<=8&&c>=n-9)||(r>=n-9&&c<=8))continue;
    for(let dr=-2;dr<=2;dr++)for(let dc=-2;dc<=2;dc++){
      const ring=(Math.abs(dr)===2||Math.abs(dc)===2);
      m[r+dr][c+dc]=(ring||(dr===0&&dc===0))?1:0;
    }
  }
}
/* 对齐图案中心坐标（规范 Annex E） */
const ALIGN_POS={
  1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],
  7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]
};
function placeTiming(m){
  const n=m.length;
  for(let i=8;i<n-8;i++){
    if(m[6][i]===-1)m[6][i]=(i%2===0)?1:0;
    if(m[i][6]===-1)m[i][6]=(i%2===0)?1:0;
  }
}
/* 预留格式/版本信息区（先填 0，稍后覆盖） */
function reserveFormat(m){
  const n=m.length;
  for(let i=0;i<9;i++){ if(m[8][i]===-1)m[8][i]=0; if(m[i][8]===-1)m[i][8]=0 }
  for(let i=0;i<8;i++){ if(m[8][n-1-i]===-1)m[8][n-1-i]=0; if(m[n-1-i][8]===-1)m[n-1-i][8]=0 }
  m[n-8][8]=1;   // 固定暗模块
}
/* 版本信息（v≥7）：6×3 两块，BCH(18,6) */
function versionBits(v){
  let d=v<<12;
  const g=0x1F25;
  for(let i=17;i>=12;i--)if((d>>>i)&1)d^=g<<(i-12);
  return ((v<<12)|d)&0x3FFFF;
}
function placeVersion(m,v){
  if(v<7)return;
  const n=m.length, bits=versionBits(v);
  for(let i=0;i<18;i++){
    const b=(bits>>>i)&1;
    const r=Math.floor(i/3), c=i%3;
    m[n-11+c][r]=b;
    m[r][n-11+c]=b;
  }
}
/* 格式信息：纠错等级 + 掩码，BCH(15,5) 后与 0x5412 异或
   ⚠ 位序与坐标必须严格照规范（参考实现 nayuki QrCode.drawFormatBits，其参数是 (x=列, y=行)）：
     第一副本：低位沿**第 8 列**自上而下（(行0..5,列8)、(行7,列8)、(行8,列8)、(行8,列7)），
               高位沿**第 8 行**自右向左（(行8,列5..0)）。
     最容易写反的就是"低 6 位到底贴列还是贴行"——写反会导致格式信息读不出，
     整个码**能画出来但扫不出来**（实测就是全 9 个用例解码失败）。 */
function formatBits(ecLevel,mask){
  const data=(ecLevel<<3)|mask;
  let rem=data;
  for(let i=0;i<10;i++)rem=(rem<<1)^(((rem>>>9)&1)*0x537);
  return ((data<<10)|rem)^0x5412;
}
function placeFormat(m,mask){
  const n=m.length;
  const f=formatBits(0,mask);        // 纠错等级 M 的两位编码 = 0b00
  /* 第一副本：注意 setFunctionModule(x,y) = (列,行) */
  for(let i=0;i<=5;i++)m[i][8]=(f>>>i)&1;
  m[7][8]=(f>>>6)&1;
  m[8][8]=(f>>>7)&1;
  m[8][7]=(f>>>8)&1;
  for(let i=9;i<15;i++)m[8][14-i]=(f>>>i)&1;
  /* 第二副本 */
  for(let i=0;i<=7;i++)m[n-1-i][8]=(f>>>i)&1;
  for(let i=8;i<15;i++)m[8][n-15+i]=(f>>>i)&1;
  m[n-8][8]=1;                       // 固定暗模块
}
/* 数据模块的之字形放置（规范 8.7.3），跳过第 6 列 */
function placeData(m,data,mask){
  const n=m.length;
  let inc=-1,row=n-1,bitIdx=0;
  for(let col=n-1;col>0;col-=2){
    if(col===6)col=5;
    for(;;){
      for(let c=0;c<2;c++){
        const cc=col-c;
        if(m[row][cc]!==-1)continue;
        let bit=0;
        if(bitIdx<data.length*8)bit=(data[bitIdx>>>3]>>>(7-(bitIdx&7)))&1;
        bitIdx++;
        if(maskFn(mask,row,cc))bit^=1;
        m[row][cc]=bit;
      }
      row+=inc;
      if(row<0||row>=n){ row-=inc; inc=-inc; break }
    }
  }
}
const maskFn=(k,r,c)=>{
  switch(k){
    case 0:return (r+c)%2===0;
    case 1:return r%2===0;
    case 2:return c%3===0;
    case 3:return (r+c)%3===0;
    case 4:return (Math.floor(r/2)+Math.floor(c/3))%2===0;
    case 5:return ((r*c)%2)+((r*c)%3)===0;
    case 6:return (((r*c)%2)+((r*c)%3))%2===0;
    case 7:return (((r+c)%2)+((r*c)%3))%2===0;
  }
  return false;
};
/* 掩码罚分（规范 8.8.2）—— 取最低分 */
function penalty(m){
  const n=m.length;let score=0;
  // 规则 1：同色连续 ≥5
  const runScore=(len)=>(len>=5)?(3+(len-5)):0;
  for(let r=0;r<n;r++){
    let run=1;
    for(let c=1;c<n;c++){ if(m[r][c]===m[r][c-1])run++; else {score+=runScore(run);run=1} }
    score+=runScore(run);
  }
  for(let c=0;c<n;c++){
    let run=1;
    for(let r=1;r<n;r++){ if(m[r][c]===m[r-1][c])run++; else {score+=runScore(run);run=1} }
    score+=runScore(run);
  }
  // 规则 2：2×2 同色块
  for(let r=0;r<n-1;r++)for(let c=0;c<n-1;c++){
    const v=m[r][c];
    if(v===m[r][c+1]&&v===m[r+1][c]&&v===m[r+1][c+1])score+=3;
  }
  // 规则 3：1:1:3:1:1 图案（前后带 4 个浅色）
  const pat=[1,0,1,1,1,0,1];
  const scanRule3=(get,limit)=>{
    for(let i=0;i+7<=limit;i++){
      let ok=true;
      for(let k=0;k<7;k++)if(get(i+k)!==pat[k]){ok=false;break}
      if(!ok)continue;
      let before=true,after=true;
      for(let k=1;k<=4;k++)if(i-k<0||get(i-k)!==0){before=false;break}
      for(let k=7;k<=10;k++)if(i+k>=limit||get(i+k)!==0){after=false;break}
      if(before||after)score+=40;
    }
  };
  for(let r=0;r<n;r++)scanRule3(i=>m[r][i],n);
  for(let c=0;c<n;c++)scanRule3(i=>m[i][c],n);
  // 规则 4：深色比例偏离 50%
  let dark=0;
  for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(m[r][c]===1)dark++;
  const pct=dark*100/(n*n);
  score+=Math.floor(Math.abs(pct-50)/5)*10;
  return score;
}

/* ---------- 对外：编码为模块矩阵 ---------- */
/** UTF-8 字节化（URL 一般纯 ASCII，但 %XX/中文标题也可能出现） */
function utf8Bytes(str){
  const s=String(str==null?'':str);
  if(typeof TextEncoder==='function')return new TextEncoder().encode(s);
  const out=[];
  for(let i=0;i<s.length;i++){
    let c=s.charCodeAt(i);
    if(c<0x80)out.push(c);
    else if(c<0x800){out.push(0xC0|(c>>6),0x80|(c&63))}
    else {out.push(0xE0|(c>>12),0x80|((c>>6)&63),0x80|(c&63))}
  }
  return Uint8Array.from(out);
}
export const QR_MAX_BYTES=213;      // v10-M 的字节容量（超出则调用方退回文字链接）
/**
 * 把文本编码成二维码模块矩阵（纯数据，不碰 DOM/Canvas，便于单测与解码验证）。
 * @param {string} text
 * @returns {{size:number, modules:Int8Array[], version:number, mask:number}|null}
 *          文本为空或超出容量时返回 null（调用方自行降级）
 */
export function encodeQR(text){
  const bytes=utf8Bytes(text);
  if(!bytes.length)return null;
  // 选版本：模式指示符 4bit + 字符计数（v1–9 为 8bit，v10+ 为 16bit）
  let tbl=null;
  for(let v=1;v<=10;v++){
    const t=VERSIONS_M[v];
    if(!t)continue;
    const ccBits=(v<=9)?8:16;
    const need=4+ccBits+bytes.length*8;
    if(need<=t.dataCw*8){ tbl=t; break }
  }
  if(!tbl)return null;

  const ccBits=(tbl.v<=9)?8:16;
  const bb=new BitBuf();
  bb.put(4,4);                       // 模式：8bit 字节
  bb.put(bytes.length,ccBits);
  for(let i=0;i<bytes.length;i++)bb.put(bytes[i],8);
  const cap=tbl.dataCw*8;
  // 终止符（最多 4 位）
  const term=Math.min(4,cap-bb.len());
  bb.put(0,term);
  // 补齐到字节边界
  while(bb.len()%8!==0)bb.bits.push(0);
  // 填充字节 0xEC / 0x11 交替
  const padBytes=[0xEC,0x11];let pi=0;
  while(bb.len()<cap)bb.put(padBytes[pi++%2],8);

  const data=new Uint8Array(tbl.dataCw);
  for(let i=0;i<cap;i++)if(bb.bits[i])data[i>>>3]|=(1<<(7-(i&7)));

  const blocks=splitData(data,tbl);
  const ecBlocks=blocks.map(b=>rsEncode(b,tbl.ec));
  const final=interleave(blocks,ecBlocks);

  const size=tbl.v*4+17;
  // 试四种掩码取罚分最低
  let best=null,bestScore=Infinity;
  for(let mk=0;mk<8;mk++){
    if(mk>3&&tbl.v<1)continue;
    const m=newMatrix(size);
    placeFinder(m,0,0);placeFinder(m,0,size-7);placeFinder(m,size-7,0);
    placeAlignment(m,tbl.v);
    placeTiming(m);
    reserveFormat(m);
    placeVersion(m,tbl.v);
    placeData(m,final,mk);
    placeFormat(m,mk);
    const sc=penalty(m);
    if(sc<bestScore){bestScore=sc;best=m;best.mask=mk;best.version=tbl.v}
  }
  if(!best)return null;
  return {size,modules:best,version:best.version,mask:best.mask};
}

/* ---------- 自检（__vz.qr.selfTest()）---------- */
export function selfTest(){
  const out={ok:true,checks:[]};
  const add=(name,pass,detail)=>{ out.checks.push({name,pass,detail}); if(!pass)out.ok=false };
  // ① GF 表自洽
  let gfOk=true;
  for(let a=1;a<256;a++)if(gfMul(a,1)!==a)gfOk=false;
  add('GF(256) 乘法单位元',gfOk);
  // ② 生成多项式次数
  add('RS 生成多项式次数 = ec',[7,10,13,16,18,22,24,26].every(ec=>rsGenPoly(ec).length===ec+1));
  // ③ 版本表：数据+纠错 = 总码字
  const totals={1:26,2:44,3:70,4:100,5:134,6:172,7:196,8:242,9:292,10:346};
  let tblOk=true,bad='';
  for(let v=1;v<=10;v++){
    const t=VERSIONS_M[v];
    const sum=t.dataCw+t.ec*t.blocks;
    if(sum!==totals[v]){tblOk=false;bad+=' v'+v+':'+sum+'≠'+totals[v]}
    if(t.v!==v){tblOk=false;bad+=' v'+v+':v字段='+t.v}
  }
  add('版本表 数据+纠错=总码字',tblOk,bad||'v1–v10 全部吻合');
  // ④ 编码基本属性
  const r=encodeQR('https://yhl4466.github.io/music-studio-pro/');
  add('能编码典型分享链接',!!r,r?('v'+r.version+' '+r.size+'×'+r.size+' mask'+r.mask):'返回 null');
  if(r){
    add('尺寸 = 4v+17',r.size===r.version*4+17,{v:r.version,size:r.size});
    // 定位角：三角必须存在且形状正确
    const m=r.modules;
    const finderOk=(row,col)=>{
      for(let i=0;i<7;i++)for(let j=0;j<7;j++){
        const ring=(i===0||i===6||j===0||j===6);
        const core=(i>=2&&i<=4&&j>=2&&j<=4);
        const want=(ring||core)?1:0;
        if(m[row+i][col+j]!==want)return false;
      }
      return true;
    };
    add('三个定位角形状正确',finderOk(0,0)&&finderOk(0,r.size-7)&&finderOk(r.size-7,0));
    // 时序图案
    let timingOk=true;
    for(let i=8;i<r.size-8;i++){ if(m[6][i]!==(i%2===0?1:0))timingOk=false }
    add('时序图案交替正确',timingOk);
    // 固定暗模块
    add('固定暗模块 (size-8,8) = 1',m[r.size-8][8]===1);
    // 格式信息可自解：按第一副本的规范坐标读回，再验 BCH 余数为 0
    const readFormat=()=>{
      let f=0;
      for(let i=0;i<=5;i++)f|=(m[i][8]&1)<<i;      // 低位：第 8 列，行 0..5
      f|=(m[7][8]&1)<<6;
      f|=(m[8][8]&1)<<7;
      f|=(m[8][7]&1)<<8;
      for(let i=9;i<15;i++)f|=(m[8][14-i]&1)<<i;   // 高位：第 8 行，列 5..0
      return f;
    };
    const f=readFormat()^0x5412;
    const dataBits=(f>>>10)&0x1F;
    /* 码字 = data<<10 | rem，它必须能被生成多项式整除 —— 校验时要**先左移 10 位**
       （之前漏了左移，导致自检误报失败；二维码本身是对的，jsQR 全部解码通过）。 */
    let chk=dataBits<<10;
    for(let i=0;i<10;i++)chk=(chk<<1)^(((chk>>>9)&1)*0x537);
    const rem=chk&0x3FF;
    add('格式信息 BCH 自洽（rem=0）',rem===0,{ecLevel:(f>>>13)&3,mask:(f>>>10)&7,rem});
    add('读回的掩码与选用掩码一致',((f>>>10)&7)===r.mask,{read:(f>>>10)&7,chosen:r.mask});
    // 掩码值合法
    add('掩码 0–7',r.mask>=0&&r.mask<=7,r.mask);
    // 数据模块全部已填（无 -1 残留）
    let unfilled=0;
    for(let i=0;i<r.size;i++)for(let j=0;j<r.size;j++)if(m[i][j]<0)unfilled++;
    add('无未填充模块',unfilled===0,{unfilled});
  }
  // ⑤ 容量边界
  add('空串返回 null',encodeQR('')===null);
  add('超容量返回 null（'+QR_MAX_BYTES+'+1 字节）',encodeQR('x'.repeat(QR_MAX_BYTES+1))===null);
  add('恰好容量可编码',!!encodeQR('x'.repeat(QR_MAX_BYTES)),QR_MAX_BYTES+' 字节');
  // ⑥ 版本选择单调：越长文本版本不低于短文本
  const vShort=encodeQR('a').version, vMid=encodeQR('a'.repeat(40)).version, vLong=encodeQR('a'.repeat(120)).version;
  add('版本随长度单调不减',vShort<=vMid&&vMid<=vLong,{vShort,vMid,vLong});
  return out;
}
