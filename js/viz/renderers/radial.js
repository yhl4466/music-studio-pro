/* [viz/renderers/radial.js] 径向频谱（FEAT-V3 / 渲染器 1）。
   形态：中心为原点，360° 均分 N 个扇形，每个扇形的**长度** = 该频率段的能量（对数频率映射）；
   低频从正上方（-90°）起顺时针递增到高频；条形自内半径向外生长，整体像一个会呼吸的频谱环。
   数据源：audio.freqData（每帧现算，逐扇形取覆盖 bin 的均值 → dB 归一，与瀑布图/雷达图同源）
           + audio.beat（低频包络 env 驱动"呼吸"、onset/strength 驱动"膨胀一下"）。
   实现要点：
   1) 极坐标查表：每个扇形的两条边方向在"扇形数变化时"一次性算好（cos/sin 表），
      旋转只把方向向量与 (cosR,sinR) 做一次 2×2 旋转 —— draw 内的三角函数只剩每帧 2 次。
      （角度一律用弧度累积，不用度数，避免 deg→rad 反复换算。）
   2) 参考环（内半径圆 + 4 层等分环 + 12 条辐条）画到**离屏 canvas** 缓存，
      draw 里只一次 drawImage（学 V2 的 ecg/radar，避免每帧几十条抗锯齿描边）。
   3) 呼吸/膨胀：pulse = 1 + BREATH×包络平滑值 + PUNCH×脉冲；
      内半径与外半径**同时**乘 pulse（= 整体半径缩放，"鼓点时整个图形膨胀一下"）。
      脉冲用一阶指数衰减（不是弹簧），不产生过冲。
   4) 每帧零分配：扇形值 / 边方向表 / bin 区间 LUT / 每扇颜色字符串全部在
      模块加载或"参数变化时"预生成；draw 内不建数组、不拼字符串（中心读数取预生成文本表）。
   5) 发光不做 shadowBlur（每帧一次模糊图层太贵，V2 的 ecg 已踩过），
      而是"同一批梯形外扩几像素、单路径低透明度填充一遍"的假光晕。
   契约与参数：params 是**纯声明对象**（键名即参数名），当前值在 values（缺省回落 def）。
   已知限制：契约不含 sampleRate，频率轴按 44.1kHz 估算（与 viz/audio.js 的离线渲染同率）。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const NMAX=128;                    // 扇形数上限（= params.bars 的 max），查表按上限一次分配
const NMIN=32;
const FMIN=30;                     // 对数频率轴下沿（Hz）
const FMAX=20000;                  // 对数频率轴上沿（Hz）
const NYQUIST=22050;               // bin→Hz 参考（44.1kHz/2，与瀑布图同源）
const MAX_DPR=3;
const GAP=.18;                     // 扇形间空隙占扇宽的比例
const BREATH=.07;                  // 低频包络对整体半径的呼吸幅度
const PUNCH=.13;                   // 鼓点脉冲的瞬时膨胀幅度
const PUNCH_TAU=.18;               // 脉冲回落时间常数（秒，一阶指数衰减）
const ENV_TAU=.12;                 // 包络平滑时间常数（秒）
const ATK_TAU=.045;                // 条形快攻（秒）
const REL_TAU=.16;                 // 条形慢放（秒）
const ROT_SPEED=.12;               // 旋转角速度（弧度/秒）
const DB_LO=80, DB_WIN=60;         // 可视窗口：-80…-20dB → 0…1（与瀑布图/雷达图同源）
const GAIN_REF=1.2;                // 归一后的小幅增益：满量程信号能顶到外圈
const GLOW_PX=5;                   // 假光晕外扩像素（逻辑px）
const FALLBACK={acc:'#00d9ff',acc2:'#7c6cff',acc3:'#ff7ac8',txt:'#e9eefb'};

/* 中心能量读数文本表：0-100% 预生成，避免每帧拼字符串 */
const E_TEXT=[];
for(let i=0;i<=100;i++)E_TEXT[i]=i+'%';

/* ---------- 模块状态（全部预分配；draw 内不分配） ---------- */
const _c={
  val:new Float32Array(NMAX),      // 平滑后的扇形值 0..1
  out:new Float32Array(NMAX),      // 镜像后的取值（mirror 开时用）
  bLo:new Int32Array(NMAX),        // 每扇形覆盖的 bin 区间 [bLo,bHi)
  bHi:new Int32Array(NMAX),
  e0x:new Float32Array(NMAX),e0y:new Float32Array(NMAX),   // 扇形左边界方向（单位向量）
  e1x:new Float32Array(NMAX),e1y:new Float32Array(NMAX),   // 扇形右边界方向
  barCol:new Array(NMAX),          // 每扇颜色字符串（低频→高频沿主题三色渐变）
  tabN:0,tabCol:-1,                // 建表时的扇形数 / 配色版本号
  lutN:0,lutBins:0,                // bin LUT 的建表依据
  rot:0,punch:0,envS:0,            // 旋转角 / 脉冲量 / 包络平滑值
  ring:null,rw:0,rh:0,rinner:-1,   // 参考环离屏缓存
  acc:'',acc2:'',acc3:'',txt:'',   // 主题色（init/resize 读一次）
  colVer:0
};

function readCss(name,fb){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue(name);
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return fb;
}
/* 只在 init/resize/配色重建时调用：解析 #rgb / #rrggbb / rgb()，其余回落默认色 */
function parseColor(s,fb){
  const t=String(s||'').trim();
  const m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if(m){
    let h=m[1];
    if(h.length===3)h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
  }
  const m2=/^rgba?\(([^)]+)\)$/i.exec(t);
  if(m2){
    const p=m2[1].split(',');
    return [Number(p[0])||0,Number(p[1])||0,Number(p[2])||0];
  }
  return fb;
}
/* 扇形方向表 + 每扇颜色字符串：扇形数变化或主题色变化时重建（不是每帧） */
function buildTables(N){
  const colVer=_c.colVer;
  if(_c.tabN===N&&_c.tabCol===colVer)return;
  _c.tabN=N; _c.tabCol=colVer;
  const hw=Math.PI/N*(1-GAP);                  // 半扇宽（弧度，含空隙）
  const step=2*Math.PI/N;
  for(let i=0;i<N;i++){
    const a=-Math.PI/2+i*step;                 // 角度制→弧度：全程弧度累积
    _c.e0x[i]=Math.cos(a-hw); _c.e0y[i]=Math.sin(a-hw);
    _c.e1x[i]=Math.cos(a+hw); _c.e1y[i]=Math.sin(a+hw);
  }
  /* 颜色：低频 --acc2 → 中频 --acc → 高频 --acc3（"主题色渐变（低 → 高）"） */
  const c2=parseColor(_c.acc2,[124,108,255]);
  const c1=parseColor(_c.acc,[0,217,255]);
  const c3=parseColor(_c.acc3,[255,122,200]);
  for(let i=0;i<N;i++){
    const t=N>1?i/(N-1):0;
    let r,g,b;
    if(t<.5){
      const k=t/.5;
      r=c2[0]+(c1[0]-c2[0])*k; g=c2[1]+(c1[1]-c2[1])*k; b=c2[2]+(c1[2]-c2[2])*k;
    }else{
      const k=(t-.5)/.5;
      r=c1[0]+(c3[0]-c1[0])*k; g=c1[1]+(c3[1]-c1[1])*k; b=c1[2]+(c3[2]-c1[2])*k;
    }
    _c.barCol[i]='rgb('+(r|0)+','+(g|0)+','+(b|0)+')';
  }
}
/* 对数频率轴 → 每扇形覆盖的 bin 区间（扇形数/频点数变化时重建） */
function buildLut(N,bins){
  if(_c.lutN===N&&_c.lutBins===bins)return;
  _c.lutN=N; _c.lutBins=bins;
  const ratio=Math.pow(FMAX/FMIN,1/N);
  for(let i=0;i<N;i++){
    const f0=FMIN*Math.pow(ratio,i), f1=f0*ratio;
    let b0=Math.floor(f0/NYQUIST*bins);
    let b1=Math.ceil(f1/NYQUIST*bins);
    b0=clamp(b0,0,bins-1); b1=clamp(b1,b0+1,bins);
    _c.bLo[i]=b0; _c.bHi[i]=b1;
  }
}
/* 参考环离屏缓存：内半径圆 + 4 层等分环 + 12 条辐条（按设备像素画，draw 里 1:1 贴图） */
function ensureRing(view,innerR){
  const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
  const w=Math.max(1,Math.round((view.w||1)*dpr));
  const h=Math.max(1,Math.round((view.h||1)*dpr));
  if(_c.ring&&_c.rw===w&&_c.rh===h&&_c.rinner===innerR)return _c.ring;
  const cv=document.createElement('canvas');
  cv.width=w; cv.height=h;
  const cx=cv.getContext('2d');
  const mx=w/2,my=h/2,R=Math.min(w,h)*.46;
  const rIn=R*innerR;
  cx.strokeStyle=_c.txt;
  cx.lineWidth=dpr;
  cx.globalAlpha=.09;
  cx.beginPath();
  for(let k=0;k<=4;k++){
    const rr=rIn+(R-rIn)*k/4;
    cx.moveTo(mx+rr,my);
    cx.arc(mx,my,rr,0,Math.PI*2);
  }
  cx.stroke();
  cx.beginPath();
  for(let k=0;k<12;k++){
    const a=k*Math.PI/6;
    const ca=Math.cos(a),sa=Math.sin(a);
    cx.moveTo(mx+ca*rIn,my+sa*rIn);
    cx.lineTo(mx+ca*R,my+sa*R);
  }
  cx.stroke();
  _c.ring=cv; _c.rw=w; _c.rh=h; _c.rinner=innerR;
  return cv;
}
/* 追加一个扇形梯形的四条边到当前路径（不做 beginPath/fill，供光晕与实心两趟复用）。
    入参 ri/ro 是半径，方向向量按 cosR/sinR 现旋转（每帧每扇 8 乘 4 加，无三角函数）。 */
function quad(ctx,cx,cy,cosR,sinR,i,ri,ro){
  const ax=_c.e0x[i]*cosR-_c.e0y[i]*sinR, ay=_c.e0x[i]*sinR+_c.e0y[i]*cosR;
  const bx=_c.e1x[i]*cosR-_c.e1y[i]*sinR, by=_c.e1x[i]*sinR+_c.e1y[i]*cosR;
  ctx.moveTo(cx+ax*ri,cy+ay*ri);
  ctx.lineTo(cx+ax*ro,cy+ay*ro);
  ctx.lineTo(cx+bx*ro,cy+by*ro);
  ctx.lineTo(cx+bx*ri,cy+by*ri);
  ctx.closePath();
}

export const radial={
  id:'radial',
  label:'径向频谱',
  params:{
    /* isPrimary（批 B 参数分级）：结构三件套常驻；发光/镜像收进「更多参数」 */
    bars:   {type:'range',min:32,max:128,step:16,def:64,label:'扇形数',fixed:0,isPrimary:true},
    innerR: {type:'range',min:.1,max:.6,step:.05,def:.3,label:'内半径',fixed:2,isPrimary:true},
    rotate: {type:'toggle',def:true,label:'旋转',isPrimary:true},
    glow:   {type:'toggle',def:true,label:'发光'},
    mirror: {type:'toggle',def:false,label:'镜像'}
  },
  values:{ bars:64, innerR:.3, rotate:true, glow:true, mirror:false },

  init(ctx,view){
    _c.acc=readCss('--acc',FALLBACK.acc);
    _c.acc2=readCss('--acc2',FALLBACK.acc2);
    _c.acc3=readCss('--acc3',FALLBACK.acc3);
    _c.txt=readCss('--txt',FALLBACK.txt);
    _c.colVer++;
    _c.ring=null; _c.rinner=-1;
    _c.rot=0; _c.punch=0; _c.envS=0;
    _c.val.fill(0); _c.out.fill(0);
  },
  /* resize：参考环按新尺寸/内半径重建；方向表与 bin LUT 与像素无关，不动 */
  resize(ctx,view){
    _c.acc=readCss('--acc',FALLBACK.acc);
    _c.acc2=readCss('--acc2',FALLBACK.acc2);
    _c.acc3=readCss('--acc3',FALLBACK.acc3);
    _c.txt=readCss('--txt',FALLBACK.txt);
    _c.colVer++;
    _c.ring=null; _c.rinner=-1;
  },
  dispose(){
    _c.ring=null; _c.rw=0; _c.rh=0; _c.rinner=-1;
    _c.val.fill(0); _c.out.fill(0);
    _c.rot=0; _c.punch=0; _c.envS=0;
    _c.tabN=0; _c.tabCol=-1; _c.lutN=0; _c.lutBins=0;
  },

  draw(ctx,view,audio){
    const w=view.w,h=view.h,cx=w/2,cy=h/2;
    const v=this.values;
    const N=clamp(Math.round(Number(v.bars)||64),NMIN,NMAX);
    const innerR=clamp(Number(v.innerR)||.3,.1,.6);
    const fd=(audio&&audio.freqData)?audio.freqData:null;
    const beat=(audio&&audio.beat)?audio.beat:null;
    const dt=clamp(Number(audio&&audio.dt)||1/60,0,.25);

    buildTables(N);
    buildLut(N,(fd&&fd.length)?fd.length:1024);

    /* ---- 每帧取值：逐扇形 bin 均值 → dB 归一 → 快攻慢放 EMA ---- */
    const val=_c.val,inv=1/255;
    const ka=1-Math.exp(-dt/ATK_TAU), kr=1-Math.exp(-dt/REL_TAU);
    for(let i=0;i<N;i++){
      let u=0;
      if(fd&&fd.length){
        const b0=_c.bLo[i],b1=_c.bHi[i];
        let s=0;
        for(let b=b0;b<b1;b++)s+=fd[b];
        const dB=-100+(s/(b1-b0))*inv*70;
        u=clamp((dB+DB_LO)/DB_WIN,0,1)*GAIN_REF;
        if(u>1)u=1;
      }
      const k=(u>val[i])?ka:kr;
      val[i]+=(u-val[i])*k;
    }

    /* ---- 呼吸 + 脉冲（一阶指数衰减，无过冲） ---- */
    const env=beat?clamp(Number(beat.env)||0,0,1):0;
    _c.envS+=(env-_c.envS)*(1-Math.exp(-dt/ENV_TAU));
    _c.punch*=Math.exp(-dt/PUNCH_TAU);
    if(beat&&beat.onset)_c.punch=Math.min(1,_c.punch+.35+.65*clamp(Number(beat.strength)||0,0,1));
    const pulse=1+BREATH*_c.envS+PUNCH*_c.punch;
    if(v.rotate)_c.rot+=dt*ROT_SPEED;
    const cosR=Math.cos(_c.rot),sinR=Math.sin(_c.rot);

    /* ---- 镜像：左右对称（第 i 扇与第 N-i 扇取同值） ---- */
    const out=_c.out;
    const mir=!!v.mirror;
    for(let i=0;i<N;i++)out[i]=mir?Math.max(val[i],val[(N-i)%N]):val[i];

    /* ---- 绘制 ---- */
    ctx.clearRect(0,0,w,h);
    const g=ensureRing(view,innerR);
    ctx.drawImage(g,0,0,g.width,g.height,0,0,w,h);

    const R0=Math.min(w,h)*.46;
    const ri=R0*innerR*pulse;
    const barMax=R0*(1-innerR)*.95*pulse;

    if(v.glow){
      ctx.save();
      ctx.globalAlpha=.16;
      ctx.fillStyle=_c.acc;
      ctx.beginPath();
      for(let i=0;i<N;i++)quad(ctx,cx,cy,cosR,sinR,i,Math.max(0,ri-GLOW_PX*.5),ri+barMax*out[i]+GLOW_PX);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    for(let i=0;i<N;i++){
      const ro=ri+barMax*out[i];
      if(ro<=ri+.2)continue;                     // 静音扇形不画（省掉一堆退化的极小填充）
      ctx.fillStyle=_c.barCol[i];
      ctx.beginPath();
      quad(ctx,cx,cy,cosR,sinR,i,ri,ro);
      ctx.fill();
    }
    ctx.restore();

    /* ---- 中心能量读数（文本取自预生成表，不拼字符串） ---- */
    let sum=0;
    for(let i=0;i<N;i++)sum+=val[i];
    const pct=clamp(Math.round(sum/N*100),0,100);
    ctx.save();
    ctx.globalAlpha=.75;
    ctx.fillStyle=_c.txt;
    ctx.font='600 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.fillText(E_TEXT[pct],cx,cy);
    ctx.restore();
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(radial);
