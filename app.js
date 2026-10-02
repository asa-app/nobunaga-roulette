(() => {
  "use strict";

  const STORAGE_KEY = "nobunaga_oshinobi_v1";
  const MAX_BALANCE = 9999999;
  const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const WHEEL = ["0",28,9,26,30,11,7,20,32,17,5,22,34,15,3,24,36,13,1,"00",27,10,25,29,12,8,19,31,18,6,21,33,16,4,23,35,14,2];
  const numbers = Array.from({length:36},(_,i)=>i+1);
  const DENOMINATIONS = [100,1000,10000];
  const MAX_COINS_PER_BET = 20;
  // Wheel geometry is defined once in the 500 x 500 SVG coordinate system.
  const TAU = Math.PI * 2;
  const WHEEL_CENTER = 250;
  const WHEEL_STEP = TAU / WHEEL.length;
  const TOP_ANGLE = -Math.PI / 2;
  const POCKET_PHASE = WHEEL_STEP / 2;
  const FRAME_INNER_R = 218;
  const TRACK_OUTER_R = 214;
  const TRACK_INNER_R = 190;
  const NUMBER_OUTER_R = 188;
  const NUMBER_INNER_R = 159;
  const NUMBER_TEXT_R = 173.5;
  const POCKET_OUTER_R = 154;
  const POCKET_INNER_R = 112;
  const INNER_ART_OUTER_R = 110;
  const INNER_ART_INNER_R = 42;
  const HUB_OUTER_R = 40;
  const HUB_RING_R = 31;
  const HUB_CORE_R = 11;
  const BALL_TRACK_R = (TRACK_OUTER_R + TRACK_INNER_R) / 2;
  const BALL_POCKET_R = (POCKET_OUTER_R + POCKET_INNER_R) / 2;
  const NEEDLE_HIT_T = .80;
  const RESULT_DELAY_MS = 750;
  const WHEEL_IMAGE_X = 3.2;
  const WHEEL_IMAGE_Y = 3.2;
  const fmt = n => new Intl.NumberFormat("ja-JP").format(n);
  const $ = id => document.getElementById(id);
  const betDefs = new Map(), betButtons = new Map(), edgePositions = new Map();
  let state = {balance:10000,wagers:[],history:[],sound:true};
  let selectedChip = 10000, screen = "title", modalType = null, ledgerSort = "count";
  let wheelRotation = 0, ballAngle = TOP_ANGLE, ballRadius = BALL_TRACK_R, winningPocket = null;
  let spinFrame = 0, resultTimer = 0, skipRevealTimer = 0, resultNextUnlockAt = 0, spinSettled = false, resultShown = false, skipSpinEnabled = false, pendingSpin = null, audioCtx = null, noiseBuffer = null, rollSound = null, toastTimer = 0;
  const SCREENS = {title:$("title-screen"),story:$("story-screen"),bet:$("bet-screen"),wheel:$("wheel-screen")};

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
      if(!saved || typeof saved !== "object") return;
      if(Number.isSafeInteger(saved.balance) && saved.balance>=0) state.balance=Math.min(saved.balance,MAX_BALANCE);
      if(Array.isArray(saved.history)) state.history=saved.history.filter(x=>WHEEL.includes(x)).slice(0,100);
      if(Array.isArray(saved.wagers)) state.wagers=saved.wagers.filter(w=>w && typeof w.key==="string" && Number.isSafeInteger(w.stake) && w.stake>0 && w.stake<1e12).slice(0,400).map(w=>({key:w.key,stake:w.stake,coins:validCoins(w.coins,w.stake)?Object.fromEntries(DENOMINATIONS.map(d=>[d,w.coins[d]])):legacyCoins(w.stake)}));
      if(typeof saved.sound==="boolean") state.sound=saved.sound;
    } catch(_){/* Older or damaged local data starts fresh. */}
  }
  function validCoins(coins,stake){return coins&&DENOMINATIONS.every(d=>Number.isSafeInteger(coins[d])&&coins[d]>=0)&&DENOMINATIONS.reduce((n,d)=>n+d*coins[d],0)===stake}
  function legacyCoins(stake){const coins={100:0,1000:0,10000:0};for(const d of [...DENOMINATIONS].reverse()){coins[d]=Math.floor(stake/d);stake%=d}return coins}
  function save(){ try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch(_){}}
  function show(name){
    if(name==="title"||name==="story")stopVoice();
    screen=name; Object.entries(SCREENS).forEach(([key,el])=>{
      const active=key===name;
      el.classList.toggle("active",active);
    });
    if(name==="wheel")try{drawWheel()}catch(_){}
    if(name==="bet") refresh();
    if(name!=="story") {
      const horn=$("horn-audio");horn.pause();horn.currentTime=0;
    }
  }
  function toast(message){
    const el=$("toast");el.textContent=message;el.classList.add("show");clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>el.classList.remove("show"),2200);
  }
  function color(num){return num==="0"||num==="00"?"green":RED.has(+num)?"red":"black"}
  // Consume the follow-up click belonging to an edge bet handled on pointerdown.
  // A new pointer gesture immediately releases the guard, including rapid taps.
  let handledEdgeTap = false;
  document.addEventListener("pointerdown",()=>{handledEdgeTap=false},true);
  document.addEventListener("click",event=>{
    if(!handledEdgeTap || event.detail===0)return;
    handledEdgeTap=false;
    event.preventDefault();
    event.stopImmediatePropagation();
  },true);
  function makeButton(parent, label, def, className=""){
    const b=document.createElement("button");b.type="button";b.textContent=label;b.dataset.baseLabel=label;b.className=className;
    b.setAttribute("aria-label",def.label+"、配当 "+def.odds+"対1");
    b.dataset.key=def.key;
    if(className.includes("edge-button") || className.includes("zero-split")){
      b.addEventListener("pointerdown",e=>{
        handledEdgeTap=true;
        e.preventDefault();
        e.stopPropagation();
        place(def.key);
      });
      b.addEventListener("click",e=>{
        e.preventDefault();
        e.stopPropagation();
      });
    }else{
      b.addEventListener("click",()=>place(def.key));
    }
    parent.appendChild(b);betButtons.set(def.key,b);return b;
  }
  function define(type, values, odds, label){
    const sorted=values.map(String).sort((a,b)=>a==="0"?-1:b==="0"?1:a==="00"?-1:b==="00"?1:+a-+b);
    const key=type+":"+sorted.join(",");
    const def={key,type,numbers:sorted,odds,label};
    betDefs.set(key,def);return def;
  }
  function buildBoard(){
    const zero=$("zero-zone"),grid=$("number-grid"),edge=$("edge-layer");
    for(const z of ["00","0"])makeButton(zero,z,define("single",[z],35,z+" １数字"),"green");
    const zeroSplit=makeButton(zero,"◆",define("split",["0","00"],17,"0・00 ２数字"),"zero-split");
    zeroSplit.title="0・00 の２数字";
    for(let row=0;row<3;row++) for(let column=0;column<12;column++){
      const num=column*3+3-row;
      makeButton(grid,String(num),define("single",[num],35,num+" １数字"),color(num));
    }
    function overlay(values,type,odds,x,y,label){
      const d=define(type,values,odds,label),b=makeButton(edge,type==="corner"?"✦":"•",d,"edge-button "+(type==="corner"?"corner":""));
      b.style.left=x+"%";b.style.top=y+"%";b.title=label;
      edgePositions.set(type+":"+Math.round(x*100)+":"+Math.round(y*100),d.key);
    }
    // 2-number lines, horizontally and vertically adjacent on the numbered layout.
    for(let r=0;r<3;r++)for(let c=0;c<11;c++){
      const a=c*3+3-r,b=(c+1)*3+3-r;
      overlay([a,b],"split",17,(c+1)*100/12,(r+.5)*100/3,"２数字 "+a+"・"+b);
    }
    for(let r=0;r<2;r++)for(let c=0;c<12;c++){
      const a=c*3+3-r,b=a-1;
      overlay([a,b],"split",17,(c+.5)*100/12,(r+1)*100/3,"２数字 "+a+"・"+b);
    }
    for(let r=0;r<2;r++)for(let c=0;c<11;c++){
      const a=c*3+3-r,b=a-1,d=(c+1)*3+3-r;
      overlay([a,b,d,d-1],"corner",8,(c+1)*100/12,(r+1)*100/3,"４数字 "+[a,b,d,d-1].sort((x,y)=>x-y).join("・"));
    }
    makeButton($("range-row"),"1～18",define("low",numbers.filter(n=>n<=18),1,"1～18"));
    makeButton($("range-row"),"19～36",define("high",numbers.filter(n=>n>=19),1,"19～36"));
    for(let d=0;d<3;d++){
      const values=Array.from({length:12},(_,i)=>d*12+i+1);
      makeButton($("dozen-row"),(d*12+1)+"～"+(d*12+12),define("dozen",values,2,(d*12+1)+"～"+(d*12+12)+" 12数字"));
    }
    const outside=[
      ["偶数",numbers.filter(n=>n%2===0),"even","偶数"],
      ["◆ 黒",numbers.filter(n=>!RED.has(n)),"black","黒"],
      ["● 赤",numbers.filter(n=>RED.has(n)),"red","赤"],
      ["奇数",numbers.filter(n=>n%2===1),"odd","奇数"]
    ];
    for(const [label,values,type,name] of outside)makeButton($("outside-row"),label,define(type,values,1,name),type==="red"?"red":type==="black"?"black":"");
    // Saved wagers must still be valid definitions and denomination multiples.
    const obsolete=state.wagers.filter(w=>!betDefs.has(w.key) || w.stake%100!==0);
    state.balance=Math.min(MAX_BALANCE,state.balance+obsolete.reduce((total,w)=>total+w.stake,0));
    state.wagers=state.wagers.filter(w=>betDefs.has(w.key) && w.stake%100===0);
    save();
  }
  function wagerTotal(){return state.wagers.reduce((sum,w)=>sum+w.stake,0)}
  function coinStack(w){
    const badge=document.createElement("span");badge.className="wager-stack";badge.setAttribute("aria-hidden","true");
    const present=DENOMINATIONS.filter(d=>w.coins[d]>0);
    present.forEach((d,i)=>{
      const piece=document.createElement("img");
      piece.className="coin-piece "+coinClass(d)+(w.coins[d]>1?" stacked":"")+(w.coins[d]>2?" deep":"");
      piece.src=d===100?"./assets/coin100.png":d===1000?"./assets/coin1000.png":"./assets/coin10000.png";
      piece.alt="";
      piece.style.left=(15+(i-(present.length-1)/2)*5)+"px";
      piece.style.zIndex=String(i+1);
      badge.appendChild(piece);
    });
    return badge;
  }
  function refresh(){
    $("balance").textContent=fmt(state.balance);$("wager-total").textContent=fmt(wagerTotal())+"銭";
    const startSpinButton=$("start-spin");
    const hasWager=state.wagers.length>0;
    startSpinButton.disabled=!hasWager;
    startSpinButton.classList.toggle("is-disabled",!hasWager);
    $("add-money").disabled=state.balance>=MAX_BALANCE;
    document.querySelectorAll("[data-chip]").forEach(b=>b.classList.toggle("selected",+b.dataset.chip===selectedChip));
    const wagerLayer=$("wager-layer");wagerLayer.replaceChildren();
    for(const [key,b] of betButtons){
      const w=state.wagers.find(x=>x.key===key);
      b.textContent=b.dataset.baseLabel;
      if(w){
        if(b.classList.contains("edge-button")){
          const badge=coinStack(w);badge.classList.add("edge-stack",betDefs.get(key).type);
          badge.style.left=b.style.left;badge.style.top=b.style.top;
          wagerLayer.appendChild(badge);
        }else{
          const badge=coinStack(w);badge.classList.add("cell-stack");b.appendChild(badge);
        }
        b.classList.add("has-wager");b.setAttribute("aria-label",betDefs.get(key).label+"、現在 "+fmt(w.stake)+"銭");
      }
      else b.classList.remove("has-wager");
      if(!w)b.setAttribute("aria-label",betDefs.get(key).label+"、配当 "+betDefs.get(key).odds+"対1");
    }
  }
  function place(key){
    if(screen!=="bet"||modalType)return;
    if(!betDefs.has(key))return;
    if(state.balance<selectedChip){toast("銭が足りぬ。「銭を持って参れ！」を押そう");sound("error");return}
    const old=state.wagers.find(w=>w.key===key);
    if(old){
      const present=DENOMINATIONS.filter(d=>old.coins[d]>0);
      if(present.length!==1 || present[0]!==selectedChip){
        toast("この場所には別の銭が置かれておる。変更から戻して置き直そう");
        sound("error");
        return;
      }
      const placedCount=DENOMINATIONS.reduce((sum,d)=>sum+(old.coins[d]||0),0);
      if(placedCount>=MAX_COINS_PER_BET){
        toast("この場所には20枚までじゃ");
        sound("error");
        return;
      }
      old.stake+=selectedChip;
      old.coins[selectedChip]++;
    }else{
      state.wagers.push({key,stake:selectedChip,coins:{100:Number(selectedChip===100),1000:Number(selectedChip===1000),10000:Number(selectedChip===10000)}});
    }
    state.balance-=selectedChip;save();refresh();sound("place");playVoice("place");
    const position=betButtons.get(key);position?.classList.remove("just-placed");void position?.offsetWidth;position?.classList.add("just-placed");
  }
  // A line itself is a target, including the space outside the small visual mark.
  function placeOnGridLine(event){
    if(event.target.closest?.(".edge-button")){
      return;
    }
    // A direct click on a numbered cell belongs to that single-number bet only.
    // Do not also reinterpret the same click as a nearby line/corner bet.
    if(event.target.closest?.("#number-grid button")){
      return;
    }
    if(screen!=="bet"||modalType)return;
    const rect=$("number-area").getBoundingClientRect();
    if(!rect.width||!rect.height)return;
    const x=event.clientX-rect.left,y=event.clientY-rect.top;
    if(x<0||x>rect.width||y<0||y>rect.height)return;
    const cellW=rect.width/12,cellH=rect.height/3;
    const lineC=Math.round(x/cellW),lineR=Math.round(y/cellH);
    const onVertical=lineC>0&&lineC<12&&Math.abs(x-lineC*cellW)<=Math.min(18,cellW*.29);
    const onHorizontal=lineR>0&&lineR<3&&Math.abs(y-lineR*cellH)<=Math.min(18,cellH*.29);
    let type,px,py;
    if(onVertical&&onHorizontal){type="corner";px=lineC*100/12;py=lineR*100/3}
    else if(onVertical){type="split";px=lineC*100/12;py=(Math.min(2,Math.floor(y/cellH))+.5)*100/3}
    else if(onHorizontal){type="split";px=(Math.min(11,Math.floor(x/cellW))+.5)*100/12;py=lineR*100/3}
    else return;
    const key=edgePositions.get(type+":"+Math.round(px*100)+":"+Math.round(py*100));
    if(!key)return;
    event.preventDefault();event.stopPropagation();
    place(key);
  }
  function coinClass(amount){return amount===100?"copper":amount===10000?"gold":"silver"}
  function removeBet(key){
    const i=state.wagers.findIndex(w=>w.key===key);if(i<0)return;
    const wager=state.wagers[i];
    const placedDenominations=DENOMINATIONS.filter(d=>(wager.coins[d]||0)>0);
    if(placedDenominations.length!==1)return;
    const denomination=placedDenominations[0];
    wager.coins[denomination]--;
    wager.stake-=denomination;
    state.balance=Math.min(MAX_BALANCE,state.balance+denomination);
    if(!wager.stake)state.wagers.splice(i,1);
    save();refresh();sound("cancel");renderBets();
  }
  function refundAll(){
    state.balance=Math.min(MAX_BALANCE,state.balance+wagerTotal());state.wagers=[];save();refresh();sound("cancel");renderBets();
  }
  function addMoney(){
    if(state.balance>=MAX_BALANCE){toast("所持銭は上限の9,999,999銭じゃ");return}
    const added=Math.min(100000,MAX_BALANCE-state.balance);
    state.balance+=added;save();refresh();sound("add");playVoice("add",true);burstMoneyCoins($("coin-rain"));
  }
  function rain(el,n,home=false,opts={}){
    const {
      append=false,
      waveSpan=home ? .55 : .72,
      cleanupMs=home?2800:3600,
      durationMin=home?1.45:1.55,
      durationMax=home?1.85:2.2,
      scaleMin=home ? .9 : .78,
      scaleMax=home?1.08:1.22,
      driftMin=home?-18:-78,
      driftMax=home?18:78,
      rotateMin=home?400:560,
      rotateMax=home?560:920,
      brightMin=home ? .96 : 1.03,
      brightMax=home?1.08:1.33,
      leftMin=home?8:3,
      leftRange=home?84:94,
      startTopMin=home?-13:-18,
      startTopMax=home?-9:-11
    }=opts;
    if(!append)el.replaceChildren();
    if(el._coinRainCleanupTimer)clearTimeout(el._coinRainCleanupTimer);
    const area=el.getBoundingClientRect(),target=document.querySelector(".chip.gold .coin-art")?.getBoundingClientRect();
    for(let i=0;i<n;i++){
      const coin=document.createElement("span");coin.className="fall-coin gold";
      const left=leftMin+Math.random()*leftRange;
      coin.style.left=left+"%";
      const scale=(scaleMin+Math.random()*(scaleMax-scaleMin)).toFixed(2);
      const duration=(durationMin+Math.random()*(durationMax-durationMin)).toFixed(2);
      const driftEnd=(driftMin+Math.random()*(driftMax-driftMin)).toFixed(0)+"px";
      const driftMid=(parseFloat(driftEnd)*(.38+Math.random()*.22)).toFixed(0)+"px";
      const rotateEnd=(rotateMin+Math.random()*(rotateMax-rotateMin)).toFixed(0)+"deg";
      const rotateMid=(Math.round(parseFloat(rotateEnd)*(.45+Math.random()*.12)))+"deg";
      const bright=(brightMin+Math.random()*(brightMax-brightMin)).toFixed(2);
      const startTop=(startTopMin+Math.random()*(startTopMax-startTopMin)).toFixed(1)+"%";
      coin.style.setProperty("--coin-scale",scale);
      coin.style.setProperty("--coin-duration",duration+"s");
      coin.style.setProperty("--coin-mid-drift",driftMid);
      coin.style.setProperty("--coin-end-drift",driftEnd);
      coin.style.setProperty("--coin-mid-rotate",rotateMid);
      coin.style.setProperty("--coin-end-rotate",rotateEnd);
      coin.style.setProperty("--coin-bright",bright);
      coin.style.setProperty("--coin-start-top",startTop);
      if(home&&target){
        const x=(target.left+target.width/2-area.left)-(area.width*(left/100));
        const y=(target.top+target.height/2-area.top)+area.height*.12;
        coin.style.setProperty("--coin-x",x+"px");
        coin.style.setProperty("--coin-y",y+"px");
        coin.classList.add("homing");
      }
      coin.style.animationDelay=(Math.random()*waveSpan)+"s";
      el.appendChild(coin);
    }
    el._coinRainCleanupTimer=setTimeout(()=>{el.replaceChildren();el._coinRainCleanupTimer=0},cleanupMs);
  }

  function burstMoneyCoins(el){
    // A short, cheerful two-wave koban shower for "銭を持って参れ！".
    // Keep it clearly smaller than the victory rain, but much more noticeable
    // than the old 10-coin effect.
    const waves=[
      {count:17,delay:0,waveSpan:.24,durationMin:1.05,durationMax:1.34,scaleMin:1.00,scaleMax:1.22,driftMin:-28,driftMax:28,brightMin:1.08,brightMax:1.30},
      {count:11,delay:230,waveSpan:.30,durationMin:1.12,durationMax:1.42,scaleMin:.94,scaleMax:1.16,driftMin:-24,driftMax:24,brightMin:1.05,brightMax:1.24}
    ];
    el.replaceChildren();
    if(el._coinRainCleanupTimer)clearTimeout(el._coinRainCleanupTimer);
    waves.forEach((wave,index)=>setTimeout(()=>{
      if(screen!=="bet")return;
      rain(el,wave.count,true,{...wave,append:index>0,cleanupMs:2500,leftMin:7,leftRange:86,startTopMin:-15,startTopMax:-9,rotateMin:460,rotateMax:720});
    },wave.delay));
  }

  function burstVictoryCoins(el){
    // Four staggered waves. 420 simultaneous/lingering coins gives roughly
    // three times the perceived density of the old single-wave look without
    // pushing mobile browsers into an unnecessarily heavy 700+ DOM animation.
    const waves=[
      {count:160,delay:0,waveSpan:.42,durationMin:1.35,durationMax:1.92,scaleMin:.82,scaleMax:1.22,driftMin:-92,driftMax:92,brightMin:1.10,brightMax:1.45},
      {count:120,delay:260,waveSpan:.54,durationMin:1.48,durationMax:2.05,scaleMin:.78,scaleMax:1.18,driftMin:-84,driftMax:84,brightMin:1.07,brightMax:1.36},
      {count:85,delay:620,waveSpan:.68,durationMin:1.60,durationMax:2.16,scaleMin:.74,scaleMax:1.14,driftMin:-70,driftMax:70,brightMin:1.04,brightMax:1.30},
      {count:55,delay:1020,waveSpan:.78,durationMin:1.70,durationMax:2.25,scaleMin:.72,scaleMax:1.08,driftMin:-58,driftMax:58,brightMin:1.02,brightMax:1.24}
    ];
    el.replaceChildren();
    if(el._coinRainCleanupTimer)clearTimeout(el._coinRainCleanupTimer);
    waves.forEach((wave,index)=>setTimeout(()=>{
      if(screen!=="wheel"||!resultShown)return;
      rain(el,wave.count,false,{...wave,append:index>0,cleanupMs:4200,leftMin:2,leftRange:96,startTopMin:-20,startTopMax:-11,rotateMin:620,rotateMax:1080});
    },wave.delay));
  }

  function openModal(type){
    modalType=type; $("modal-backdrop").hidden=false;
    $("modal").classList.toggle("modal-no-heading",type==="ledger"||type==="rules");
    $("modal").classList.toggle("modal-bets",type==="bets");
    $("modal").classList.toggle("modal-operations",type==="settings");
    $("modal-instruction").hidden=type!=="bets";
    $("modal-heading").textContent=({bets:"賭けた銭を変更",ledger:"出目帳",rules:"ルーレットのルール",settings:"記録・設定"})[type];
    if(type==="bets")renderBets();
    if(type==="ledger")renderLedger();
    if(type==="rules")renderRules();
    if(type==="settings")renderSettings();
    $("modal-footer").querySelector("button:last-child")?.focus();
  }
  function closeModal(){modalType=null;$("modal-backdrop").hidden=true;$("modal-body").replaceChildren();$("modal-footer").replaceChildren()}
  function renderBets(){
    if(modalType!=="bets")return;
    const body=$("modal-body"),foot=$("modal-footer");body.replaceChildren();foot.replaceChildren();
    if(!state.wagers.length){const p=document.createElement("p");p.className="empty-note";p.textContent="まだ銭を置いていません";body.appendChild(p)}
    else {
      const list=document.createElement("div");list.className="wager-list";
      for(const w of state.wagers){
        const row=document.createElement("div");row.className="wager-line";
        const label=document.createElement("span");label.className="wager-label";label.textContent=betDefs.get(w.key).label;
        const detail=document.createElement("span");detail.className="wager-detail";
        detail.textContent=DENOMINATIONS.filter(d=>w.coins[d]).map(d=>(d===100?"銅銭":d===1000?"銀札":"小判")+"×"+fmt(w.coins[d])).join("・");
        const value=document.createElement("strong");value.className="wager-value";value.textContent=fmt(w.stake)+"銭";
        const back=document.createElement("button");back.textContent="戻す";back.type="button";back.addEventListener("click",()=>removeBet(w.key));
        row.append(label,detail,value,back);list.appendChild(row);
      }body.appendChild(list);
    }
    const total=document.createElement("strong");total.textContent="賭けた銭　"+fmt(wagerTotal())+"銭";
    const buttons=document.createElement("div");
    if(state.wagers.length){const all=document.createElement("button");all.className="paper-button danger";all.textContent="全部戻す";all.addEventListener("click",refundAll);buttons.appendChild(all)}
    const done=document.createElement("button");done.className="paper-button";done.textContent="賭場へ戻る";done.addEventListener("click",closeModal);buttons.appendChild(done);
    foot.append(total,buttons);
  }
  function renderLedger(){
    if(modalType!=="ledger")return;
    const body=$("modal-body"),foot=$("modal-footer");body.replaceChildren();foot.replaceChildren();
    const layout=document.createElement("div");layout.className="ledger-layout";
    const recentSection=document.createElement("section");recentSection.className="ledger-recent";
    const recentHeading=document.createElement("h3");recentHeading.textContent="直近の出目";
    const recent=document.createElement("div");recent.className="recent-draws";
    if(!state.history.length)recent.textContent="まだ出目がありません";
    else for(const [i,n] of state.history.slice(0,10).entries()){
      const row=document.createElement("div");row.className="recent-draw";
      const rank=document.createElement("span");rank.className="recent-rank";rank.textContent=(i+1)+"回前";
      const number=document.createElement("strong");number.className="recent-number";number.textContent=n;
      const c=color(n),mark=c==="red"?"●":c==="green"?"▲":"◆";
      const shade=document.createElement("span");shade.className="recent-color";
      shade.innerHTML='<span class="stat-symbol '+c+'">'+mark+'</span> '+({red:"赤",green:"緑",black:"黒"})[c];
      row.append(rank,number,shade);recent.appendChild(row);
    }
    recentSection.append(recentHeading,recent);
    const statsSection=document.createElement("section");statsSection.className="ledger-stats";
    const toolbar=document.createElement("div");toolbar.className="ledger-toolbar";
    const title=document.createElement("h3");title.textContent="数字別の回数";
    const count=document.createElement("span");count.className="ledger-sample";count.textContent="直近 "+state.history.length+"／100回を集計";
    const tabs=document.createElement("div");tabs.className="ledger-tabs";
    for(const [name,label] of [["count","多い順"],["number","数字順"]]){
      const b=document.createElement("button");b.textContent=label;b.classList.toggle("selected",ledgerSort===name);b.setAttribute("aria-pressed",String(ledgerSort===name));
      b.addEventListener("click",()=>{ledgerSort=name;renderLedger()});tabs.appendChild(b);
    }toolbar.append(title,count,tabs);statsSection.appendChild(toolbar);
    const counts=new Map(WHEEL.map(n=>[String(n),0]));
    for(const n of state.history) counts.set(String(n),counts.get(String(n))+1);
    const ordered=["0","00",...numbers.map(String)];
    if(ledgerSort==="count")ordered.sort((a,b)=>counts.get(b)-counts.get(a)||orderedNumber(a)-orderedNumber(b));
    const grid=document.createElement("div");grid.className="ledger-grid";
    const max=Math.max(1,...counts.values());
    for(const n of ordered){
      const row=document.createElement("div");row.className="ledger-item";
      const num=document.createElement("span");num.innerHTML='<span class="stat-symbol '+color(n)+'">'+(color(n)==="red"?"●":color(n)==="green"?"▲":"◆")+"</span>"+n;
      const track=document.createElement("div");track.className="bar-track";const bar=document.createElement("div");bar.className="bar-fill"+(counts.get(n)===0?" zero":"");bar.style.width=(counts.get(n)/max*100)+"%";track.appendChild(bar);
      const k=document.createElement("span");k.className="count";k.textContent=counts.get(n)+"回";
      row.append(num,track,k);grid.appendChild(row);
    }statsSection.appendChild(grid);
    layout.append(recentSection,statsSection);body.appendChild(layout);
    const note=document.createElement("span");note.className="ledger-key";
    note.innerHTML='<span class="stat-symbol red">●</span> 赤　<span class="stat-symbol black">◆</span> 黒　<span class="stat-symbol green">▲</span> 緑　｜　出目は毎回独立';
    const done=document.createElement("button");done.className="paper-button";done.textContent="賭場へ戻る";done.addEventListener("click",closeModal);foot.append(note,done);
  }
  function orderedNumber(n){return n==="0"?0:n==="00"?.5:+n}
  function renderRules(){
    const body=$("modal-body"),foot=$("modal-footer");
    body.replaceChildren();foot.replaceChildren();
    body.innerHTML=`
      <div class="rules-layout">
        <section>
          <h3>遊び方</h3>
          <p>置く銭を選び、数字や枠線・交点をタップ。玉が止まった数字が当たりです。</p>
          <ul>
            <li>出目は <strong>0・00・1～36</strong> の38種類。</li>
            <li>数字の枠内＝<strong>1数字</strong>、枠線＝<strong>2数字</strong>、線の交点＝<strong>4数字</strong>への賭けです。</li>
            <li><strong>0と00の間</strong>にも2数字賭けができます。</li>
            <li>1～12／13～24／25～36、1～18／19～36、赤／黒、奇数／偶数にも賭けられます。</li>
            <li>0・00が出た場合、赤黒・奇偶・1～18／19～36・12数字は外れです。</li>
            <li>「変更」で賭け銭を確認できます。「戻す」はその場所の銭を1枚ずつ、「全部戻す」は今回置いた銭をすべて戻します。</li>
          </ul>

          <h3>銭の種類</h3>
          <div class="rule-coins" aria-label="銭の種類">
            <div class="rule-coin">
              <img src="assets/coin100.png" alt="丸い銅銭">
              <strong>100銭</strong>
              <span>丸い銅銭</span>
            </div>
            <div class="rule-coin">
              <img src="assets/coin1000.png" alt="長方形の銀札">
              <strong>1,000銭</strong>
              <span>銀札</span>
            </div>
            <div class="rule-coin">
              <img src="assets/coin10000.png" alt="楕円の小判">
              <strong>10,000銭</strong>
              <span>小判</span>
            </div>
          </div>
          <p class="coin-rule"><strong>1か所に置ける銭は1種類のみ・最大20枚。</strong><br>正確な枚数は「変更」で確認できます。所持銭は9,999,999銭が上限です。</p>
        </section>

        <section>
          <h3>当たったときの利益</h3>
          <table class="rules-table">
            <thead><tr><th>賭けた範囲</th><th>利益</th></tr></thead>
            <tbody>
              <tr><td>1数字</td><td>35対1</td></tr>
              <tr><td>2数字</td><td>17対1</td></tr>
              <tr><td>4数字</td><td>8対1</td></tr>
              <tr><td>1～12・13～24・25～36</td><td>2対1</td></tr>
              <tr><td>赤黒・奇偶・1～18・19～36</td><td>1対1</td></tr>
            </tbody>
          </table>
          <p class="rules-foot">例：1数字へ1,000銭賭けて当たると、元の銭を含めて36,000銭受け取ります。結果の＋／－は、その勝負で増減した所持銭です。</p>
        </section>
      </div>`;
    const done=document.createElement("button");
    done.className="paper-button";
    done.textContent="賭場へ戻る";
    done.addEventListener("click",closeModal);
    foot.appendChild(done);
  }
  function renderSettings(){
    const body=$("modal-body"),foot=$("modal-footer");body.replaceChildren();foot.replaceChildren();
    const menu=document.createElement("div");menu.className="operations-menu";
    const top=document.createElement("div");top.className="operations-top";
    function amount(label,value){
      const card=document.createElement("div");card.className="operations-amount";
      const title=document.createElement("span");title.textContent=label;
      const number=document.createElement("strong");number.textContent=fmt(value);
      const unit=document.createElement("small");unit.textContent="銭";
      card.append(title,number,unit);return card;
    }
    function button(label,detail,className,action){
      const b=document.createElement("button");b.type="button";b.className=className;
      const title=document.createElement("strong");title.textContent=label;b.appendChild(title);
      if(detail){const desc=document.createElement("small");desc.textContent=detail;b.appendChild(desc)}
      b.addEventListener("click",action);return b;
    }
    const soundToggle=button(state.sound?"音声 ON":"音声 OFF","声・効果音を切り替え","operations-sound",()=>{setSound(!state.sound);renderSettings()});
    soundToggle.setAttribute("aria-pressed",String(state.sound));
    top.append(amount("所持銭",state.balance),amount("賭けた銭",wagerTotal()),soundToggle);
    const middle=document.createElement("div");middle.className="operations-middle";
    const money=button("銭を持って参れ！","所持銭を追加","operations-primary",()=>{addMoney();renderSettings()});
    money.disabled=state.balance>=MAX_BALANCE;
    middle.append(money,button("賭けた銭を変更","盤上の銭を戻す","operations-primary",()=>openModal("bets")));
    const bottom=document.createElement("div");bottom.className="operations-bottom";
    const coins=document.createElement("div");coins.className="operations-coins";
    const heading=document.createElement("strong");heading.textContent="賭け銭の変更";
    const picker=document.createElement("div");picker.className="operations-picker";picker.setAttribute("role","group");picker.setAttribute("aria-label","賭け銭の変更");
    for(const d of DENOMINATIONS){
      const b=document.createElement("button");b.type="button";b.className="operations-coin";b.dataset.chip=String(d);
      b.classList.toggle("selected",selectedChip===d);b.setAttribute("aria-pressed",String(selectedChip===d));b.setAttribute("aria-label",fmt(d)+"銭");
      const image=document.createElement("img");image.src="./assets/coin"+d+".png";image.alt="";
      const label=document.createElement("span");label.textContent=fmt(d)+"銭";b.append(image,label);
      b.addEventListener("click",()=>{selectedChip=d;refresh();sound("select");renderSettings()});picker.appendChild(b);
    }
    coins.append(heading,picker);
    const records=document.createElement("div");records.className="operations-records";
    records.append(
      button("出目帳","直近100回の出目と回数","operations-paper",()=>openModal("ledger")),
      button("遊び方","賭ける範囲と配当を確認","operations-paper",()=>openModal("rules"))
    );
    const back=button("賭場へ戻る","","operations-back",closeModal);
    bottom.append(coins,records,back);menu.append(top,middle,bottom);body.appendChild(menu);
    back.focus();
  }

  function ensureAudio(){
    if(!state.sound)return null;
    try{
      audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
      if(audioCtx.state==="suspended")audioCtx.resume();
      if(!noiseBuffer){
        noiseBuffer=audioCtx.createBuffer(1,Math.round(audioCtx.sampleRate*.12),audioCtx.sampleRate);
        const arr=noiseBuffer.getChannelData(0);let prev=0;for(let i=0;i<arr.length;i++){prev=(prev+Math.random()*2-1)*.48;arr[i]=prev}
      }
      return audioCtx;
    }catch(_){return null}
  }
  function hit(pitch=650,volume=.18,duration=.07,delay=0){
    const c=ensureAudio();if(!c)return;
    const t=c.currentTime+delay;
    const osc=c.createOscillator(),g=c.createGain();
    osc.type="triangle";osc.frequency.setValueAtTime(pitch,t);osc.frequency.exponentialRampToValueAtTime(Math.max(45,pitch*.45),t+duration);
    g.gain.setValueAtTime(Math.max(.0001,volume),t);g.gain.exponentialRampToValueAtTime(.001,t+duration);
    osc.connect(g).connect(c.destination);osc.start(t);osc.stop(t+duration+.02);
    const noise=c.createBufferSource(),filter=c.createBiquadFilter(),nGain=c.createGain();
    noise.buffer=noiseBuffer;filter.type="bandpass";filter.frequency.value=Math.max(300,pitch*2);filter.Q.value=1.2;
    nGain.gain.setValueAtTime(volume*.28,t);nGain.gain.exponentialRampToValueAtTime(.001,t+duration);
    noise.connect(filter).connect(nGain).connect(c.destination);noise.start(t);noise.stop(t+Math.min(.12,duration));
  }
  const fileSfx={
    add:new Audio("./assets/sfx_coins.mp3"),
    win:new Audio("./assets/sfx_win.mp3"),
    lose:new Audio("./assets/sfx_lose.mp3")
  };
  Object.values(fileSfx).forEach(a=>{a.preload="auto";a.volume=.9});
  const betVoices=[
    ["bet_here.mp3",92/7],["bet_go.mp3",92/7],["bet_luck.mp3",92/7],
    ["bet_hmm.mp3",92/7],["bet_chance.mp3",92/7],["bet_good.mp3",92/7],
    ["bet_outcome.mp3",92/7],["bet_coins.mp3",8]
  ].map(([file,weight])=>({audio:new Audio("./assets/voice/"+file),weight}));
  const specialVoices={
    spin:new Audio("./assets/voice/spin_start.mp3"),
    add:new Audio("./assets/voice/add_money.mp3")
  };
  let activeVoice=null;
  for(const audio of [...betVoices.map(v=>v.audio),...Object.values(specialVoices)]){
    audio.preload="auto";audio.volume=1;
    audio.addEventListener("ended",()=>{
      if(activeVoice===audio)activeVoice=null;
      if(audio===specialVoices.spin&&screen==="wheel")$("roulette-audio").volume=.55;
    });
  }
  function stopVoice(){
    if(!activeVoice)return;
    activeVoice.pause();try{activeVoice.currentTime=0}catch(_){}
    activeVoice=null;
  }
  function playVoice(kind,interrupt=false){
    if(!state.sound)return false;
    if(activeVoice&&!activeVoice.paused&&!activeVoice.ended){
      if(!interrupt)return false;
      stopVoice();
    }
    let audio;
    if(kind==="place"){
      let draw=Math.random()*100;
      for(const voice of betVoices){draw-=voice.weight;if(draw<0){audio=voice.audio;break}}
      audio||=betVoices.at(-1).audio;
    }else audio=specialVoices[kind];
    if(!audio)return false;
    try{
      audio.currentTime=0;activeVoice=audio;
      const started=audio.play();
      if(started?.catch)void started.catch(()=>{
        if(activeVoice===audio)activeVoice=null;
        if(audio===specialVoices.spin&&screen==="wheel")$("roulette-audio").volume=.55;
      });
      return true;
    }catch(_){activeVoice=null;return false}
  }
  function playFileSfx(kind){
    if(!state.sound)return false;
    const a=fileSfx[kind];
    if(!a)return false;
    try{
      // The trumpet-heavy victory fanfare is perceptually louder than the other SFX.
      // Keep the source file unchanged and lower only its playback level slightly.
      a.volume=kind==="add"?.48:kind==="win"?.40:.9;
      a.pause();
      a.currentTime=0;
      const p=a.play();
      if(p?.catch)p.catch(()=>{});
      return true;
    }catch(_){return false}
  }
  function stopWinSfx(){
    const a=fileSfx.win;
    if(!a)return;
    try{
      a.pause();
      a.currentTime=0;
    }catch(_){}
  }
  function sound(kind){
    if(!state.sound)return;
    if((kind==="add"||kind==="win"||kind==="lose")&&playFileSfx(kind))return;
    if(kind==="select")hit(1070,.055,.045);
    if(kind==="place"){hit(490,.15,.095);hit(260,.07,.07,.045)}
    if(kind==="cancel")hit(440,.10,.09);
    if(kind==="error")hit(210,.09,.12);
    if(kind==="add")for(let i=0;i<8;i++)hit(440+i*53,.075,.12,i*.055);
    if(kind==="stop"){hit(970,.19,.07);hit(490,.15,.12,.13);hit(270,.12,.17,.32)}
    if(kind==="win")for(let i=0;i<5;i++)hit([392,494,587,784,988][i],.12,.21,i*.10);
    if(kind==="lose"){hit(350,.12,.18);hit(230,.12,.25,.17);hit(165,.11,.32,.38)}
  }
  function playHorn(){
    if(!state.sound)return;
    const player=$("horn-audio");
    if(!player?.play)return;
    try{
      player.pause();
      player.currentTime=0;
      player.volume=1;
      const started=player.play();
      if(started?.catch)void started.catch(()=>{});
    }catch(_){/* Playback can be unavailable on this device. */}
  }
  function playBetEntrance(){
    if(!state.sound)return;
    const player=$("bet-entrance-audio");
    try{
      player.pause();player.currentTime=0;player.volume=1;
      const started=player.play();
      if(started?.catch)void started.catch(()=>{});
    }catch(_){/* Playback can be unavailable on this device. */}
  }
  function startRolling(){
    if(!state.sound)return;
    const sample=$("roulette-audio");
    if(sample?.play){
      try{sample.currentTime=0;sample.volume=activeVoice===specialVoices.spin?.30:.55;const started=sample.play();
        if(started?.then)void started.catch(()=>startRollingSynth());
        return;
      }catch(_){}
    }
    startRollingSynth();
  }
  function startRollingSynth(){
    if(!state.sound||rollSound||spinSettled)return;
    const c=ensureAudio();if(!c)return;
    const source=c.createBufferSource(),filter=c.createBiquadFilter(),gain=c.createGain();
    source.buffer=noiseBuffer;source.loop=true;filter.type="lowpass";filter.frequency.value=900;gain.gain.value=activeVoice===specialVoices.spin?.018:.025;
    source.connect(filter).connect(gain).connect(c.destination);source.start();
    rollSound={source,filter,gain};
  }
  function stopRolling(){
    const sample=$("roulette-audio");if(sample?.pause){sample.pause();try{sample.currentTime=0}catch(_){}}
    if(rollSound){try{rollSound.source.stop()}catch(_){}rollSound=null}
  }
  function setSound(on,quiet=false){
    state.sound=on;save();
    const titleSound=$("title-sound");
    if(titleSound){titleSound.textContent=on?"🔊 音声 ON":"🔇 音声 OFF";titleSound.setAttribute("aria-pressed",String(on))}
    if(!on){stopVoice();stopRolling();$("horn-audio")?.pause?.();$("bet-entrance-audio")?.pause?.()}
    if(on&&!quiet)sound("select");
  }
  function randomPocket(){
    try{
      const random=new Uint32Array(1);
      crypto.getRandomValues(random);
      return Math.floor(random[0]/4294967296*38);
    }catch(_){return Math.floor(Math.random()*38)}
  }
  function setWinningPosition(pocket){
    wheelRotation=winningRotation(wheelRotation,pocket,0);
    ballAngle=TOP_ANGLE;
    ballRadius=BALL_POCKET_R;
    drawWheel();
  }
  function finishNormalSpin(result,total){
    spinSettled=true;
    skipSpinEnabled=false;
    clearTimeout(skipRevealTimer);
    cancelAnimationFrame(spinFrame);
    stopRolling();
    setWinningPosition(winningPocket);
    sound("stop");
    $("skip-spin").hidden=true;
    resultTimer=setTimeout(()=>showResult(result,total),RESULT_DELAY_MS);
  }
  function startSpin(){
    if(screen!=="bet"||!state.wagers.length||modalType)return;

    cancelAnimationFrame(spinFrame);
    clearTimeout(resultTimer);
    clearTimeout(skipRevealTimer);
    spinSettled=false;
    resultShown=false;
    skipSpinEnabled=false;
    winningPocket=randomPocket();
    const result=WHEEL[winningPocket];
    const total=wagerTotal();
    pendingSpin={result,total};

    $("spin-wager").textContent=fmt(total)+"銭";
    const wheel=$("wheel-screen");
    // Step7: do not force the wheel screen active here. Clear only result-state classes;
    // show("wheel") below owns scene activation.
    wheel.classList.remove("result","win","lose","draw");
    $("result-panel").hidden=true;
    document.querySelector(".spin-stake").style.display="none";
    // Prevent the start pointer gesture from also triggering the skip command.
    // The command appears only after the spin has been visible for 550ms.
    $("skip-spin").hidden=true;
    buildWheel();
    show("wheel");
    skipRevealTimer=setTimeout(()=>{
      if(screen!=="wheel"||resultShown||spinSettled||!pendingSpin)return;
      skipSpinEnabled=true;
      $("skip-spin").hidden=false;
    },550);
    playVoice("spin",true);

    const begin=performance.now();
    const duration=9700;
    const from=wheelRotation;
    const to=winningRotation(from,winningPocket,6);
    let lastTick=-1,lastSoundAt=0;
    try{startRolling()}catch(_){stopRolling()}

    const frame=now=>{
      if(spinSettled)return;
      const t=Math.min(1,(now-begin)/duration);
      // Keep the numbered wheel visibly moving until the ball actually drops.
      const wheelEase=1-Math.pow(1-t,1.7);
      wheelRotation=from+(to-from)*wheelEase;

      if(t<NEEDLE_HIT_T){
        const u=t/NEEDLE_HIT_T;
        const orbitEase=1-Math.pow(1-u,2.15);
        ballAngle=TOP_ANGLE-TAU*8*orbitEase;
        ballRadius=BALL_TRACK_R;
      }else{
        // The ball reaches the fixed pointer first, kicks sideways, then falls inward.
        const u=(t-NEEDLE_HIT_T)/(1-NEEDLE_HIT_T);
        const dropEase=u*u*(3-2*u);
        ballAngle=TOP_ANGLE+.075*Math.sin(Math.PI*u);
        ballRadius=BALL_TRACK_R+(BALL_POCKET_R-BALL_TRACK_R)*dropEase;
      }

      if(rollSound)try{
        rollSound.gain.gain.value=.013+.035*(1-t);
        rollSound.filter.frequency.value=250+1300*(1-t);
      }catch(_){stopRolling()}
      drawWheel();

      const tick=Math.floor(normalizeAngle(-ballAngle)/WHEEL_STEP);
      if(tick!==lastTick&&now-lastSoundAt>55&&state.sound){
        try{hit(520+240*(1-t),.085+.04*(1-t),.045+.045*t)}catch(_){}
        lastTick=tick;
        lastSoundAt=now;
      }
      if(t<1)spinFrame=requestAnimationFrame(frame);
      else finishNormalSpin(result,total);
    };
    spinFrame=requestAnimationFrame(frame);
  }
  function skipSpinToResult(){
    if(screen!=="wheel"||!pendingSpin||resultShown||!skipSpinEnabled)return;
    skipSpinEnabled=false;
    clearTimeout(skipRevealTimer);
    const {result,total}=pendingSpin;
    cancelAnimationFrame(spinFrame);
    clearTimeout(resultTimer);
    stopVoice();
    stopRolling();
    spinSettled=true;
    setWinningPosition(winningPocket);
    showResult(result,total);
  }
  window.__rouletteInlineSkip=function(event){
    if(event){
      event.preventDefault();
      event.stopPropagation();
    }
    skipSpinToResult();
    return false;
  };

  function showResult(result,total){
    if(resultShown)return;
    resultShown=true;
    spinSettled=true;
    // Keep one physical press from advancing through both the result screen
    // and the newly revealed "次の勝負へ" button.
    resultNextUnlockAt=performance.now()+550;
    skipSpinEnabled=false;
    clearTimeout(skipRevealTimer);
    pendingSpin=null;
    $("skip-spin").hidden=true;
    clearTimeout(resultTimer);
    cancelAnimationFrame(spinFrame);
    stopRolling();
    let payout=0,hitCoins=0,missCoins=0;
    for(const w of state.wagers){
      const def=betDefs.get(w.key);
      const won=def.numbers.includes(String(result));
      const pieces=DENOMINATIONS.reduce((sum,d)=>sum+(w.coins?.[d]||0),0);
      if(won){
        payout+=w.stake*(def.odds+1);
        hitCoins+=pieces;
      }else{
        missCoins+=pieces;
      }
    }
    const before=state.balance+total;
    state.balance=Math.min(MAX_BALANCE,state.balance+payout);
    const net=state.balance-before;
    state.history.unshift(result);state.history.length=Math.min(state.history.length,100);state.wagers=[];save();
    const grossNet=payout-total;
    const kind=grossNet>0?"win":grossNet<0?"lose":"draw";
    const wheel=$("wheel-screen");
    wheel.classList.remove("result","win","lose","draw");
    wheel.classList.add("result",kind);
    buildWheel();
    drawWheel();
    const resultColor=color(result);
    const resultColorText=resultColor==="green"?"緑":resultColor==="red"?"赤":"黒";
    const resultMark=resultColor==="green"?"▲":resultColor==="red"?"●":"◆";
    $("result-number").innerHTML=
      '<span class="result-ball '+resultColor+'">'+result+'</span>'+
      '<span class="result-color '+resultColor+'"><b>'+resultMark+'</b> '+resultColorText+'</span>';
    $("result-title").textContent=kind==="win"?"勝利！":kind==="lose"?"無念・・・":"勝負つかず";
    $("result-net").textContent=(net>0?"+":net<0?"−":grossNet>0?"+":"±")+fmt(Math.abs(net))+"銭";
    const countKind=hitCoins>missCoins?"win":hitCoins<missCoins?"lose":"draw";
    const countVerdict=countKind==="win"?"勝ち戦":countKind==="lose"?"負け戦":"分け";
    const countLine=$("result-counts");
    countLine.textContent="的中："+hitCoins+"枚　外れ："+missCoins+"枚　"+countVerdict;
    countLine.className="result-counts "+countKind;
    $("result-balance").textContent=fmt(state.balance)+(grossNet>0&&net<grossNet?"（上限）":"");
    $("result-panel").hidden=false;
    document.querySelector(".spin-stake").style.display="none";
    sound(kind==="win"?"win":"lose");
    $("result-coin-rain").replaceChildren();
    if(kind==="win"){
      burstVictoryCoins($("result-coin-rain"));
    }
    drawWheel();
    $("next-round").focus({preventScroll:true});

    // Step 1 of the next-round cleanup: use the real button plus the existing
    // live-coordinate window fallback. Do not create a fixed transparent hitbox.
  }
  function normalizeAngle(angle){
    return ((angle % TAU) + TAU) % TAU;
  }
  function winningRotation(from,pocket,extraTurns){
    const pocketCenter=TOP_ANGLE+POCKET_PHASE+pocket*WHEEL_STEP;
    const aligned=TOP_ANGLE-pocketCenter;
    return from+extraTurns*TAU+normalizeAngle(aligned-from);
  }
  function drawWheel(){
    const disk=$("wheel-turn"),ball=$("wheel-ball");
    if(!disk||!ball)return;
    disk.setAttribute("transform",`rotate(${wheelRotation*180/Math.PI} ${WHEEL_CENTER} ${WHEEL_CENTER})`);
    ball.setAttribute("cx",String(WHEEL_CENTER+Math.cos(ballAngle)*ballRadius));
    ball.setAttribute("cy",String(WHEEL_CENTER+Math.sin(ballAngle)*ballRadius));
  }
  function buildWheel(){
    const svg=$("wheel-svg"),ns="http://www.w3.org/2000/svg";
    svg.replaceChildren();
    const node=(tag,attrs,parent=svg)=>{
      const el=document.createElementNS(ns,tag);
      for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));
      parent.appendChild(el);
      return el;
    };
    const defs=node("defs",{});

    const polar=(radius,angle)=>({
      x:(WHEEL_CENTER+Math.cos(angle)*radius).toFixed(2),
      y:(WHEEL_CENTER+Math.sin(angle)*radius).toFixed(2)
    });
    const annulusPath=(outer,inner)=>[
      `M ${WHEEL_CENTER-outer} ${WHEEL_CENTER}`,
      `a ${outer} ${outer} 0 1 0 ${outer*2} 0`,
      `a ${outer} ${outer} 0 1 0 ${-outer*2} 0`,
      `M ${WHEEL_CENTER-inner} ${WHEEL_CENTER}`,
      `a ${inner} ${inner} 0 1 1 ${inner*2} 0`,
      `a ${inner} ${inner} 0 1 1 ${-inner*2} 0`
    ].join(" ");
    const ringSectorPath=(outer,inner,start,end)=>{
      const outerStart=polar(outer,start), outerEnd=polar(outer,end);
      const innerEnd=polar(inner,end), innerStart=polar(inner,start);
      return [
        `M ${outerStart.x} ${outerStart.y}`,
        `A ${outer} ${outer} 0 0 1 ${outerEnd.x} ${outerEnd.y}`,
        `L ${innerEnd.x} ${innerEnd.y}`,
        `A ${inner} ${inner} 0 0 0 ${innerStart.x} ${innerStart.y}`,
        "Z"
      ].join(" ");
    };

    const outerClip=node("clipPath",{id:"wheel-fixed-outer-clip"},defs);
    node("path",{d:annulusPath(249,FRAME_INNER_R),"clip-rule":"evenodd","fill-rule":"evenodd"},outerClip);
    const innerArtClip=node("clipPath",{id:"wheel-inner-art-clip"},defs);
    node("path",{d:annulusPath(INNER_ART_OUTER_R,INNER_ART_INNER_R),"clip-rule":"evenodd","fill-rule":"evenodd"},innerArtClip);

    const gold=node("radialGradient",{id:"wheel-gold",cx:"36%",cy:"28%"},defs);
    for(const [offset,col] of [["0%","#fff2c8"],["20%","#efcd7f"],["46%","#bd7d2f"],["72%","#744016"],["100%","#2a1309"]])node("stop",{offset,"stop-color":col},gold);
    const hubSheen=node("radialGradient",{id:"wheel-hub-sheen",cx:"32%",cy:"28%"},defs);
    for(const [offset,col] of [["0%","#fff7d8"],["24%","#f3d686"],["58%","#c48a2e"],["84%","#7a4314"],["100%","#34180b"]])node("stop",{offset,"stop-color":col},hubSheen);
    const blueBall=node("radialGradient",{id:"wheel-ball-blue",cx:"32%",cy:"28%"},defs);
    for(const [offset,col] of [["0%","#ffffff"],["26%","#dff8ff"],["56%","#74d6ff"],["82%","#1187cb"],["100%","#0a4167"]])node("stop",{offset,"stop-color":col},blueBall);
    const trackMetal=node("radialGradient",{id:"wheel-track-metal",cx:"50%",cy:"50%",r:"56%"},defs);
    for(const [offset,col] of [["0%","#55595d"],["58%","#3f4347"],["100%","#24272a"]])node("stop",{offset,"stop-color":col},trackMetal);

    const imageAttrs={
      href:"./assets/wheel_nobunaga_spin.png",
      x:WHEEL_IMAGE_X,y:WHEEL_IMAGE_Y,width:500,height:500,
      preserveAspectRatio:"xMidYMid meet"
    };

    node("image",{...imageAttrs,"clip-path":"url(#wheel-fixed-outer-clip)"});

    const disk=node("g",{id:"wheel-turn"});
    // Only the lacquer/spoke artwork comes from the source image. Functional rings
    // are SVG, so the fixed frame can never appear twice and all rotating rings
    // share one exact mathematical center.
    node("path",{d:annulusPath(INNER_ART_OUTER_R,INNER_ART_INNER_R),fill:"#080706","fill-rule":"evenodd"},disk);
    node("image",{...imageAttrs,"clip-path":"url(#wheel-inner-art-clip)"},disk);
    node("path",{
      d:annulusPath(TRACK_OUTER_R,TRACK_INNER_R),
      fill:"url(#wheel-track-metal)",
      stroke:"#b89050",
      "stroke-width":1.1,
      "fill-rule":"evenodd"
    },disk);
    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:216,fill:"none",stroke:"#8b6031","stroke-width":4},disk);
    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:157,fill:"none",stroke:"#8b6031","stroke-width":5},disk);
    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:111,fill:"none",stroke:"#8b6031","stroke-width":2},disk);

    for(let i=0;i<WHEEL.length;i++){
      const center=TOP_ANGLE+POCKET_PHASE+i*WHEEL_STEP;
      const lo=center-WHEEL_STEP/2;
      const hi=center+WHEEL_STEP/2;
      const n=WHEEL[i];
      const bandColor=color(n)==="green"?"#08765a":color(n)==="red"?"#b7202c":"#17181a";
      node("path",{
        d:ringSectorPath(POCKET_OUTER_R,POCKET_INNER_R,lo,hi),
        fill:"#44291d",
        stroke:"#d8a74e",
        "stroke-width":1.1
      },disk);
      node("path",{
        d:ringSectorPath(NUMBER_OUTER_R,NUMBER_INNER_R,lo,hi),
        fill:bandColor,
        stroke:"#d8a74e",
        "stroke-width":1.05
      },disk);
      const tx=WHEEL_CENTER+Math.cos(center)*NUMBER_TEXT_R;
      const ty=WHEEL_CENTER+Math.sin(center)*NUMBER_TEXT_R;
      const text=node("text",{
        x:tx.toFixed(2),y:ty.toFixed(2),fill:"#fff4dc",
        "font-family":"Georgia,serif","font-size":n==="00"?12.8:15.4,"font-weight":700,
        "text-anchor":"middle","dominant-baseline":"central",
        transform:`rotate(${center*180/Math.PI+90} ${tx.toFixed(2)} ${ty.toFixed(2)})`,
        style:"text-shadow:0 1px 1px #000"
      },disk);
      text.textContent=n;
    }

    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:HUB_OUTER_R,fill:"url(#wheel-hub-sheen)",stroke:"#6a3c16","stroke-width":2.2});
    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:HUB_RING_R,fill:"none",stroke:"#f4d78a","stroke-width":1.2,opacity:".8"});
    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:HUB_CORE_R,fill:"url(#wheel-gold)",stroke:"#6b3913","stroke-width":1.2});
    node("circle",{cx:WHEEL_CENTER,cy:WHEEL_CENTER,r:3.2,fill:"#fff7d2",stroke:"#6b3913","stroke-width":0.9});

    const pointer=node("g",{id:"wheel-pointer"});
    node("path",{d:"M 250 63 L 240 29 L 260 29 Z",fill:"url(#wheel-gold)",stroke:"#45210d","stroke-width":2.5},pointer);
    node("circle",{cx:250,cy:28,r:3.7,fill:"#f2cf86",stroke:"#563016","stroke-width":1.2},pointer);
    node("circle",{
      id:"wheel-ball",cx:250,cy:250-BALL_TRACK_R,r:9,fill:"url(#wheel-ball-blue)",
      stroke:"#08395b","stroke-width":1.8,
      style:"filter:drop-shadow(0px 3px 4px rgba(0,0,0,.52))"
    });
  }
  function bind(){
    const requestGameFullscreen=()=>{
      const game=$("game");
      try{
        if(document.fullscreenElement||document.webkitFullscreenElement)return;
        const request=game.requestFullscreen||game.webkitRequestFullscreen;
        if(!request)return;
        const started=request.call(game);
        if(started?.catch)void started.catch(()=>{});
      }catch(_){}
    };
    const enterBet=()=>{
      show("bet");
      playBetEntrance();
      requestGameFullscreen();
    };
    const enterStory=()=>{
      show("story");
      playHorn();
      requestGameFullscreen();
    };
    $("enter-bet").onclick=enterBet;$("enter-story").onclick=enterStory;
    $("title-sound").onclick=()=>setSound(!state.sound);
    $("story-to-bet").onclick=enterBet;$("story-to-title").onclick=()=>show("title");
    $("go-story").onclick=enterStory;
    $("open-bets").onclick=()=>openModal("bets");$("open-settings").onclick=()=>openModal("settings");
    $("open-operations").onclick=()=>openModal("settings");
    $("bet-to-title").onclick=()=>{refundAll();show("title")};
    $("modal-backdrop").addEventListener("click",e=>{if(e.target===$("modal-backdrop"))closeModal()});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&modalType)closeModal()});
    document.querySelectorAll("[data-chip]").forEach(b=>b.onclick=()=>{selectedChip=+b.dataset.chip;refresh();sound("select")});
    $("add-money").onclick=addMoney;
    const startButton=$("start-spin");
    // Step13: use the normal click event for the roulette start button.
    startButton.onclick=e=>{
      e.preventDefault();
      e.stopPropagation();
      startSpin();
    };
    $("number-area").addEventListener("click",placeOnGridLine,false);
    // v17.2: the visible command button calls the skip route directly
    // from its inline onclick. Keep this path independent from addEventListener.
    $("roulette-audio").addEventListener("ended",()=>{if(screen==="wheel"&&!spinSettled)startRollingSynth()});
    const goNextRound=()=>{
      if(performance.now()<resultNextUnlockAt)return false;
      if(screen!=="wheel" || $("result-panel").hidden)return false;
      stopWinSfx();
      $("result-coin-rain").replaceChildren();

      const spinStake=document.querySelector(".spin-stake");
      if(spinStake)spinStake.style.display="none";
      skipSpinEnabled=false;
      clearTimeout(skipRevealTimer);
      $("skip-spin").hidden=true;
      $("result-panel").hidden=true;

      // Use the common screen transition. Do not leave inline display:none on
      // the wheel screen, or the next spin can leave every screen invisible.
      show("bet");
      // Result-screen exit keeps a short 550ms guard; bet-screen input remains immediate.
      renderBets();
      return true;
    };

    const nextRound=$("next-round");
    const fireNext=e=>{
      if(e){
        e.preventDefault();
        e.stopPropagation();
        if(e.stopImmediatePropagation)e.stopImmediatePropagation();
      }
      goNextRound();
      return false;
    };

    // Step4: use the normal click event only.
    nextRound.onclick=fireNext;

    window.addEventListener("resize",()=>{if(screen==="wheel")requestAnimationFrame(drawWheel)});
    document.addEventListener("visibilitychange",()=>{if(document.hidden)stopRolling()});
  }
  function webMcp(){
    const context=document.modelContext;if(!context?.registerTool)return;
    try {
      void Promise.resolve(context.registerTool({
        name:"read_roulette_game",title:"お忍び賭場の状態を見る",
        description:"現在の所持銭、賭け、最近の出目を読み取る。",
        inputSchema:{type:"object",properties:{},additionalProperties:false},
        annotations:{readOnlyHint:true},
        execute(){return {balance:state.balance,wagers:state.wagers.map(w=>({...w,label:betDefs.get(w.key).label})),lastResults:state.history.slice(0,10),screen}}
      })).catch(()=>{});
      void Promise.resolve(context.registerTool({
        name:"place_roulette_wager",title:"銭を置く",
        description:"指定した賭け位置へ100、1000、10000銭を置き、画面と所持銭を更新する。",
        inputSchema:{type:"object",properties:{key:{type:"string"},amount:{type:"integer",enum:[100,1000,10000]}},required:["key","amount"],additionalProperties:false},
        annotations:{readOnlyHint:false},
        execute(input){
          if(!betDefs.has(input.key)||![100,1000,10000].includes(input.amount))throw Error("無効な賭け位置または銭です");
          if(state.balance<input.amount)throw Error("所持銭が足りません");
          if(screen!=="bet"||modalType)throw Error("賭け画面を開いてください");
          selectedChip=input.amount;place(input.key);return {balance:state.balance,wagerTotal:wagerTotal()}
        }
      })).catch(()=>{});
    }catch(_){}
  }
  load();buildBoard();buildWheel();bind();refresh();setSound(state.sound,true);show("title");webMcp();
})();
