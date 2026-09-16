/* [viz/renderers/bounce.js] 跳动波形（FEAT-V3 / 渲染器 3）。
   形态：波形基线不是固定中线——被鼓点"弹起"后缓慢落回，像一根被拨动的橡皮筋；
   弹跳瞬间整条线变亮，可选上下镜像。
   数据源：audio.timeDomain（波形）+ audio.beat（onset/strength 触发弹跳、env 提供持续起伏）。
   实现要点：
   1) 弹跳用**两级一阶低通**，不用真弹簧：kick 由 onset 加量、按 exp(-dt/τ) 指数回落（无过冲、不震荡），
      显示基线 _c.off 再以 35ms 一阶低通跟随目标（避免落点突变）。
      τ = REST_TAU/bounciness → bounciness 越大，回落越慢、弹得越久（这就是"弹跳力"的可感含义）。
   2) 描边步长自适应：单帧采样点最多 1.5 个/逻辑像素（timeDomain 有 2048 点，窄画布下原本是
      2–3 倍过绘）。发光层再取 2 倍步长，路径长度约为原来的 1/4，是 FPS 的主要保障。
   3) 静态背景（4 条等分参考线）画到**离屏 canvas** 缓存，draw 里只一次 drawImage。
   4) 刷新率：波形随节拍变亮用 globalAlpha 表达（无字符串拼接）；渐变在 init/resize 建一次。
   5) 每帧零分配：无 new、无字符串拼接、无临时数组；采样循环内不做三角函数。
   契约与参数：params 是**纯声明对象**（键名即参数名），当前值在 values（缺省回落 def）。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const BASE_AMP=.30;                // 波形半幅系数：半幅 = 画布高 × BASE_AMP × amplitude（def 1.5 → 45%）
const BOUNCE_MAX=.22;              // 基线最大抬升（占画布高，再乘 bounciness 归一系数）
const REST_TAU=.42;                // 回落到基线的时间常数基准（秒）
const FOLLOW_TAU=.035;             // 基线跟随的一阶低通时间常数（秒）
const ENV_TAU=.10;                 // 包络平滑时间常数（秒）
const LINE_W=2.6;                  // 主线宽（2–3px）
const GLOW_W=9;                    // 发光层线宽
const MAX_DPR=3;
const FALLBACK={acc:'#00d9ff',acc2:'#7c6cff',txt:'#e9eefb'};

/* ---------- 模块状态（预分配；draw 内不分配） ---------- */
const _c={
  off:0,kick:0,envS:0,             // 当前基线偏移(px) / 弹跳量 / 包络平滑值
  grid:null,gw:0,gh:0,             // 参考线离屏缓存
  grad:null,                       // 波形渐变（init/resize 建一次）
  acc:'',acc2:'',txt:''
};

function readCss(name,fb){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue(name);
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return fb;
}
function buildGradient(ctx,view){
  try{
    const g=ctx.createLinearGradient(0,0,Math.max(1,view.w),0);
    g.addColorStop(0,_c.acc2);
    g.addColorStop(.5,_c.acc);
    g.addColorStop(1,_c.acc2);
    _c.grad=g;
  }catch(e){ _c.grad=null }
}
/* 静态参考线（1/4、1/2、3/4 三条 + 上下边缘微光）缓存到离屏 canvas（设备像素） */
function ensureGrid(view){
  const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
  const w=Math.max(1,Math.round((view.w||1)*dpr));
  const h=Math.max(1,Math.round((view.h||1)*dpr));
  if(_c.grid&&_c.gw===w&&_c.gh===h)return _c.grid;
  const cv=document.createElement('canvas');
  cv.width=w; cv.height=h;
  const cx=cv.getContext('2d');
  cx.strokeStyle=_c.txt;
  cx.lineWidth=dpr;
  cx.globalAlpha=.09;
  cx.beginPath();
  for(let k=1;k<4;k++){
    const y=Math.round(h*k/4)+.5;
    cx.moveTo(0,y); cx.lineTo(w,y);
  }
  cx.stroke();
  cx.globalAlpha=.16;                      // 中线（静止基线）比等分线亮一档
  cx.beginPath();
  cx.moveTo(0,Math.round(h/2)+.5); cx.lineTo(w,Math.round(h/2)+.5);
  cx.stroke();
  _c.grid=cv; _c.gw=w; _c.gh=h;
  return cv;
}
function clampUnit(v){ return v>1?1:(v<-1?-1:v) }
/* 追加一条波形折线到当前路径：sign=+1 向上、-1 向下（镜像），步长 stride 控制路径长度 */
function wavePath(ctx,td,n,stride,w,baseY,amp,sign){
  ctx.beginPath();
  let first=true;
  for(let i=0;i<n;i+=stride){
    const x=(i/(n-1))*w;
    const y=baseY-sign*clampUnit((td[i]-128)/128)*amp;
    if(first){ ctx.moveTo(x,y); first=false } else ctx.lineTo(x,y);
  }
  const last=n-1;
  if(last%stride){                          // 补右缘最后一点，避免尾巴缺一小段
    const x=w;
    const y=baseY-sign*clampUnit((td[last]-128)/128)*amp;
    ctx.lineTo(x,y);
  }
}

export const bounce={
  id:'bounce',
  label:'跳动波形',
  params:{
    amplitude: {type:'range',min:.5,max:3,step:.1,def:1.5,label:'幅度',fixed:1},
    bounciness:{type:'range',min:.5,max:3,step:.1,def:1.5,label:'弹跳力',fixed:1},
    mirror:    {type:'toggle',def:false,label:'镜像'},
    glow:      {type:'toggle',def:true,label:'发光'}
  },
  values:{ amplitude:1.5, bounciness:1.5, mirror:false, glow:true },

  init(ctx,view){
    _c.acc=readCss('--acc',FALLBACK.acc);
    _c.acc2=readCss('--acc2',FALLBACK.acc2);
    _c.txt=readCss('--txt',FALLBACK.txt);
    _c.grid=null; _c.gw=0; _c.gh=0;
    _c.off=0; _c.kick=0; _c.envS=0;
    buildGradient(ctx,view);
  },
  resize(ctx,view){
    _c.acc=readCss('--acc',FALLBACK.acc);
    _c.acc2=readCss('--acc2',FALLBACK.acc2);
    _c.txt=readCss('--txt',FALLBACK.txt);
    _c.grid=null; _c.gw=0; _c.gh=0;
    buildGradient(ctx,view);
  },
  dispose(){
    _c.grid=null; _c.gw=0; _c.gh=0; _c.grad=null;
    _c.off=0; _c.kick=0; _c.envS=0;
  },

  draw(ctx,view,audio){
    const w=view.w,h=view.h,mid=h/2;
    const v=this.values;
    const td=(audio&&audio.timeDomain)?audio.timeDomain:null;
    const beat=(audio&&audio.beat)?audio.beat:null;
    const dt=clamp(Number(audio&&audio.dt)||1/60,0,.25);
    const ampP=clamp(Number(v.amplitude)||1.5,.5,3);
    const bouncy=clamp(Number(v.bounciness)||1.5,.5,3);

    /* ---- 弹跳：一阶衰减（回落）+ 一阶低通（跟随），两级都不含惯性项，不会震荡过头 ---- */
    if(beat&&beat.onset)_c.kick=Math.min(1.4,_c.kick+.5+.9*clamp(Number(beat.strength)||0,0,1));
    _c.kick*=Math.exp(-dt/(REST_TAU/Math.max(.4,bouncy)));
    const env=beat?clamp(Number(beat.env)||0,0,1):0;
    _c.envS+=(env-_c.envS)*(1-Math.exp(-dt/ENV_TAU));
    const power=bouncy/1.5;                                   // 1.0 = def
    const lift=(clamp(_c.kick,0,1.2)*.75+.25*_c.envS)*power;
    const target=-h*BOUNCE_MAX*clamp(lift,0,1.6);
    _c.off+=(target-_c.off)*(1-Math.exp(-dt/FOLLOW_TAU));
    const baseY=mid+_c.off;
    const bright=clamp(_c.kick,0,1);                          // 弹得越高越亮

    /* ---- 绘制 ---- */
    ctx.clearRect(0,0,w,h);
    const g=ensureGrid(view);
    ctx.drawImage(g,0,0,g.width,g.height,0,0,w,h);

    /* 静止基线 + 当前（弹跳中的）基线：一眼看出"基线在上下弹" */
    ctx.save();
    ctx.lineWidth=1;
    ctx.strokeStyle=_c.txt;
    ctx.globalAlpha=.16;
    ctx.beginPath(); ctx.moveTo(0,baseY); ctx.lineTo(w,baseY); ctx.stroke();
    ctx.restore();

    if(!td||!td.length)return;                                // 无音频数据时只留参考线

    const n=td.length;
    const amp=h*BASE_AMP*ampP;
    const stride=clamp(Math.floor(n/Math.max(1,w*1.5)),1,8);    // 每逻辑像素最多 ~1.5 个采样点
    const gs=Math.min(16,stride*2);                            // 发光层步长再翻倍
    const mir=!!v.mirror;

    ctx.save();
    ctx.lineJoin='round';
    ctx.lineCap='round';
    ctx.strokeStyle=_c.grad||_c.acc;
    if(v.glow){
      ctx.globalAlpha=.10+.16*bright;
      ctx.lineWidth=GLOW_W;
      /* wavePath 内含 beginPath，所以上下两条要各自描边（否则后一条会把前一条顶掉） */
      wavePath(ctx,td,n,gs,w,baseY,amp,1);
      ctx.stroke();
      if(mir){ wavePath(ctx,td,n,gs,w,baseY,amp,-1); ctx.stroke() }
    }
    ctx.globalAlpha=.72+.28*bright;
    ctx.lineWidth=LINE_W;
    wavePath(ctx,td,n,stride,w,baseY,amp,1);
    ctx.stroke();
    if(mir){                                                  // 镜像：绕基线对称的下半条
      wavePath(ctx,td,n,stride,w,baseY,amp,-1);
      ctx.stroke();
    }
    ctx.restore();
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(bounce);
