/* ═══════════════════════════════════════════════════════════════
   CHINESE CHECKERS ONLINE — CLIENT ENGINE
   Board coords: (r,c) double-width. r∈[0,16], c varies by row.
   Neighbours: same-row |dc|=2  |  adjacent rows |dr|=1,|dc|=1
═══════════════════════════════════════════════════════════════ */
'use strict';

// ── Board constants (mirror of server) ──────────────────────────
const ROW_SIZES  = [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1];
const ROW_STARTS = [12,11,10,9,0,1,2,3,4,3,2,1,0,9,10,11,12];

const VALID = new Set();
for(let r=0;r<17;r++)
  for(let i=0;i<ROW_SIZES[r];i++)
    VALID.add(ck(r, ROW_STARTS[r]+i*2));

function ck(r,c){return r*100+c;}
function isCell(r,c){return VALID.has(ck(r,c));}
function neighbours(r,c){
  const out=[];
  for(const [dr,dc] of [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]])
    if(isCell(r+dr,c+dc)) out.push({r:r+dr,c:c+dc});
  return out;
}

function validSingleSteps(board, r, c){
  const dests=[];
  for (const n of neighbours(r,c))
    if (board[ck(n.r,n.c)]===undefined) dests.push(n);
  return dests;
}

function validSingleJumps(board, r, c){
  const res=[];
  for(const [dr,dc] of [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]]){
    let d = 1;
    while(isCell(r+d*dr, c+d*dc) && board[ck(r+d*dr, c+d*dc)]===undefined) d++;
    if(!isCell(r+d*dr, c+d*dc)) continue; // hit edge or empty void

    const lr = r+2*d*dr, lc = c+2*d*dc;
    if(!isCell(lr,lc) || board[ck(lr,lc)]!==undefined) continue;

    let valid = true;
    for(let k = d+1; k < 2*d; k++){
      if(board[ck(r+k*dr, c+k*dc)]!==undefined){ valid = false; break; }
    }
    if(valid) res.push({r:lr, c:lc});
  }
  return res;
}

// ── Player colour palette ────────────────────────────────────────
const P_COLORS=[
  {main:'#e74c3c',light:'#ff8080',dark:'#a33',name:'Red'},
  {main:'#4a90e2',light:'#80b4ff',dark:'#2a5fa0',name:'Blue'},
  {main:'#2ecc71',light:'#7ef0a8',dark:'#1a8a4a',name:'Green'},
  {main:'#f1c40f',light:'#ffe060',dark:'#b89000',name:'Yellow'},
  {main:'#a855f7',light:'#d09aff',dark:'#6c24b0',name:'Purple'},
  {main:'#f97316',light:'#ffaa60',dark:'#b55010',name:'Orange'},
];

// ── Global state ─────────────────────────────────────────────────
const G = {
  socket: null,
  screen: 'menu',          // menu | lobby | game
  myId: '',
  myName: '',
  myIdx: -1,
  isHost: false,
  isSpec: false,
  roomCode: '',
  players: [],
  settings: {maxPlayers:2,timerEnabled:true,timerSeconds:30},

  board: {},               // { ck: playerIdx+1 }
  turn: 0,
  myTurn: false,
  midTurnPiece: null,
  selectedR: -1,
  selectedC: -1,
  highlights: [],          // [{r,c}]

  // camera
  cam: {x:0,y:0,zoom:1},
  dragging: false,
  dragLast: {x:0,y:0},

  // animation
  anim: null,              // active marble animation
  animQueue: [],
  gameTime: 0,

  // timer
  timerLeft: 0,
  timerMax: 30,
  timerRunning: false,
  timerInterval: null,

  // audio
  audioCtx: null,
  audioEnabled: true,
};

// ── Canvas setup ─────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas(){
  const wrap = document.getElementById('canvas-wrap');
  const dpr = window.devicePixelRatio||1;
  canvas.width  = wrap.clientWidth  * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

function logicalW(){ return canvas.width  / (window.devicePixelRatio||1); }
function logicalH(){ return canvas.height / (window.devicePixelRatio||1); }

// Step = spacing between holes in pixels (computed from canvas size)
function getStep(){
  const margin=70;
  const usableW = logicalW()-margin*2;
  const usableH = logicalH()-margin*2;
  const sW = usableW/12;
  const sH = usableH/(16*Math.sqrt(3)/2);
  return Math.min(sW,sH,52);
}

// Board → pixel  (world coords, camera applied separately)
function cell2px(r,c){
  const S=getStep(), H=S*Math.sqrt(3)/2;
  return {x:(c-12)*S/2, y:(r-8)*H};
}

// Screen → world
function screen2world(sx,sy){
  const {x:cx,y:cy,zoom}=G.cam;
  return {x:(sx-logicalW()/2-cx)/zoom, y:(sy-logicalH()/2-cy)/zoom};
}

// World → nearest cell
function world2cell(wx,wy){
  const S=getStep(), H=S*Math.sqrt(3)/2;
  const approxR=(wy)/H+8;
  const r0=Math.max(0,Math.floor(approxR-1));
  const r1=Math.min(16,Math.ceil(approxR+1));
  let best=null, bestD=Infinity;
  for(let r=r0;r<=r1;r++){
    const st=ROW_STARTS[r], sz=ROW_SIZES[r];
    for(let i=0;i<sz;i++){
      const c=st+i*2;
      const p=cell2px(r,c);
      const d=Math.hypot(wx-p.x, wy-p.y);
      if(d<bestD){bestD=d;best={r,c};}
    }
  }
  return bestD<S*0.65 ? best : null;
}

// ═══════════════════════════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════════════════════════

function applyCamera(fn){
  ctx.save();
  ctx.translate(logicalW()/2+G.cam.x, logicalH()/2+G.cam.y);
  ctx.scale(G.cam.zoom, G.cam.zoom);
  fn();
  ctx.restore();
}

// Draw the hexagram shaped board background
function drawBoardBg(){
  const S=getStep();
  const outerR=S*4*Math.sqrt(3)+S*0.3;
  const innerR=S*4+S*0.2;

  ctx.beginPath();
  for(let i=0;i<6;i++){
    const oa=(-90+i*60)*Math.PI/180;
    const ia=(-60+i*60)*Math.PI/180;
    const ox=outerR*Math.cos(oa), oy=outerR*Math.sin(oa);
    const ix=innerR*Math.cos(ia), iy=innerR*Math.sin(ia);
    if(i===0) ctx.moveTo(ox,oy); else ctx.lineTo(ox,oy);
    ctx.lineTo(ix,iy);
  }
  ctx.closePath();

  // Outer shadow for 3D board
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 25;
  ctx.shadowOffsetY = 15;

  // Realistic wood gradient fill
  const grad=ctx.createRadialGradient(0,-outerR*0.3,0,0,0,outerR*1.1);
  grad.addColorStop(0,'#5c321b');
  grad.addColorStop(0.5,'#401e0e');
  grad.addColorStop(1,'#260f06');
  ctx.fillStyle=grad;
  ctx.fill();
  ctx.restore(); // remove shadow for inner drawing

  // Curved realistic wood grain lines
  ctx.save(); ctx.clip();
  for(let i=0;i<50;i++){
    const y=-outerR+i*(outerR*2/50);
    ctx.beginPath(); ctx.moveTo(-outerR,y);
    ctx.bezierCurveTo(-outerR*0.5, y+Math.sin(i)*20, outerR*0.5, y-Math.cos(i)*20, outerR, y);
    ctx.strokeStyle=`rgba(0,0,0,${0.03+(i%3)*0.02})`;
    ctx.lineWidth=1.5+(i%2); ctx.stroke();
    // Light grain
    ctx.beginPath(); ctx.moveTo(-outerR,y+2);
    ctx.bezierCurveTo(-outerR*0.5, y+2+Math.sin(i)*20, outerR*0.5, y+2-Math.cos(i)*20, outerR, y+2);
    ctx.strokeStyle=`rgba(200,120,60,${0.02+(i%2)*0.01})`;
    ctx.lineWidth=1; ctx.stroke();
  }
  ctx.restore();

  // 3D Bevel Edges
  ctx.lineWidth=4;
  ctx.strokeStyle='rgba(255,255,255,0.06)';
  ctx.stroke();
  ctx.lineWidth=2;
  ctx.strokeStyle='rgba(0,0,0,0.6)';
  ctx.stroke();
}

// Subtle zone color tint
function drawZoneTints(){
  if(!G.players.length) return;
  G.players.forEach(pl=>{
    if(pl.zi<0) return;
    const col=P_COLORS[pl.idx];
    const ZONE_DEF=getZoneCells(pl.zi);
    ZONE_DEF.forEach(({r,c})=>{
      const {x,y}=cell2px(r,c);
      const S=getStep();
      ctx.beginPath();
      ctx.arc(x,y,S*0.35,0,Math.PI*2);
      ctx.fillStyle=col.main+'1a'; // much fainter tint
      ctx.fill();
    });
  });
}

// Target zone tint (destination)
function drawTargetTints(){
  if(!G.players.length) return;
  const myPl=G.players.find(p=>p.idx===G.myIdx);
  if(!myPl||myPl.zi<0) return;
  const OPP=[3,4,5,0,1,2];
  const tgtCells=getZoneCells(OPP[myPl.zi]);
  const col=P_COLORS[myPl.idx];
  tgtCells.forEach(({r,c})=>{
    const {x,y}=cell2px(r,c);
    const S=getStep();
    ctx.beginPath();
    ctx.arc(x,y,S*0.3,0,Math.PI*2);
    ctx.fillStyle=col.main+'12';
    ctx.fill();
    ctx.strokeStyle=col.main+'30';
    ctx.lineWidth=1;
    ctx.stroke();
  });
}

// Draw all holes (Realistic recessed look)
function drawHoles(){
  const S=getStep();
  const hR=S*0.28;
  for(let r=0;r<17;r++){
    const st=ROW_STARTS[r],sz=ROW_SIZES[r];
    for(let i=0;i<sz;i++){
      const c=st+i*2;
      const {x,y}=cell2px(r,c);
      
      // Hole body (dark base)
      ctx.beginPath(); ctx.arc(x,y,hR,0,Math.PI*2);
      ctx.fillStyle='#1c0a04'; ctx.fill();
      
      // Inner shadow (dark at top, lighter at bottom)
      const hg = ctx.createLinearGradient(x, y-hR, x, y+hR);
      hg.addColorStop(0, 'rgba(0,0,0,0.9)');
      hg.addColorStop(1, 'rgba(0,0,0,0.1)');
      ctx.fillStyle = hg; ctx.fill();
      
      // Outer rim top dark shadow
      ctx.beginPath(); ctx.arc(x,y,hR,0,Math.PI*2);
      ctx.strokeStyle='rgba(0,0,0,0.6)'; ctx.lineWidth=2.5; ctx.stroke();
      
      // Outer rim bottom highlight for 3D inset effect
      ctx.beginPath(); ctx.arc(x,y+1.5,hR,0,Math.PI*2);
      ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=1.5; ctx.stroke();
    }
  }
}

// Draw highlights for valid moves
function drawHighlights(){
  if(!G.highlights.length) return;
  const S=getStep();
  const t=G.gameTime;
  const pulse=0.5+0.5*Math.sin(t*5);

  G.highlights.forEach(({r,c})=>{
    const {x,y}=cell2px(r,c);
    // Glow ring
    const alpha=0.4+0.45*pulse;
    ctx.beginPath(); ctx.arc(x,y,S*0.4,0,Math.PI*2);
    ctx.strokeStyle=`rgba(255,215,0,${alpha})`;
    ctx.lineWidth=2+pulse;
    ctx.stroke();
    // Dot
    ctx.beginPath(); ctx.arc(x,y,S*0.15,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,215,0,${0.5+0.4*pulse})`;
    ctx.fill();
  });

  // Highlight selected cell
  if(G.selectedR>=0){
    const {x,y}=cell2px(G.selectedR,G.selectedC);
    ctx.beginPath(); ctx.arc(x,y,S*0.42,0,Math.PI*2);
    ctx.strokeStyle=`rgba(255,255,255,${0.6+0.4*pulse})`;
    ctx.lineWidth=2.5;
    ctx.stroke();
  }
}

// Draw glass marble
function drawMarble(x,y,radius,colObj,scale=1,alpha=1){
  const r=radius*scale;
  ctx.save();
  ctx.globalAlpha=alpha;
  // Shadow
  ctx.beginPath(); ctx.arc(x+r*.15,y+r*.2,r*.9,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fill();
  // Main sphere gradient (glass look)
  const g=ctx.createRadialGradient(x-r*.35,y-r*.38,r*.05,x,y,r);
  g.addColorStop(0,colObj.light);
  g.addColorStop(0.45,colObj.main);
  g.addColorStop(1,colObj.dark);
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
  ctx.fillStyle=g; ctx.fill();
  // Specular highlight
  ctx.beginPath(); ctx.arc(x-r*.28,y-r*.32,r*.22,0,Math.PI*2);
  ctx.fillStyle='rgba(255,255,255,0.65)'; ctx.fill();
  // Smaller secondary highlight
  ctx.beginPath(); ctx.arc(x-r*.12,y-r*.14,r*.1,0,Math.PI*2);
  ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.fill();
  // Rim
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
  ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=1; ctx.stroke();
  ctx.restore();
}

// Draw all marbles
function drawMarbles(){
  const S=getStep();
  const mR=S*0.36;
  // Get animated marble position so we skip it from static drawing
  const animFrom=G.anim ? G.anim.from : null;

  for(const [keyStr,pi] of Object.entries(G.board)){
    const k=+keyStr;
    const r=Math.floor(k/100), c=k%100;
    if(animFrom&&animFrom.r===r&&animFrom.c===c) continue;
    // Skip destination during animation too
    if(G.anim&&G.anim.r===r&&G.anim.c===c) continue;

    const {x,y}=cell2px(r,c);
    const col=P_COLORS[(pi-1)%6];
    // Bounce scale for landing
    const landKey=ck(r,c);
    const bScale=G.landScales&&G.landScales[landKey]||1;
    drawMarble(x,y,mR,col,bScale);
  }
}

// Draw animated marble
function drawAnimMarble(){
  if(!G.anim) return;
  const S=getStep();
  const mR=S*0.36;
  const {x,y}=G.anim.getPos();
  const col=P_COLORS[(G.anim.pi-1)%6];
  drawMarble(x,y,mR,col,1);
}

// Main render
function render(){
  const W=logicalW(), H=logicalH();
  ctx.clearRect(0,0,W,H);

  if(G.screen!=='game') return;

  applyCamera(()=>{
    drawBoardBg();
    drawZoneTints();
    drawTargetTints();
    drawHoles();
    drawHighlights();
    drawMarbles();
    drawAnimMarble();
  });
}

// ═══════════════════════════════════════════════════════════════
//  ANIMATION SYSTEM
// ═══════════════════════════════════════════════════════════════

class MarbleAnim{
  constructor(path, pi, onDone){
    this.path=path;     // [{r,c}, ...]
    this.pi=pi;
    this.onDone=onDone;
    this.hop=0;
    this.t=0;
    this.hopDur=0.32;   // seconds per hop
    this.done=false;
    // Keep "from" for skip-draw
    this.from=path[0];
    this.r=path[path.length-1].r;
    this.c=path[path.length-1].c;
    G.landScales=G.landScales||{};
  }
  update(dt){
    this.t+=dt/this.hopDur;
    if(this.t>=1){
      this.t=0; this.hop++;
      playClack();
      if(this.hop>=this.path.length-1){
        this.done=true;
        // Landing bounce
        const dest=this.path[this.path.length-1];
        startLandBounce(dest.r,dest.c);
        if(this.onDone) this.onDone();
      }
    }
  }
  getPos(){
    const a=this.path[this.hop], b=this.path[this.hop+1]||a;
    const pa=cell2px(a.r,a.c), pb=cell2px(b.r,b.c);
    const e=easeInOut(this.t);
    const x=pa.x+(pb.x-pa.x)*e;
    const y=pa.y+(pb.y-pa.y)*e;
    // Parabolic arc
    const S=getStep();
    const arc=S*1.4*Math.sin(this.t*Math.PI);
    return {x, y:y-arc};
  }
}

function easeInOut(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}

function startLandBounce(r,c){
  const k=ck(r,c);
  G.landScales[k]=1.25;
  let elapsed=0;
  const DURATION=0.35;
  const bounce=()=>{
    elapsed+=0.016;
    const t=Math.min(elapsed/DURATION,1);
    G.landScales[k]=1+0.25*Math.sin(t*Math.PI);
    if(t<1) requestAnimationFrame(bounce);
    else delete G.landScales[k];
  };
  requestAnimationFrame(bounce);
}

function playAnimation(path,pi,onDone){
  G.anim=new MarbleAnim(path,pi,()=>{
    G.anim=null;
    if(onDone) onDone();
  });
}

// ═══════════════════════════════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════════════════════════════

function initAudio(){
  try{ G.audioCtx=new(window.AudioContext||window.webkitAudioContext)(); }
  catch(e){ G.audioEnabled=false; }
}

function playClack(){
  if(!G.audioEnabled||!G.audioCtx) return;
  try{
    const osc=G.audioCtx.createOscillator();
    const gain=G.audioCtx.createGain();
    const now=G.audioCtx.currentTime;
    osc.connect(gain); gain.connect(G.audioCtx.destination);
    osc.type='sine';
    osc.frequency.setValueAtTime(900,now);
    osc.frequency.exponentialRampToValueAtTime(250,now+0.08);
    gain.gain.setValueAtTime(0.4,now);
    gain.gain.exponentialRampToValueAtTime(0.001,now+0.12);
    osc.start(now); osc.stop(now+0.12);
  }catch(e){}
}

function playUIClick(){
  if(!G.audioEnabled||!G.audioCtx) return;
  try{
    const osc=G.audioCtx.createOscillator();
    const gain=G.audioCtx.createGain();
    const now=G.audioCtx.currentTime;
    osc.connect(gain); gain.connect(G.audioCtx.destination);
    osc.type='triangle'; osc.frequency.value=600;
    gain.gain.setValueAtTime(0.15,now);
    gain.gain.exponentialRampToValueAtTime(0.001,now+0.06);
    osc.start(now); osc.stop(now+0.06);
  }catch(e){}
}

function playWin(){
  if(!G.audioEnabled||!G.audioCtx) return;
  [261,329,392,523].forEach((f,i)=>{
    try{
      const osc=G.audioCtx.createOscillator();
      const gain=G.audioCtx.createGain();
      osc.connect(gain); gain.connect(G.audioCtx.destination);
      osc.type='triangle'; osc.frequency.value=f;
      const t=G.audioCtx.currentTime+i*0.18;
      gain.gain.setValueAtTime(0.25,t);
      gain.gain.exponentialRampToValueAtTime(0.001,t+0.6);
      osc.start(t); osc.stop(t+0.6);
    }catch(e){}
  });
}

// ═══════════════════════════════════════════════════════════════
//  TIMER
// ═══════════════════════════════════════════════════════════════

function startTimer(seconds){
  stopTimer();
  G.timerLeft=seconds; G.timerMax=seconds; G.timerRunning=true;
  updateTimerUI();
  G.timerInterval=setInterval(()=>{
    G.timerLeft--;
    updateTimerUI();
    if(G.timerLeft<=0){
      stopTimer();
      if(G.myTurn) G.socket.emit('timer-expired');
    }
  },1000);
}

function stopTimer(){
  G.timerRunning=false;
  clearInterval(G.timerInterval);
  G.timerInterval=null;
}

function updateTimerUI(){
  const num=document.getElementById('timer-num');
  const ring=document.getElementById('timer-ring');
  const wrap=document.getElementById('timer-wrap');
  if(!ring||!num) return;
  const frac=Math.max(0,G.timerLeft/G.timerMax);
  const circ=2*Math.PI*18;
  ring.style.strokeDashoffset=(circ*(1-frac)).toFixed(2);
  num.textContent=G.timerLeft;
  const color = frac>0.5?'#5b7fff': frac>0.25?'#f1c40f':'#e74c3c';
  ring.style.stroke=color;
  wrap.classList.toggle('pulsing', G.timerLeft<=10 && G.timerLeft>0);
}

// ═══════════════════════════════════════════════════════════════
//  ZONE HELPER
// ═══════════════════════════════════════════════════════════════

function makeZone(rows,counts,fromRight){
  return rows.flatMap((row,i)=>{
    const cnt=counts[i],st=ROW_STARTS[row],sz=ROW_SIZES[row];
    return Array.from({length:cnt},(_,j)=>({
      r:row,c:fromRight?st+(sz-cnt+j)*2:st+j*2
    }));
  });
}
const ZONES=[
  makeZone([0,1,2,3],   [1,2,3,4], false),
  makeZone([4,5,6,7],   [4,3,2,1], true),
  makeZone([9,10,11,12],[1,2,3,4], true),
  makeZone([13,14,15,16],[4,3,2,1],false),
  makeZone([9,10,11,12],[1,2,3,4], false),
  makeZone([4,5,6,7],   [4,3,2,1], false),
];
function getZoneCells(zi){ return ZONES[zi]||[]; }

// ═══════════════════════════════════════════════════════════════
//  INPUT HANDLING
// ═══════════════════════════════════════════════════════════════

function handleCanvasClick(e){
  if(G.screen!=='game'||G.isSpec||!G.myTurn||G.anim) return;
  if(G.dragging) return;

  const rect=canvas.getBoundingClientRect();
  const sx=(e.clientX-rect.left)*(logicalW()/rect.width);
  const sy=(e.clientY-rect.top )*(logicalH()/rect.height);
  const w=screen2world(sx,sy);
  const cell=world2cell(w.x,w.y);
  if(!cell) { clearSelection(); return; }

  const {r,c}=cell;
  const cellPi=G.board[ck(r,c)];
  const myPi=G.myIdx+1;

  if(G.selectedR>=0){
    // Try to move
    const isHighlit=G.highlights.some(h=>h.r===r&&h.c===c);
    if(isHighlit){
      G.socket.emit('make-move',{from:{r:G.selectedR,c:G.selectedC},to:{r,c}});
      clearSelection();
      return;
    }
    // If mid-turn and we click the active piece again, end the turn!
    if(G.midTurnPiece && r===G.midTurnPiece.r && c===G.midTurnPiece.c){
       G.socket.emit('end-turn');
       clearSelection();
       return;
    }
    // Re-select own marble (only if not mid-turn)
    if(cellPi===myPi && !G.midTurnPiece){ selectCell(r,c); return; }
    if(!G.midTurnPiece) clearSelection();
  } else {
    // Select own marble
    if(cellPi===myPi){
      if(G.midTurnPiece){
         if(r!==G.midTurnPiece.r || c!==G.midTurnPiece.c) return; // restricted
      }
      selectCell(r,c); playUIClick(); 
    }
  }
}

function selectCell(r,c){
  G.selectedR=r; G.selectedC=c;
  if(G.midTurnPiece && r===G.midTurnPiece.r && c===G.midTurnPiece.c){
    G.highlights=validSingleJumps(G.board, r, c);
  } else {
    const mk=ck(r,c), mm=G.board[mk]; delete G.board[mk];
    G.highlights=[...validSingleSteps(G.board,r,c), ...validSingleJumps(G.board,r,c)];
    G.board[mk]=mm;
  }
}

function clearSelection(){ G.selectedR=-1; G.selectedC=-1; G.highlights=[]; }

// Camera — pan
function onPointerDown(e){
  G.dragging=false;
  G.dragLast={x:e.clientX,y:e.clientY};
  canvas.addEventListener('pointermove',onPointerMove);
  canvas.addEventListener('pointerup',onPointerUp,{once:true});
}
function onPointerMove(e){
  const dx=e.clientX-G.dragLast.x, dy=e.clientY-G.dragLast.y;
  if(Math.hypot(dx,dy)>4) G.dragging=true;
  if(G.dragging){ G.cam.x+=dx; G.cam.y+=dy; }
  G.dragLast={x:e.clientX,y:e.clientY};
}
function onPointerUp(e){
  canvas.removeEventListener('pointermove',onPointerMove);
  if(!G.dragging) handleCanvasClick(e);
  setTimeout(()=>G.dragging=false,10);
}

// Camera — zoom
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  const rect=canvas.getBoundingClientRect();
  const sx=(e.clientX-rect.left)*(logicalW()/rect.width);
  const sy=(e.clientY-rect.top )*(logicalH()/rect.height);
  const newZoom=Math.min(Math.max(G.cam.zoom*(e.deltaY<0?1.12:0.892),0.35),5);
  const f=newZoom/G.cam.zoom;
  G.cam.x=(sx-logicalW()/2)*(1-f)+G.cam.x*f;
  G.cam.y=(sy-logicalH()/2)*(1-f)+G.cam.y*f;
  G.cam.zoom=newZoom;
},{passive:false});

canvas.addEventListener('pointerdown',onPointerDown);

// Touch pinch-zoom and prevent defaults
let pinchDist0=0, camZoom0=1;
canvas.addEventListener('touchstart',e=>{
  e.preventDefault();
  if(e.touches.length===2){
    pinchDist0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    camZoom0=G.cam.zoom;
  }
},{passive:false});
canvas.addEventListener('touchmove',e=>{
  if(e.touches.length===2){
    e.preventDefault();
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    G.cam.zoom=Math.min(Math.max(camZoom0*(d/pinchDist0),0.35),5);
  }
},{passive:false});
canvas.addEventListener('touchend',e=>{
  e.preventDefault();
},{passive:false});

// ═══════════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════════

function addChatMsg(container,data){
  const div=document.createElement('div');
  if(data.sys){
    div.className='chat-msg';
    div.innerHTML=`<div class="chat-sys">${esc(data.text)}</div>`;
  } else {
    const col=data.color||'#aaa';
    const time=new Date(data.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    div.className='chat-msg';
    div.innerHTML=`
      <div class="chat-msg-header">
        <span class="chat-dot" style="background:${col}"></span>
        <span class="chat-author" style="color:${col}">${esc(data.name)}</span>
        <span class="chat-time">${time}</span>
      </div>
      <div class="chat-text">${esc(data.msg)}</div>`;
  }
  container.appendChild(div);
  container.scrollTop=container.scrollHeight;
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function setupChat(inputId,sendId,messagesId){
  const input=document.getElementById(inputId);
  const btn=document.getElementById(sendId);
  function send(){
    const msg=input.value.trim();
    if(!msg) return;
    G.socket.emit('chat',{msg});
    input.value='';
  }
  btn.addEventListener('click',send);
  input.addEventListener('keydown',e=>{ if(e.key==='Enter') send(); });
}

// ═══════════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════════

function toast(msg, dur=2800){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), dur);
}

// ═══════════════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>{
    s.classList.toggle('active', s.id==='screen-'+name);
  });
  G.screen=name;
  if(name==='game'){ resizeCanvas(); resetCamera(); }
}

function resetCamera(){ G.cam={x:0,y:0,zoom:1}; }

// ── Lobby UI update ──────────────────────────────────────────
function updateLobbyUI(){
  document.getElementById('room-code-display').textContent=G.roomCode;
  const pList=document.getElementById('player-list');
  pList.innerHTML='';
  G.players.forEach(p=>{
    const li=document.createElement('li');
    const col=P_COLORS[p.idx%6];
    li.innerHTML=`
      <span class="pl-marble" style="background:${col.main};box-shadow:0 0 10px ${col.main}"></span>
      <span class="pl-name">${esc(p.name)}</span>
      ${p.isHost?'<span class="pl-host-badge">HOST</span>':''}`;
    pList.appendChild(li);
  });
  document.getElementById('player-count-display').textContent=`${G.players.length} / ${G.settings.maxPlayers}`;
  const startBtn=document.getElementById('btn-start');
  startBtn.disabled=!G.isHost||G.players.length<2;
  startBtn.textContent=G.isHost?'Start Game':'Waiting for host…';

  // Settings visibility
  document.getElementById('settings-panel').style.display=G.isHost?'':'none';
  // Sync settings controls (host side)
  if(G.isHost){
    document.getElementById('set-maxplayers').value=G.settings.maxPlayers;
    document.getElementById('set-timer').checked=G.settings.timerEnabled;
    document.getElementById('set-timersecs').value=G.settings.timerSeconds;
    document.getElementById('timer-secs-row').style.display=G.settings.timerEnabled?'':'none';
  }
}

// ── HUD update ───────────────────────────────────────────────
function updateHUD(){
  if(!G.players.length) return;
  G.myTurn=(G.players[G.turn]?.idx===G.myIdx)&&!G.isSpec;
  const curPl=G.players[G.turn];
  const tm=document.getElementById('turn-marble');
  const tt=document.getElementById('turn-text');
  if(curPl){
    const col=P_COLORS[curPl.idx%6];
    tm.style.background=col.main;
    tm.style.boxShadow=`0 0 12px ${col.main}`;
    tt.textContent=curPl.idx===G.myIdx?'Your Turn!':curPl.name+"'s Turn";
    tt.style.color=curPl.idx===G.myIdx?'#fff':'#c0c8e8';
  }

  // Player bar
  const bar=document.getElementById('player-bar');
  bar.innerHTML='';
  const activePl=G.players[G.turn];
  G.players.forEach(p=>{
    const col=P_COLORS[p.idx%6];
    const div=document.createElement('div');
    div.className='pb-player'+(activePl&&p.idx===activePl.idx?' active-turn':'');
    div.innerHTML=`<span class="pb-dot" style="background:${col.main};box-shadow:0 0 6px ${col.main}"></span>${esc(p.name)}`;
    bar.appendChild(div);
  });

  const mtControls=document.getElementById('mid-turn-controls');
  if(G.myTurn && G.midTurnPiece) mtControls.style.display='flex';
  else mtControls.style.display='none';
  document.getElementById('spectator-badge').style.display=G.isSpec?'':'none';
}

// ── Confetti ──────────────────────────────────────────────────
function spawnConfetti(color){
  const box=document.getElementById('winner-confetti');
  box.innerHTML='';
  for(let i=0;i<40;i++){
    const d=document.createElement('div');
    d.className='confetti-piece';
    d.style.cssText=`
      left:${Math.random()*100}%;
      background:${['#ffd700','#e74c3c','#4a90e2','#2ecc71','#a855f7',color][Math.floor(Math.random()*6)]};
      animation-delay:${Math.random()*0.8}s;
      animation-duration:${1.5+Math.random()}s;
      border-radius:${Math.random()>0.5?'50%':'3px'};
    `;
    box.appendChild(d);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO CLIENT
// ═══════════════════════════════════════════════════════════════

function initSocket(){
  G.socket=io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  G.socket.on('disconnect', () => {
    toast('⚠ Disconnected! Reconnecting...', 5000);
  });

  G.socket.on('connect_error', () => {
    toast('⚠ Connection lost. Trying to reconnect...', 3000);
  });

  G.socket.on('connect',()=>{
    if(G.myId && G.myId !== G.socket.id) {
       // We reconnected! Auto-rejoin if we were in a room
       if(G.roomCode && G.screen !== 'menu') {
          G.socket.emit('join-room', {code: G.roomCode, name: G.players.find(p=>p.idx===G.myIdx)?.name || 'Player'});
          toast('✅ Reconnected to server!');
       }
    }
    G.myId=G.socket.id;
  });

  G.socket.on('room-created',({code,players,settings})=>{
    G.roomCode=code; G.players=players; G.settings=settings;
    G.isHost=true; G.isSpec=false;
    const me=players.find(p=>p.id===G.myId);
    if(me){ G.myIdx=me.idx; }
    showScreen('lobby'); updateLobbyUI();
  });

  G.socket.on('room-joined',({code,players,settings,spec,gameState})=>{
    G.roomCode=code; G.players=players; G.settings=settings;
    G.isSpec=spec;
    const me=players.find(p=>p.id===G.myId);
    if(me) G.myIdx=me.idx;
    if(spec&&gameState){
      applyGameState(gameState);
      showScreen('game'); updateHUD();
    } else {
      showScreen('lobby'); updateLobbyUI();
    }
  });

  G.socket.on('join-error',({msg})=>{ showModalError(msg); });

  G.socket.on('player-joined',({name,players})=>{
    G.players=players; updateLobbyUI();
    addChatMsg(document.getElementById('lobby-chat-messages'),{sys:true,text:`${esc(name)} joined the lobby.`});
  });

  G.socket.on('player-left',({name,players,newHost})=>{
    G.players=players;
    if(newHost===G.myId){ G.isHost=true; }
    if(G.screen==='lobby') updateLobbyUI();
    else updateHUD();
    const msg=document.getElementById('lobby-chat-messages')||document.getElementById('game-chat-messages');
    if(msg) addChatMsg(msg,{sys:true,text:`${esc(name)} left.`});
  });

  G.socket.on('settings-updated',(settings)=>{
    G.settings=settings; if(G.screen==='lobby') updateLobbyUI();
  });

  G.socket.on('game-started',(state)=>{
    applyGameState(state);
    clearSelection();
    showScreen('game');
    updateHUD();
    if(G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    toast('🎮 Game started!');
  });

  G.socket.on('move-made', data=>{
    G.board=data.board;
    G.turn=data.turn;
    G.midTurnPiece=data.midTurnPiece;
    const isMyTurnNext=G.players[G.turn]?.idx===G.myIdx;
    
    if(data.endTurn && G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    updateHUD();
    
    if(isMyTurnNext && G.midTurnPiece){
       selectCell(G.midTurnPiece.r, G.midTurnPiece.c);
    } else {
       clearSelection();
    }
    
    const pi=data.board[ck(data.to.r, data.to.c)];
    playAnimation(data.path, pi);
  });

  G.socket.on('move-rejected',({reason})=>{ toast('⚠ '+reason); });

  G.socket.on('turn-skipped', data=>{
    if(data.board) G.board=data.board;
    G.turn=data.turn; G.midTurnPiece=null; clearSelection();
    if(G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    toast('Turn skipped (time limit)');
    updateHUD();
  });

  G.socket.on('turn-ended', data=>{
    G.board=data.board; G.turn=data.turn; G.midTurnPiece=null;
    clearSelection(); updateHUD();
    if(G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    if(data.undone) toast('Turn undone.');
  });

  G.socket.on('game-over',({winner,path,from,board})=>{
    G.board=board;
    stopTimer(); clearSelection();
    const pi=G.board[ck(from.r,from.c)]||winner.idx+1;
    playAnimation(path||[from,{r:from.r,c:from.c}],pi,()=>{
      showWinner(winner);
    });
    playWin();
  });

  G.socket.on('sys-msg',({text})=>{
    toast(text,3500);
    const mc=document.getElementById('game-chat-messages');
    if(mc) addChatMsg(mc,{sys:true,text});
  });

  G.socket.on('chat',(data)=>{
    const lc=document.getElementById('lobby-chat-messages');
    const gc=document.getElementById('game-chat-messages');
    if(G.screen==='lobby'&&lc) addChatMsg(lc,data);
    if(G.screen==='game'&&gc)  addChatMsg(gc,data);
  });

  G.socket.on('err',({msg})=>toast('⚠ '+msg,3000));
}

function applyGameState(state){
  G.board=state.board||{};
  G.players=state.players||[];
  G.turn=state.turn||0;
  G.settings=state.settings||G.settings;
  const me=G.players.find(p=>p.id===G.myId);
  if(me) G.myIdx=me.idx;
  G.myTurn=(G.players[G.turn]?.idx===G.myIdx)&&!G.isSpec;
}

function showWinner(winner){
  const col=P_COLORS[winner.idx%6];
  document.getElementById('winner-name').textContent=winner.name+' Wins! 🎉';
  document.getElementById('winner-name').style.cssText=
    `background:linear-gradient(135deg,${col.light},${col.main});-webkit-background-clip:text;-webkit-text-fill-color:transparent`;
  document.getElementById('winner-sub').textContent=`Congratulations to ${winner.name}!`;
  spawnConfetti(col.main);
  document.getElementById('modal-winner').style.display='flex';
}

// ═══════════════════════════════════════════════════════════════
//  MODAL — name / join entry
// ═══════════════════════════════════════════════════════════════

let modalMode='host'; // 'host' | 'join'

function openNameModal(mode){
  modalMode=mode;
  document.getElementById('modal-name-title').textContent=
    mode==='host'?'Create a Room':'Join a Room';
  document.getElementById('modal-join-code-row').style.display=mode==='join'?'':'none';
  document.getElementById('modal-error').textContent='';
  document.getElementById('name-input').value='';
  document.getElementById('code-input').value='';
  document.getElementById('modal-name').style.display='flex';
  setTimeout(()=>document.getElementById('name-input').focus(),50);
}

function showModalError(msg){
  document.getElementById('modal-error').textContent=msg;
}

function closeNameModal(){
  document.getElementById('modal-name').style.display='none';
}

// ═══════════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ═══════════════════════════════════════════════════════════════

function bindUI(){
  // Menu
  document.getElementById('btn-host').addEventListener('click',()=>openNameModal('host'));
  document.getElementById('btn-join').addEventListener('click',()=>openNameModal('join'));

  // Modal confirm
  document.getElementById('modal-confirm').addEventListener('click',()=>{
    const name=document.getElementById('name-input').value.trim()||'Player';
    G.myName=name;
    if(modalMode==='host'){
      G.socket.emit('create-room',{name,maxPlayers:2});
      closeNameModal();
    } else {
      const code=document.getElementById('code-input').value.trim().toUpperCase();
      if(!code){ showModalError('Enter a room code!'); return; }
      G.socket.emit('join-room',{code,name});
      closeNameModal();
    }
  });

  document.getElementById('modal-cancel').addEventListener('click',closeNameModal);
  document.getElementById('name-input').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('modal-confirm').click(); });
  document.getElementById('code-input').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('modal-confirm').click(); });

  // Copy room code
  document.getElementById('btn-copy-code').addEventListener('click',()=>{
    navigator.clipboard.writeText(G.roomCode).then(()=>toast('Room code copied! 📋'));
  });

  // Start game
  document.getElementById('btn-start').addEventListener('click',()=>{
    G.socket.emit('start-game');
  });

  // Leave lobby
  document.getElementById('btn-leave-lobby').addEventListener('click',()=>{
    location.reload();
  });

  // Leave game
  document.getElementById('btn-leave-game').addEventListener('click',()=>{
    document.getElementById('modal-leave').style.display='flex';
  });
  document.getElementById('btn-confirm-leave').addEventListener('click',()=>{
    location.reload();
  });
  document.getElementById('btn-cancel-leave').addEventListener('click',()=>{
    document.getElementById('modal-leave').style.display='none';
  });

  // Mid-turn controls
  document.getElementById('btn-end-turn').addEventListener('click',()=>{
    G.socket.emit('end-turn');
  });
  document.getElementById('btn-undo-turn').addEventListener('click',()=>{
    G.socket.emit('undo-turn');
  });

  // Settings (host only)
  document.getElementById('set-maxplayers').addEventListener('change',e=>{
    G.settings.maxPlayers=+e.target.value;
    G.socket.emit('update-settings',{settings:G.settings});
  });
  document.getElementById('set-timer').addEventListener('change',e=>{
    G.settings.timerEnabled=e.target.checked;
    document.getElementById('timer-secs-row').style.display=e.target.checked?'':'none';
    G.socket.emit('update-settings',{settings:G.settings});
  });
  document.getElementById('set-timersecs').addEventListener('change',e=>{
    G.settings.timerSeconds=+e.target.value;
    G.socket.emit('update-settings',{settings:G.settings});
  });

  // Chat setup
  setupChat('lobby-chat-input','lobby-chat-send','lobby-chat-messages');
  setupChat('game-chat-input','game-chat-send','game-chat-messages');

  // Toggle chat
  document.getElementById('btn-toggle-chat').addEventListener('click',()=>{
    document.getElementById('game-chat').classList.toggle('hidden');
  });
  document.getElementById('btn-close-chat').addEventListener('click',()=>{
    document.getElementById('game-chat').classList.add('hidden');
  });

  // Toggle audio
  document.getElementById('btn-toggle-audio').addEventListener('click',e=>{
    G.audioEnabled=!G.audioEnabled;
    e.currentTarget.textContent=G.audioEnabled?'🔊':'🔇';
    if(G.audioEnabled&&!G.audioCtx) initAudio();
  });

  // Winner modal
  document.getElementById('btn-back-menu').addEventListener('click',()=>location.reload());
  document.getElementById('btn-play-again').addEventListener('click',()=>{
    document.getElementById('modal-winner').style.display='none';
    showScreen('lobby'); updateLobbyUI();
    G.socket.emit('return-to-lobby');
  });

  // Close modal on overlay click
  document.getElementById('modal-name').addEventListener('click',e=>{
    if(e.target===document.getElementById('modal-name')) closeNameModal();
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN GAME LOOP
// ═══════════════════════════════════════════════════════════════

let lastRaf=0;
function gameLoop(ts){
  const dt=Math.min((ts-lastRaf)/1000,0.1);
  lastRaf=ts;
  G.gameTime+=dt;
  if(G.anim){ G.anim.update(dt); if(G.anim?.done) G.anim=null; }
  render();
  requestAnimationFrame(gameLoop);
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════

(function init(){
  resizeCanvas();
  initAudio();
  initSocket();
  bindUI();
  showScreen('menu');
  requestAnimationFrame(gameLoop);
})();
