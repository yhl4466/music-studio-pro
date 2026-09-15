/* [viz/transport.js] 可视化页播放器（VISUALIZER-V1 子任务 4）。
   设计要点：
   - **自带 AudioContext**：不 import 主应用 js/audio/*（不用 ensureAudio/buildGraph/actx/A），
     信号链独立为 source → gain → analyser → destination，避免与主应用音频图互相干扰。
   - 计时**只用 actx.currentTime**：getCurrentTime() = baseOffset + (actx.currentTime - startedAt)，
     全程不用 setTimeout 计时。
   - AudioBufferSourceNode 一次性：暂停/跳转/停止都 stop 掉旧源再按需新建（用完即弃，不会泄漏）。
   - AnalyserNode 参数按可视化需要设置：fftSize=2048（1024 频点）、smoothing=0.8
     （主应用实时图是 256/0.82，两者独立、互不影响）。
   状态机：idle → loading → playing ⇄ paused → ended（ended 后 play 会从头开始）。
   依赖：仅 core/util.js 的 clamp（纯函数）。 */
import { clamp } from '../core/util.js';

export const FFT_SIZE=2048;
export const SMOOTHING=0.8;
const START_LEAD=0.012;             // start() 的预排时间（等音频线程下一块，避免被钳到“立即”；过大会让位置显示偏慢）

let _actx=null,_analyser=null,_gain=null,_dest=null;
let _buffer=null,_bufferFrames=0;
let _state='idle',_baseOffset=0,_startedAt=0,_durSec=0;
let _leadSec=START_LEAD;
let _src=null,_srcToken=0,_ended=false;
const _stateCbs=[],_timeCbs=[];

/* ---------- 节点生命周期 ---------- */
function _ensureGraph(){
  if(_actx)return _actx;
  const AC=(typeof AudioContext!=='undefined')?AudioContext
          :(typeof webkitAudioContext!=='undefined'?webkitAudioContext:null);
  if(!AC)throw new Error('当前浏览器不支持 Web Audio');
  _actx=new AC();
  _gain=_actx.createGain(); _gain.gain.value=1;
  _analyser=_actx.createAnalyser();
  _analyser.fftSize=FFT_SIZE;
  _analyser.smoothingTimeConstant=SMOOTHING;
  _dest=_actx.destination;
  _gain.connect(_analyser); _analyser.connect(_dest);
  return _actx;
}
/* 丢弃当前 BufferSource（stop + 断开 + 清空 onended），换新源前必须调用 */
function _dropSource(){
  const s=_src; _src=null;
  _srcToken++;
  if(!s)return;
  try{ s.onended=null }catch(e){}
  try{ s.stop() }catch(e){}
  try{ s.disconnect() }catch(e){}
}
function _beginSource(offset){
  if(!_buffer||!_actx)return false;
  const src=_actx.createBufferSource();
  src.buffer=_buffer;
  src.connect(_gain);
  src.onended=()=>_handleEnded(token);
  const token=_srcToken;
  const when=_actx.currentTime+_leadSec;
  try{ src.start(when,Math.max(0,Math.min(offset,_durSec))) }
  catch(e){ try{ src.start() }catch(e2){ try{src.disconnect()}catch(e3){} return false } }
  _src=src; _startedAt=when;
  return true;
}
function _handleEnded(token){
  if(token!==_srcToken)return;            // 旧源（被 pause/seek 替换过）的回调，忽略
  _src=null; _ended=true;
  _baseOffset=_durSec;
  _setState('ended');
  _notifyTime();
}

/* ---------- 状态 / 通知 ---------- */
function _setState(s){
  if(s===_state)return;
  _state=s;
  for(const cb of _stateCbs){ try{ cb(s) }catch(e){} }
}
function _notifyTime(){
  const t=getCurrentTime();
  for(const cb of _timeCbs){ try{ cb(t,_durSec) }catch(e){} }
  return t;
}

/* =========================================================================
   对外 API
   ========================================================================= */
/** 载入 AudioBuffer：重置状态为 idle、进度归零（不创建 AudioContext，避免自动播放策略拦截） */
export function load(buffer){
  if(!buffer||!buffer.length)throw new Error('load() 需要一个有效的 AudioBuffer');
  _dropSource();
  _buffer=buffer;
  _bufferFrames=buffer.length;
  _durSec=buffer.duration||(buffer.length/buffer.sampleRate)||0;
  _baseOffset=0;
  _ended=false;
  _state='idle';
  _setState('idle');
  _notifyTime();
  return _durSec;
}
export function state(){ return _state }
export function getState(){ return _state }
export function isPlaying(){ return _state==='playing' }
export function getDuration(){ return _durSec }
export function getBuffer(){ return _buffer }
export function getFrames(){ return _bufferFrames }
/** 当前播放位置（秒）：只在 playing 时用 actx.currentTime 推算，其余状态返回已记录的偏移 */
export function getCurrentTime(){
  if(_state==='playing'&&_actx){
    const t=_baseOffset+Math.max(0,_actx.currentTime-_startedAt);
    return clamp(t,0,_durSec);
  }
  return clamp(_baseOffset,0,_durSec||0);
}
export function needsGesture(){ return !!(_actx&&_actx.state==='suspended') }
export function getAnalyser(){ return _analyser }
export function getAnalyserParams(){ return {fftSize:FFT_SIZE,fftBins:_analyser?_analyser.frequencyBinCount:FFT_SIZE/2,smoothing:SMOOTHING} }
export function getAudioContextState(){ return _actx?_actx.state:'none' }

export function play(){
  if(!_buffer)return false;
  try{ _ensureGraph() }catch(e){ return false }
  if(_analyser&&_analyser.fftSize!==FFT_SIZE)_analyser.fftSize=FFT_SIZE;
  try{ const r=_actx.resume(); if(r&&r.catch)r.catch(()=>{}) }catch(e){}
  _dropSource();
  let off=_baseOffset;
  if(_ended||off>=_durSec-1e-4){ off=0; _ended=false }   // 播完后再按播放 = 从头
  _baseOffset=off;
  if(!_beginSource(off)){ _setState('paused'); return false }
  _setState('playing');
  _notifyTime();
  return true;
}
export function pause(){
  if(_state!=='playing')return false;
  const t=getCurrentTime();
  _dropSource();                 // 先停源，再记位置（顺序对调会读到已推进的 currentTime）
  _baseOffset=t;
  _setState('paused');
  _notifyTime();
  return true;
}
export function toggle(){ return isPlaying()?pause():play() }
export function stop(){
  if(!_buffer){ _setState('idle'); return false }
  _dropSource();
  _baseOffset=0;
  _ended=false;
  _setState('idle');
  _notifyTime();
  return true;
}
/** 跳转到 seconds：播放中则在新位置继续播，暂停/结束态则只更新位置 */
export function seek(seconds){
  if(!_buffer)return getCurrentTime();
  const t=clamp(Number(seconds)||0,0,_durSec);
  const wasPlaying=(_state==='playing');
  _dropSource();
  _ended=(t>=_durSec-1e-4);
  _baseOffset=_ended?_durSec:t;
  if(wasPlaying&&!_ended){
    if(_beginSource(_baseOffset))_setState('playing');
    else _setState('paused');
  }else{
    _setState(_ended?'ended':(_state==='playing'?'paused':_state));
  }
  _notifyTime();
  return getCurrentTime();
}
/** 预留：smoothingTimeConstant 可被渲染器按需微调（默认 0.8） */
export function setSmoothing(v){
  if(!_analyser)return;
  _analyser.smoothingTimeConstant=clamp(Number(v)||SMOOTHING,0,1);
}
export function onStateChange(cb){ if(typeof cb==='function')_stateCbs.push(cb); return ()=>{ const i=_stateCbs.indexOf(cb); if(i>=0)_stateCbs.splice(i,1) } }
export function onTimeUpdate(cb){ if(typeof cb==='function')_timeCbs.push(cb); return ()=>{ const i=_timeCbs.indexOf(cb); if(i>=0)_timeCbs.splice(i,1) } }
/** 供主循环每帧调用：按 actx.currentTime 刷新一次位置（播放中才会变化） */
export function notifyTime(){ return _notifyTime() }
/** 页面卸载/切换工程：停播并释放 AudioContext */
export function dispose(){
  _dropSource();
  const a=_actx; _actx=null; _analyser=null; _gain=null; _dest=null;
  _buffer=null; _bufferFrames=0; _durSec=0; _baseOffset=0; _state='idle';
  try{ if(a&&typeof a.close==='function'){ const r=a.close(); if(r&&r.catch)r.catch(()=>{}) } }catch(e){}
}
