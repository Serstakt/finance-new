// Смоук-тест логики chart_overlay.js: загрузка файла в node:vm с заглушками DOM,
// эмуляция полного пользовательского сценария «включил разметку -> Уровень -> клик по графику».
const fs = require('fs'); const path = require('path'); const vm = require('vm');
let failures = 0;
const assert = (c, m) => { console.log((c?'PASS: ':'FAIL: ')+m); if(!c) failures++; };

class El {
  constructor(tag){ this.tagName=tag; this.style={}; this.dataset={}; this._cls=new Set(); this.children=[]; this.listeners={}; }
  get classList(){ const s=this._cls; return { add:(...c)=>c.forEach(x=>s.add(x)), remove:(...c)=>c.forEach(x=>s.delete(x)),
    toggle:(c,f)=>{const on=f===undefined?!s.has(c):!!f; on?s.add(c):s.delete(c); return on;}, contains:(c)=>s.has(c) }; }
  appendChild(ch){ ch.parentElement=this; this.children.push(ch); }
  addEventListener(t,fn){ (this.listeners[t]=this.listeners[t]||[]).push(fn); }
  removeEventListener(t,fn){ this.listeners[t]=(this.listeners[t]||[]).filter(f=>f!==fn); }
  dispatch(t,e){ (this.listeners[t]||[]).forEach(f=>f.call(this,e)); }
  querySelectorAll(){ return []; }
  getBoundingClientRect(){ return {left:0,top:0,width:800,height:600}; }
}
const ids = {}; for (const id of ['chart-container','tradingview_chart','markup-toolbar']) ids[id]=new El('div');
ids['markup-toolbar'].style.display='none';
const ctxCanvas = { clearRect(){}, setTransform(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fill(){}, arcTo(){}, closePath(){},
  setLineDash(){}, measureText:()=>({width:50}), fillText(){}, set font(v){}, set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){} };
const canvasStub = Object.assign(new El('canvas'), { getContext:()=>ctxCanvas, clientWidth:800, clientHeight:600, width:0, height:0 });

const store = {}; // localStorage/sessionStorage
const storageStub = { getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
const widget = {
  ready:true,
  getChartScaleInfo(h){ return { from:250, to:300, height:h }; },
  convertTime(v,dir){ return dir==='UTC' ? v*1 : 1700000000; },
  subscribe(){},
};
const sandbox = {
  console, setTimeout, setInterval:()=>0, clearInterval(){}, clearTimeout(){},
  document: { readyState:'complete', getElementById:id=>ids[id], createElement:t=>t==='canvas'?canvasStub:new El(t),
              addEventListener:(t,fn)=>{(sandbox.document._l[t]=sandbox.document._l[t]||[]).push(fn)}, removeEventListener:(t,fn)=>{sandbox.document._l[t]=(sandbox.document._l[t]||[]).filter(f=>f!==fn)}, _l:{},
              querySelectorAll:()=>[], body:new El('body') },
  window: null, API_BASE:'', fetchWithTimeout:async()=>({ok:false,status:500,json:async()=>({})}),
  localStorage:storageStub, sessionStorage:storageStub,
  getComputedStyle:()=>({position:'relative'}), devicePixelRatio:1, prompt:()=>'текст', confirm:()=>true,
  TradingView:{}, fmtPrice:null, fmtDate:null, Date, Math, JSON, Promise, isFinite, Array, Object, String, Number, Error,
  appState:{activeListId:'fav_1'}, getCurrentList:()=>({activeSymbol:'MOEX:SBER'}), log:()=>{},
  ResizeObserver: undefined,
};

const winL = {};
sandbox.addEventListener = (t,fn)=>{ (winL[t]=winL[t]||[]).push(fn); };
sandbox.removeEventListener = (t,fn)=>{ winL[t]=(winL[t]||[]).filter(f=>f!==fn); };
sandbox.dispatchWin = (t,e)=>{ (winL[t]||[]).forEach(f=>f(e)); };
sandbox.widget = { ready:true, getChartScaleInfo(h){ return { from:250, to:300, height:h }; }, convertTime(v,dir){ return dir==='UTC'?v*1:1700000000; }, subscribe(){} };
sandbox.widgetReady = true;
sandbox.ResizeObserver = class { observe(){} disconnect(){} constructor(){} };
sandbox.window = sandbox; sandbox.self = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','js','chart_overlay.js'),'utf8'), sandbox, {filename:'chart_overlay.js'});

(async () => {
  // 1) Включаем тулбар разметки
  sandbox.toggleMarkupToolbar();
  assert(ids['markup-toolbar'].style.display==='flex', 'Тулбар открыт при активном тикере');
  assert(canvasStub.parentElement===ids['chart-container'], 'Canvas создан на #chart-container');

  // 2) Выбираем инструмент «Уровень» (mousedown на кнопке вне холста НЕ должен ломать режим)
  sandbox.setMarkupTool('hline');
  assert(sandbox.__markupTool==='hline', 'Инструмент hline активен');
  assert(canvasStub.classList.contains('drawing'), 'Холст ловит мышь (drawing)');
  // имитируем mousedown документа по кнопке тулбара (страховка не должна всё detachить)
  (sandbox.document._l['mousedown']||[]).forEach(f=>f({target:ids['markup-toolbar'], button:0}));
  assert(sandbox.__markupTool==='hline', 'После mousedown вне холста инструмент сохранён');

  // 3) Клик по графику (mousedown+mouseup на canvas) -> должен создаться уровень
  const before = sandbox.__markupItems.length;
  canvasStub.dispatch('mousedown', {button:0, clientX:400, clientY:300, currentTarget:canvasStub});
  await new Promise(r=>setTimeout(r,50)); // addMarkupAtPoint асинхронная (waitForChartScale)
  assert(sandbox.__markupItems.length===before+1, 'Клик по графику создал уровень');
  const it = sandbox.__markupItems[sandbox.__markupItems.length-1];
  assert(it.type==='hline' && it.price>250 && it.price<300, `Цена уровня в диапазоне шкалы (${it.price})`);
  // 4) Залипший drag больше не мешает: после mouseup следующий клик создаёт НОВЫЙ уровень
  sandbox.setMarkupTool('hline');
  const n1 = sandbox.__markupItems.length;
  canvasStub.dispatch('mousedown', {button:0, clientX:400, clientY:200, currentTarget:canvasStub});
  await new Promise(r=>setTimeout(r,50));
  assert(sandbox.__markupItems.length===n1+1, 'Второй клик ставит новый уровень (drag не залип)');
  assert(Math.abs(sandbox.__markupItems[n1].price-it.price)>1, 'Второй уровень на другой цене');
  // 5) Разметка сохранена (orphan для fav_-списка) и переживает перезагрузку
  assert(store['chart_markup_orphan'] && JSON.parse(store['chart_markup_orphan'])['MOEX:SBER'].length===2, 'Разметка fav_-списка сохранена в orphan-ключ');
  process.exit(failures?1:0);
})();
