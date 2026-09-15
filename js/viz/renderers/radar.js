/* [viz/renderers/radar.js] 七轴雷达图（FEAT-V2 / T4）。
   七轴：低频 / 中频 / 高频 / 亮度（频谱质心）/ 通量 / 波峰因数 / 脉冲密度。
   数据来源（两档时间尺度，各取所长）：
   - 三个频段 + 质心：每帧直接从 audio.freqData 现算 → 图形随音乐连续变化；
   - 通量 / 波峰因数 / 脉冲密度：取 audio.features（features.js 每 500ms 落一次快照），
     这三项本身就是 500ms 尺度的统计量。
   归一化（全部 clamp 到 0-1）：频段用 dB（-80…-20dB 线性映射到 0…1，与瀑布图的窗口同源），
   质心用 log2 映射（与 features.brightness 同式），通量/波峰/脉冲密度在 features 里已归一化。
   绘制要点：
   - 网格（4 层同心七边形 + 7 根轴 + 轴标签）画到**离屏 canvas** 缓存，draw 里只一次 drawImage；
     轴标签开关、尺寸、主题色变化时重建（学 T3.1 的做法，避免每帧几十条抗锯齿描边）。
   - 当前值：实线闭合七边形 + 半透明填充 + 7 个顶点；历史均值：虚线闭合七边形。
   - 平滑：快攻慢放一阶 EMA（攻击 100ms、释放 500ms），逐轴独立，避免指针抖。
   - 每帧零分配：EMA 缓冲 / 历史环 / 顶点角度全部预分配，setLineDash 复用常量数组，
     无字符串拼接（轴标签只在缓存网格里画一次）。
   契约与参数：params 是纯声明对象（键名即参数名），当前值放 values（缺省回落 def）。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const AXES=7;
const AXIS_LABEL=['低频','中频','高频','亮度','通量','波峰','脉冲'];
const RINGS=4;                       // 同心七边形层数
const HIST_N=10;                     // 历史环长度（10 × 500ms = 5 秒）
const ATK_TAU=.10;                   // 快攻时间常数（秒）
const REL_TAU=.50;                   // 慢放时间常数（秒）
const RMAX=.98;                      // 数值上限（留出外圈一点空隙，避免"顶格"）
const RFLOOR=.06;                    // 半径几何下限：某轴为 0 时顶点落在 6% 半径处而不是圆心
                                     // （纯外观下限，七轴映射仍单调，避免"塌陷成一点"看不出形状）
const AG_DECAY=.9995;                // 自动增益的滚动峰值衰减（每帧）
const AG_FLOOR=.20;                  // 自动增益的除数下限（防止静音时把噪声放大到满格）
const MAX_DPR=3;
const FALLBACK_ACC='#00d9ff';
const FALLBACK_ACC2='#7c6cff';
const FALLBACK_TXT='#e9eefb';
const DASH=[5,4];                    // 历史均值虚线（模块级常量，避免每帧新建数组）
const DASH_OFF=[];                   // 复位虚线用

/* ---------- 模块状态（预分配，draw 内不分配） ---------- */
const _c={
  ema:new Float32Array(AXES),        // 平滑后的当前值
  raw:new Float32Array(AXES),        // 本帧原始值
  hist:new Float32Array(AXES*HIST_N),// 历史快照环
  histN:0,histIdx:0,                 // 环内有效个数与写指针
  mean:new Float32Array(AXES),       // 历史均值
  agMax:new Float32Array(AXES),      // 自动增益的滚动峰值
  lastT:-1,                          // 上一次 features 快照时间戳（判断是否落环）
  grid:null,gw:0,gh:0,glabels:null,  // 网格离屏缓存（尺寸/标签开关变化时重建）
  acc0:FALLBACK_ACC,acc2:FALLBACK_ACC2,txt:FALLBACK_TXT
};
/* 顶点角度也预计算：第 i 轴指向 -90° 起、顺时针均分 */
const ANG=new Float32Array(AXES*2);
for(let i=0;i<AXES;i++){
  const a=-Math.PI/2+i*2*Math.PI/AXES;
  ANG[i*2]=Math.cos(a); ANG[i*2+1]=Math.sin(a);
}

function readCss(name,fb){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue(name);
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return fb;
}
/* 频段：bin 区间与 dB 归一化（byte→dB 与 analyser 默认 -100/-30dB 一致） */
function bandValue(fd,b0,b1){
  let s=0,n=0;
  for(let i=b0;i<b1&&i<fd.length;i++){ s+=fd[i]; n++ }
  if(!n)return 0;
  const dB=-100+(s/n)/255*70;                 // 平均 byte → dB
  return clamp((dB+80)/60,0,1);               // -80…-20dB → 0…1
}
/* 网格缓存：4 层同心七边形 + 7 根轴 +（可选）轴标签，按设备像素绘制 */
function ensureGrid(view,showLabels){
  const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
  const w=Math.max(1,Math.round((view.w||1)*dpr));
  const h=Math.max(1,Math.round((view.h||1)*dpr));
  if(_c.grid&&_c.gw===w&&_c.gh===h&&_c.glabels===showLabels)return _c.grid;
  const cv=document.createElement('canvas');
  cv.width=w; cv.height=h;
  const cx=cv.getContext('2d');
  const mx=w/2,my=h/2,R=Math.min(w,h)*.38;
  cx.strokeStyle=_c.txt;
  cx.lineWidth=dpr;
  cx.globalAlpha=.10;
  for(let k=1;k<=RINGS;k++){
    const rr=R*k/RINGS;
    cx.beginPath();
    for(let i=0;i<AXES;i++){
      const x=mx+ANG[i*2]*rr, y=my+ANG[i*2+1]*rr;
      if(i===0)cx.moveTo(x,y); else cx.lineTo(x,y);
    }
    cx.closePath(); cx.stroke();
  }
  cx.beginPath();
  for(let i=0;i<AXES;i++){ cx.moveTo(mx,my); cx.lineTo(mx+ANG[i*2]*R,my+ANG[i*2+1]*R) }
  cx.stroke();
  if(showLabels){
    cx.globalAlpha=.75;
    cx.fillStyle=_c.txt;
    cx.font=(11*dpr).toFixed(0)+'px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    cx.textAlign='center';
    cx.textBaseline='middle';
    for(let i=0;i<AXES;i++){
      const lx=mx+ANG[i*2]*(R+16*dpr), ly=my+ANG[i*2+1]*(R+16*dpr);
      cx.fillText(AXIS_LABEL[i],lx,ly);
    }
  }
  _c.grid=cv; _c.gw=w; _c.gh=h; _c.glabels=showLabels;
  return cv;
}
/* 历史均值：环缓冲求平均（HIST_N ≤ 10，成本可忽略，不分配） */
function updateMean(){
  if(!_c.histN)return;
  for(let a=0;a<AXES;a++){
    let s=0;
    for(let k=0;k<_c.histN;k++)s+=_c.hist[k*AXES+a];
    _c.mean[a]=s/_c.histN;
  }
}

export const radar={
  id:'radar',
  label:'雷达图',
  params:{
    gain:       {type:'range',min:.5,max:3,step:.1,def:1,label:'灵敏度',fixed:1},
    showHistory:{type:'toggle',def:true,label:'显示历史'},
    autoGain:   {type:'toggle',def:false,label:'自动增益'},
    showLabels: {type:'toggle',def:true,label:'轴标签'}
  },
  values:{ gain:1, showHistory:true, autoGain:false, showLabels:true },

  init(ctx,view){
    _c.acc0=readCss('--acc',FALLBACK_ACC);
    _c.acc2=readCss('--acc2',FALLBACK_ACC2);
    _c.txt=readCss('--txt',FALLBACK_TXT);
    _c.grid=null;
  },
  resize(ctx,view){
    _c.acc0=readCss('--acc',FALLBACK_ACC);
    _c.acc2=readCss('--acc2',FALLBACK_ACC2);
    _c.txt=readCss('--txt',FALLBACK_TXT);
    _c.grid=null;                                // 尺寸变了 → 网格缓存失效
  },
  dispose(){
    _c.grid=null; _c.gw=0; _c.gh=0; _c.glabels=null;
    _c.ema.fill(0); _c.raw.fill(0); _c.hist.fill(0); _c.mean.fill(0); _c.agMax.fill(0);
    _c.histN=0; _c.histIdx=0; _c.lastT=-1;
  },

  draw(ctx,view,audio){
    const w=view.w,h=view.h;
    const v=this.values;
    const fd=(audio&&audio.freqData)?audio.freqData:null;
    const snap=(audio&&audio.features)?audio.features:null;
    const dt=clamp(Number(audio&&audio.dt)||1/60,0,.25);

    /* 本帧原始七值：频段/质心现算，其余取 500ms 快照 */
    const r=_c.raw;
    if(fd&&fd.length){
      r[0]=bandValue(fd,1,21);                   // 低频 ≈ 21–450Hz
      r[1]=bandValue(fd,21,201);                 // 中频 ≈ 450Hz–4.3kHz
      r[2]=bandValue(fd,201,fd.length);          // 高频 ≈ 4.3k–22kHz
      let p=0,ww=0;
      for(let i=0;i<fd.length;i++){ const x=fd[i]; p+=x; ww+=i*x }
      const cen=p>0?(ww/p):0;
      r[3]=clamp(Math.log2(1+cen)/Math.log2(1025),0,1);   // 质心用 log 映射（与 features.brightness 同式）
    }
    if(snap){
      r[4]=clamp(Number(snap.flux)||0,0,1);
      r[5]=clamp(Number(snap.crest)||0,0,1);
      r[6]=clamp(Number(snap.pulseDensity)||0,0,1);
    }

    /* 自动增益：逐轴滚动峰值（慢衰减），开时以峰值为分母 */
    for(let i=0;i<AXES;i++){
      const m=_c.agMax[i]*AG_DECAY;
      _c.agMax[i]=r[i]>m?r[i]:m;
    }
    const ag=!!v.autoGain;
    const gain=Number(v.gain)||1;
    /* 快攻慢放 EMA（逐轴独立）：target 高于当前用攻击，低于当前用释放 */
    for(let i=0;i<AXES;i++){
      let t=r[i];
      if(ag)t=t/Math.max(AG_FLOOR,_c.agMax[i]);
      t=clamp(t*gain,0,1);
      const tau=(t>_c.ema[i])?ATK_TAU:REL_TAU;
      _c.ema[i]+=(t-_c.ema[i])*(1-Math.exp(-dt/tau));
    }

    /* 历史环：以 features 快照（t 变化）为节拍落一次，10 格 = 5 秒 */
    if(snap){
      const st=Number(snap.t)||0;
      if(st!==_c.lastT){
        _c.lastT=st;
        for(let i=0;i<AXES;i++)_c.hist[_c.histIdx*AXES+i]=_c.ema[i];
        _c.histIdx=(_c.histIdx+1)%HIST_N;
        if(_c.histN<HIST_N)_c.histN++;
        updateMean();
      }
    }

    /* ---- 绘制 ---- */
    ctx.clearRect(0,0,w,h);
    const g=ensureGrid(view,v.showLabels!==false);
    ctx.drawImage(g,0,0,g.width,g.height,0,0,w,h);      // 缓存网格一次贴图

    const mx=w/2,my=h/2,R=Math.min(w,h)*.38;
    const hist=!!v.showHistory;

    /* 历史均值：虚线（先画，压在实线下面） */
    if(hist&&_c.histN>1){
      ctx.save();
      ctx.strokeStyle=_c.acc2;
      ctx.globalAlpha=.85;
      ctx.lineWidth=1.4;
      ctx.setLineDash(DASH);
      ctx.beginPath();
      for(let i=0;i<AXES;i++){
        const rr=R*(RFLOOR+(1-RFLOOR)*clamp(_c.mean[i],0,RMAX));
        const x=mx+ANG[i*2]*rr, y=my+ANG[i*2+1]*rr;
        if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath(); ctx.stroke();
      ctx.setLineDash(DASH_OFF);
      ctx.restore();
    }

    /* 当前值：半透明填充 + 实线 + 顶点 */
    ctx.save();
    ctx.beginPath();
    for(let i=0;i<AXES;i++){
      const rr=R*(RFLOOR+(1-RFLOOR)*clamp(_c.ema[i],0,RMAX));
      const x=mx+ANG[i*2]*rr, y=my+ANG[i*2+1]*rr;
      if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.globalAlpha=.22;
    ctx.fillStyle=_c.acc0;
    ctx.fill();
    ctx.globalAlpha=1;
    ctx.strokeStyle=_c.acc0;
    ctx.lineWidth=1.8;
    ctx.lineJoin='round';
    ctx.stroke();
    ctx.fillStyle=_c.acc0;
    for(let i=0;i<AXES;i++){
      const rr=R*(RFLOOR+(1-RFLOOR)*clamp(_c.ema[i],0,RMAX));
      ctx.beginPath();
      ctx.arc(mx+ANG[i*2]*rr,my+ANG[i*2+1]*rr,2.6,0,Math.PI*2);
      ctx.fill();
    }
    ctx.restore();
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(radar);
