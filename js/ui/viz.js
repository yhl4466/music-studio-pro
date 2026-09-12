/* [viz.js] source: Pro.html 3770-3791（顶栏频谱可视化 rAF 循环） */
import { actx, A } from '../core/state.js';
import { UI } from '../core/util.js';

/* ---------- 频谱可视化 ---------- */
export function vizLoop(){
  requestAnimationFrame(vizLoop);
  const cv=UI.viz;if(!cv)return;
  const g=cv.getContext('2d');const W=cv.width,H=cv.height;
  g.clearRect(0,0,W,H);
  if(actx&&A&&A.an){
    const arr=new Uint8Array(A.an.frequencyBinCount);
    A.an.getByteFrequencyData(arr);
    const n=40,step=Math.floor(arr.length*.7/n);
    for(let i=0;i<n;i++){
      let v=0;for(let j=0;j<step;j++)v+=arr[i*step+j];v/=step;
      const h=Math.max(1,v/255*H);
      const hue=(i/n)*130+190;
      g.fillStyle='hsl('+hue+',95%,'+(50+Math.random()*12)+'%)';
      g.fillRect(i*(W/n),H-h,Math.max(1,W/n-2),h);
    }
  }else{
    g.fillStyle='rgba(90,150,255,.25)';
    for(let i=0;i<40;i++){const h=2+Math.sin(i*.7+Date.now()/400)*1.5;g.fillRect(i*(W/40),H-h,3,h)}
  }
}
