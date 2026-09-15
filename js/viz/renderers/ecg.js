/* [viz/renderers/ecg.js] 心电图（FEAT-V2 / T3）。
   形态：一条自右向左流动的心电轨迹——固定光标在右缘、最新样本贴着右缘出现，历史向左流出；
   静音时轨迹冻结（与瀑布图的"数字静音不落列"同规则），暂停后能看清最后一次跳动。
   数据源：audio.beat（features.js 的低频包络 env + 起音 onset/strength + 心率 bpm），不读频谱。
   实现要点：
   - 固定采样率 RATE = 200 点/秒，用 dt 累加器驱动（与 FPS 解耦）：一帧该出几点就出几点，
     帧内的包络在"上一帧值 → 这一帧值"之间线性插值，因此采样序列不随帧率抖动。
   - 环缓冲 Float32Array(MAX_CAP=200×8) 一次性按上限分配；时间窗只是"活跃长度"cap = 200×时间窗，
     改时间窗只改 cap + 清零，不重新分配（参数变化也不产生分配）。
   - 脉冲合成：起音触发时把 QRS-T 模板（32 点：Q 8 点 / R 4 点 / S 8 点 / T 12 点）叠加到轨迹上，
     模板在模块加载时线性重采样到 0.25 秒（50 点 @200 点/秒），所以逐点查表即可，脉冲沿屏向右推进 0.25 秒。
   - 基线 = 包络的慢分量（起音后缓慢回落，衰减时间由 decay 控制）+ 细颤（确定性伪随机，幅度随包络起伏）。
   - 每帧零分配：无新建数组/对象、无字符串拼接（心率文本取自模块加载时建好的 40-220 查表表），
     画布属性都赋字符串字面量，颜色在 init/resize 读一次主题变量。
   契约与参数：params 是纯声明对象（键名即参数名），当前值放 values（缺省回落 def）——
   参数面板按 for...in 遍历 params 并以键名读写 values，所以这里必须是对象而不是数组。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const RATE=200;                     // 采样率（点/秒）
const MAX_WIN=8;                    // 时间窗上限（秒）
const MAX_CAP=RATE*MAX_WIN;         // 环缓冲容量（1600 点，一次分配）
const BATCH_MAX=RATE*.25;           // 单帧最多补几个采样点（= dt 上限 0.25s × 采样率）
const PULSE_SEC=.25;                // 脉冲视觉时长（秒）
const PULSE_N=Math.round(PULSE_SEC*RATE);   // 50 点
const AMP_BASE=.26;                 // 满量程对应的半高（× 画布高 × 灵敏度）
const LIM=1.6;                      // 画值上限（防用户把灵敏度拧到 3 时画到离谱的坐标）
/* 细颤（T3 优化）：白噪声过一阶低通 → 约 2.5Hz 的基线摆动。
   原来是逐采样点的白噪声（相邻点完全无关）：描边路径被拉长到 18.6k 逻辑px、每个像素列被
   反复覆盖，8 秒窗实测掉到 13FPS，观感也是"毛边"。改成相关噪声后相邻点连续，路径短、像心电图。 */
const NOISE_FC=2.5;                 // 摆动截止频率（Hz）
const NOISE_K=Math.min(1,2*Math.PI*NOISE_FC/RATE);        // 每采样点的一阶系数
const NOISE_NRM=Math.sqrt((2-NOISE_K)/NOISE_K);           // 幅度补偿（低通会压小方差，补回原量级）
const TREMOR_A=.05, TREMOR_B=.12;   // 细颤幅度 = TREMOR_A + TREMOR_B × 包络（0.05–0.17 满量程）
const MAX_DPR=3;                    // 与 main.js 的 clamp(dpr,1,3) 对齐（网格缓存按设备像素建）
const FALLBACK_ACC='#00d9ff';
const FALLBACK_TXT='#e9eefb';

/* QRS-T 模板（32 点）：Q 波 8 点 → R 波 4 点 → S 波 8 点 → T 波 12 点 */
const TEMPLATE=new Float32Array([
  0,-.06,-.12,-.18,-.20,-.16,-.10,-.04,      // Q：小负偏
  .30,.95,1.00,.35,                          // R：快速上升—峰值—下降
  -.30,-.42,-.35,-.22,-.12,-.06,-.02,0,      // S：小负偏回收
  .08,.16,.24,.30,.33,.32,.28,.22,.15,.09,.04,0   // T：缓慢正偏
]);
/* 模板 → 0.25 秒（50 点）的线性重采样，模块加载时算一次 */
const PULSE=new Float32Array(PULSE_N);
{
  const m=TEMPLATE.length;
  for(let i=0;i<PULSE_N;i++){
    const t=(PULSE_N>1)?(i/(PULSE_N-1)*(m-1)):0;
    const i0=Math.floor(t), i1=Math.min(m-1,i0+1), f=t-i0;
    PULSE[i]=TEMPLATE[i0]+(TEMPLATE[i1]-TEMPLATE[i0])*f;
  }
}
/* 心率文本查表：40-220，避免每帧拼字符串 */
const BPM_TEXT=[];
for(let b=40;b<=220;b++)BPM_TEXT[b]=b+' BPM';
const BPM_NONE='-- BPM';

/* 模块内状态（全部在 init/参数变化时重建，draw 内不分配） */
const _c={
  ring:null,cap:0,write:0,acc:0,sampleNo:0,
  prevEnv:0,slow:0,breath:0,                 // 包络插值起点 / 细颤幅度分量 / 基线回落分量
  noise:0,                                  // 相关噪声（细颤）的一阶滤波状态
  pulseAge:PULSE_N,pulseAmp:0,              // 脉冲进度与幅度
  grid:null,gw:0,gh:0,gwin:0,               // 网格离屏缓存（尺寸/时间窗变化时重建）
  acc0:FALLBACK_ACC,txt:FALLBACK_TXT
};

function readCss(name,fb){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue(name);
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return fb;
}
/* 环缓冲：按上限分配一次；cap 变化（改时间窗）只改活跃长度并清零，不重新分配 */
function ensureRing(cap){
  if(!_c.ring)_c.ring=new Float32Array(MAX_CAP);
  if(cap!==_c.cap){
    _c.cap=cap;
    _c.ring.fill(0);
    _c.write=0; _c.acc=0; _c.sampleNo=0;
    _c.prevEnv=0; _c.slow=0; _c.breath=0; _c.pulseAge=PULSE_N; _c.pulseAmp=0;
  }
}
/* 确定性细颤白噪声源（无分配、可复现）：把 sin 哈希映射到 -1..1。经 NOISE_K 低通后成为相关噪声 */
function tremor(k){
  const x=Math.sin(k*12.9898)*43758.5453;
  return (x-Math.floor(x))*2-1;
}
/* 写入 n 个采样点：帧内包络线性插值 + 细颤 + 正在进行的脉冲。
   两条一阶滤波各管一件事：
   - slow（固定 0.05 秒）：跟住包络，决定细颤幅度 —— 音乐响则颤得大；
   - breath（时间常数 = decay × 0.25 秒）：决定基线的上下起伏，也就是"响过之后多久落回基线"，
     这正是"衰减时间"参数的可感知含义（decay 越大，回落越慢、轨迹越"余韵悠长"）。 */
function pushSamples(n,env,decay){
  const ring=_c.ring,cap=_c.cap;
  const ks=clamp(1/(RATE*.05),0,1);
  const kb=clamp(1/(RATE*decay*.25),0,1);
  const from=_c.prevEnv,d=env-from;
  for(let i=1;i<=n;i++){
    const e=from+d*(i/n);
    _c.slow+=(e-_c.slow)*ks;
    _c.breath+=(e-_c.breath)*kb;
    _c.sampleNo++;
    /* 细颤 = 白噪声过一阶低通（相关噪声），再夹到 ±1 保持与原设计相同的幅度包络 */
    _c.noise+=(tremor(_c.sampleNo)-_c.noise)*NOISE_K;
    let nz=_c.noise*NOISE_NRM;
    if(nz>1)nz=1; else if(nz<-1)nz=-1;
    let v=(_c.breath-.35)*.45+nz*(TREMOR_A+TREMOR_B*_c.slow);
    if(_c.pulseAge<PULSE_N){                     // 脉冲：模板值 × 幅度 × 余韵衰减
      v+=PULSE[_c.pulseAge]*_c.pulseAmp*Math.exp(-_c.pulseAge/(RATE*decay*.4));
      _c.pulseAge++;
    }
    ring[_c.write]=v;
    _c.write=(_c.write+1)%cap;
  }
  _c.prevEnv=env;
}
/* 心电图纸网格：横 8 格 + 每 0.2 秒一条竖线 + 中线略亮。
   画到**离屏 canvas**（按设备像素尺寸）缓存，draw 里只做一次 drawImage —— 原来每帧重画 47 条线
   （8 秒窗约 38k 逻辑px 的抗锯齿描边，比轨迹本身还长），这是掉帧的大头之一。 */
function ensureGrid(view,win){
  const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
  const w=Math.max(1,Math.round((view.w||1)*dpr));
  const h=Math.max(1,Math.round((view.h||1)*dpr));
  if(_c.grid&&_c.gw===w&&_c.gh===h&&_c.gwin===win)return _c.grid;
  const cv=document.createElement('canvas');
  cv.width=w; cv.height=h;
  const cx=cv.getContext('2d');
  const mid=h/2;
  cx.strokeStyle=_c.txt;
  cx.lineWidth=dpr;
  cx.globalAlpha=.10;
  cx.beginPath();
  for(let i=1;i<8;i++){
    const y=Math.round(h*i/8)+.5;
    cx.moveTo(0,y); cx.lineTo(w,y);
  }
  const nv=Math.max(1,Math.round(win/.2));       // 每 0.2 秒一格
  for(let i=1;i<nv;i++){
    const x=Math.round(w*i/nv)+.5;
    cx.moveTo(x,0); cx.lineTo(x,h);
  }
  cx.stroke();
  cx.globalAlpha=.18;
  cx.beginPath();
  cx.moveTo(0,Math.round(mid)+.5); cx.lineTo(w,Math.round(mid)+.5);
  cx.stroke();
  _c.grid=cv; _c.gw=w; _c.gh=h; _c.gwin=win;
  return cv;
}

export const ecg={
  id:'ecg',
  label:'心电图',
  params:{
    gain:      {type:'range',min:.5,max:3,step:.1,def:1.5,label:'灵敏度',fixed:1},
    decay:     {type:'range',min:.5,max:3,step:.1,def:1.5,label:'衰减时间',fixed:1},
    timeWindow:{type:'range',min:2,max:8,step:.5,def:4,label:'时间窗',fixed:1},
    showGrid:  {type:'toggle',def:true,label:'网格'},
    showBpm:   {type:'toggle',def:true,label:'心率显示'}
  },
  values:{ gain:1.5, decay:1.5, timeWindow:4, showGrid:true, showBpm:true },

  init(ctx,view){
    _c.acc0=readCss('--acc',FALLBACK_ACC);
    _c.txt=readCss('--txt',FALLBACK_TXT);
    _c.grid=null;                                // 主题色可能变了 → 网格缓存失效
    ensureRing(Math.round(clamp(Number(this.values.timeWindow)||4,2,MAX_WIN)*RATE));
  },
  /* resize：环缓冲是时间维的（与像素无关），只需重读主题色 + 让网格缓存失效；像素映射每帧按 view 现算 */
  resize(ctx,view){
    _c.acc0=readCss('--acc',FALLBACK_ACC);
    _c.txt=readCss('--txt',FALLBACK_TXT);
    _c.grid=null;
  },
  dispose(){
    _c.ring=null; _c.cap=0; _c.write=0; _c.acc=0; _c.sampleNo=0;
    _c.prevEnv=0; _c.slow=0; _c.breath=0; _c.noise=0; _c.pulseAge=PULSE_N; _c.pulseAmp=0;
    _c.grid=null; _c.gw=0; _c.gh=0; _c.gwin=0;
  },

  draw(ctx,view,audio){
    const w=view.w,h=view.h,mid=h/2;
    const v=this.values;
    const win=clamp(Number(v.timeWindow)||4,2,MAX_WIN);
    const gain=Number(v.gain)||1.5;
    const decay=clamp(Number(v.decay)||1.5,.5,3);
    ensureRing(Math.round(win*RATE));            // 自愈：dispose 后或时间窗变化时

    const beat=(audio&&audio.beat)?audio.beat:null;
    const dt=clamp(Number(audio&&audio.dt)||0,0,.25);
    /* 采样：仅在低频段有信号（或正好起音）时推进——数字静音不落点，暂停后画面冻结 */
    if(beat&&dt>0&&(beat.env>0||beat.onset)){
      if(beat.onset){
        _c.pulseAge=0;
        _c.pulseAmp=clamp(.55+.45*Number(beat.strength||0),.3,1.2);
      }
      _c.acc+=dt;
      const step=1/RATE;
      let n=0;
      while(_c.acc>=step&&n<BATCH_MAX){ _c.acc-=step; n++ }
      if(_c.acc>step*BATCH_MAX)_c.acc=step*BATCH_MAX;
      if(n)pushSamples(n,clamp(Number(beat.env)||0,0,1),decay);
    }

    ctx.clearRect(0,0,w,h);                      // 无数据时只剩网格/空白

    if(v.showGrid){
      const g=ensureGrid(view,win);
      ctx.drawImage(g,0,0,g.width,g.height,0,0,w,h);   // 缓存网格一次贴图（设备像素 1:1）
    }

    const cap=_c.cap,ring=_c.ring,wr=_c.write;
    if(ring&&cap>1&&_c.sampleNo>0){
      const amp=h*AMP_BASE*gain;
      ctx.save();
      ctx.strokeStyle=_c.acc0;
      ctx.lineWidth=1.6;
      ctx.lineJoin='round';
      ctx.lineCap='round';
      ctx.beginPath();
      for(let a=cap-1;a>=0;a--){                 // a = 距最新样本的点数：最旧在左、最新在右
        const idx=(wr-1-a+cap*2)%cap;
        const x=w*(1-a/(cap-1));
        const y=mid-clamp(ring[idx],-LIM,LIM)*amp;
        if(a===cap-1)ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
      /* 固定光标：右缘光点 = 半透明外圈 + 实心亮核（两层圆，不用 shadowBlur——
         每帧一个模糊图层比两个圆贵得多，是掉帧的另一处来源）+ 一条淡扫描线 */
      const yLast=mid-clamp(ring[(wr-1+cap)%cap],-LIM,LIM)*amp;
      ctx.globalAlpha=.18;
      ctx.beginPath(); ctx.moveTo(w-.5,0); ctx.lineTo(w-.5,h); ctx.stroke();
      ctx.globalAlpha=.28;
      ctx.fillStyle=_c.acc0;
      ctx.beginPath(); ctx.arc(w-2,yLast,7,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=1;
      ctx.beginPath(); ctx.arc(w-2,yLast,3,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }

    if(v.showBpm){
      const bpm=beat?Math.round(Number(beat.bpm)||0):0;
      const s=(bpm>=40&&bpm<=220)?BPM_TEXT[bpm]:BPM_NONE;
      ctx.save();
      ctx.globalAlpha=.85;
      ctx.fillStyle=_c.txt;
      ctx.font='12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
      ctx.textAlign='right';
      ctx.textBaseline='top';
      ctx.fillText(s,w-8,8);
      ctx.restore();
    }
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(ecg);
