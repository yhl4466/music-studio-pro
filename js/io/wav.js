/* [wav.js] source: Pro.html 4832-4836（WAV 导出重入锁入口；渲染实现在 ../audio/render.js） */
import { exportWavRender } from '../audio/render.js';
import { toast } from '../core/util.js';

/* 导出重入锁（原 window.__exporting → 模块内私有变量） */
let exporting=false;
export async function exportWavUI(){ // 导出锁：同一时刻只允许一次导出（重入直接提示并返回）
  if(exporting)return toast('正在导出中，请稍候…');
  exporting=true;
  try{await exportWavRender()}finally{exporting=false}
}
