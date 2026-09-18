/* [viz/renderers/waveform.js] 实时波形渲染器（VISUALIZER-V1 子任务 6）。
   契约 {id,label,params,init,draw,resize,dispose}：
   - draw(ctx, view, audio)：audio.timeDomain 为共享的 Uint8Array（长度 = analyser.fftSize = 2048），
     由 main.js 的 rAF 主循环每帧填充一次并复用同一实例（本模块不做任何分配）。
   - 中心对称绘制：128 为静音基线，两侧按 gain 灵敏度映射到画布高度。
   - 颜色从 theme.css 的 --acc 读取（6 套配色自动跟随）。
   依赖：只 import ../registry.js 的 register（自注册），不依赖入口模块，无循环导入。 */
import { register } from '../registry.js';

const FALLBACK_ACC='#00d9ff';
const _c={acc:FALLBACK_ACC,grad:null};        // 仅缓存主题色/渐变（参数值一律读 this.values，与参数面板同源）

/* 从主题变量取主色（每帧不调用，只在 init/resize 时刷新） */
function readAccent(){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue('--acc');
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return FALLBACK_ACC;
}
function buildGradient(ctx,view){
  try{
    const g=ctx.createLinearGradient(0,0,view.w,0);
    g.addColorStop(0,_c.acc);
    g.addColorStop(.5,'rgba(255,255,255,.92)');
    g.addColorStop(1,_c.acc);
    _c.grad=g;
  }catch(e){ _c.grad=null }
}

export const waveform={
  id:'waveform',
  label:'实时波形',
  /* params = 纯声明（供参数面板生成控件）；当前值放 values，避免把描述对象当数值用。
     本渲染器只有 3 个参数，全部标 isPrimary（面板上不会出现「更多参数」按钮） */
  params:{
    gain:{type:'range',min:.5,max:3,step:.05,def:1,label:'灵敏度',fixed:2,isPrimary:true},
    grid:{type:'toggle',def:true,label:'中线',isPrimary:true},
    width:{type:'range',min:1,max:5,step:.5,def:2,label:'线宽',fixed:1,isPrimary:true}
  },
  values:{ gain:1, grid:true, width:2 },
  init(ctx,view){
    _c.acc=readAccent();
    buildGradient(ctx,view);
  },
  resize(ctx,view){
    _c.acc=readAccent();
    buildGradient(ctx,view);
  },
  dispose(){ _c.grad=null; },
  draw(ctx,view,audio){
    const w=view.w,h=view.h;
    ctx.clearRect(0,0,w,h);
    const mid=h/2;

    if(this.values.grid){
      ctx.save();
      ctx.strokeStyle='rgba(255,255,255,.10)';
      ctx.lineWidth=1;
      ctx.beginPath();
      ctx.moveTo(0,Math.round(mid)+.5);
      ctx.lineTo(w,Math.round(mid)+.5);
      ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,.05)';
      ctx.beginPath();
      ctx.moveTo(0,Math.round(mid-h*.25)+.5); ctx.lineTo(w,Math.round(mid-h*.25)+.5);
      ctx.moveTo(0,Math.round(mid+h*.25)+.5); ctx.lineTo(w,Math.round(mid+h*.25)+.5);
      ctx.stroke();
      ctx.restore();
    }

    const td=audio&&audio.timeDomain?audio.timeDomain:null;
    if(!td||!td.length)return;                       // 无数据（尚未创建 AudioContext）时只留基线
    const n=td.length;
    const amp=h*.46*Number(this.values.gain||1);     // 灵敏度：0.5–3.0

    ctx.save();
    ctx.lineWidth=Number(this.values.width||2);
    ctx.lineJoin='round';
    ctx.lineCap='round';
    ctx.strokeStyle=_c.grad||_c.acc;
    ctx.beginPath();
    for(let i=0;i<n;i++){
      const x=(i/(n-1))*w;
      const v=(td[i]-128)/128;                       // -1..1（128 = 静音）
      const y=mid-clampUnit(v)*amp;
      if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.restore();
  }
};
function clampUnit(v){ return v>1?1:(v<-1?-1:v) }

/* 自注册：main.js 末尾 import 本文件即完成注册 */
register(waveform);
