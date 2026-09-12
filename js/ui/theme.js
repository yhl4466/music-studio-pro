/* [theme.js] source: Pro.html 5004-5022（6 套配色切换：只改 documentElement.dataset.theme 与 localStorage） */
import { el } from '../core/util.js';

export function bindTheme(){
  const wrap=document.getElementById('themeWrap'),btn=document.getElementById('themeBtn');
  if(!wrap||!btn)return;
  const list=[['studio','录音棚'],['midnight','午夜'],['cyber','赛博'],['sunrise','日出'],['cream','奶油（浅色）'],['forest','森林']];
  const panel=el('div','menu themePanel','');
  list.forEach(([k,n])=>{const b=el('button','mi themeMi','<i class="tdot" data-k="'+k+'"></i><span>'+n+'</span>');b.dataset.theme=k;panel.appendChild(b)});
  wrap.appendChild(panel);
  const cur=()=>document.documentElement.dataset.theme||'studio';
  const sync=()=>Array.from(panel.children).forEach(b=>b.classList.toggle('on',b.dataset.theme===cur()));
  btn.addEventListener('click',e=>{e.stopPropagation();sync();panel.classList.toggle('open')});
  panel.addEventListener('click',e=>{
    const mi=e.target.closest('.mi');if(!mi)return;e.stopPropagation();
    document.documentElement.dataset.theme=mi.dataset.theme;
    try{localStorage.setItem('mpTheme',mi.dataset.theme)}catch(err){}
    sync();panel.classList.remove('open');
  });
  document.addEventListener('click',()=>panel.classList.remove('open'));
  sync();
}
