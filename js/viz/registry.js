/* [viz/registry.js] 渲染器注册表（VISUALIZER-V1 子任务 6）。
   独立成模块的原因：渲染器要自注册，若放在入口 main.js 里会形成
   main.js ⇄ renderers/*.js 的循环导入，且 renderers 数组在模块求值期尚未初始化（TDZ）。
   这里只做注册与切换，不碰 DOM：参数面板/重绘由 ui 钩子注入，保持无 DOM 依赖。

   契约：{id, label, params, init(ctx,view), draw(ctx,view,audio), resize(ctx,view), dispose(ctx,view)}
   - params：{name:{type:'range'|'toggle', min, max, step, def, label, fixed}}，供底部参数面板动态生成；
     渲染器把当前值存在自身 params[name] 上（就地写回）。
   - draw 的第三参 audio = {timeDomain: Uint8Array(fftSize)}，由入口的 rAF 主循环每帧填充一次并复用。 */

const renderers=[];
let cur=null,_ctx=null,_view=null;
const hooks={renderParams:null};        // 由入口注入：{renderParams}

export function setUI(h){
  if(!h)return;
  if(typeof h.renderParams==='function')hooks.renderParams=h.renderParams;
}
export function setSurface(ctx,view){ _ctx=ctx; _view=view }
export function register(r){
  if(r&&r.id&&!renderers.some(x=>x.id===r.id))renderers.push(r);
  return r;
}
export function list(){ return renderers.slice(); }
export function current(){ return cur; }
/** 切换渲染器：只换指针，不销毁画布、不重建音频（保数据连续性） */
export function select(id){
  const next=renderers.find(r=>r.id===id)||null;
  if(cur===next)return cur;
  if(cur){ try{ cur.dispose&&cur.dispose(_ctx,_view) }catch(e){} }
  cur=next;
  if(cur&&cur.init){ try{ cur.init(_ctx,_view) }catch(e){} }
  try{ hooks.renderParams&&hooks.renderParams() }catch(e){}
  return cur;
}
/** 表面尺寸变化时转达给当前渲染器 */
export function resize(ctx,view){
  _ctx=ctx; _view=view;
  if(cur&&cur.resize){ try{ cur.resize(ctx,view) }catch(e){} }
}
