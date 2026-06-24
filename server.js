'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

// ═══════════════════════════════════════════════════════════════
//  BOARD CONSTANTS
// ═══════════════════════════════════════════════════════════════
// Double-width coordinate system: (row 0-16, col even/odd by row parity)
// Same-row neighbours: |colDiff|=2
// Diagonal neighbours: |rowDiff|=1, |colDiff|=1
const ROW_SIZES  = [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1];
const ROW_STARTS = [12,11,10,9,0,1,2,3,4,3,2,1,0,9,10,11,12];

function ck(r,c){ return r*100+c; }          // unique key (r∈0-16, c∈0-24)

const VALID = new Set();
for (let r=0;r<17;r++)
  for (let i=0;i<ROW_SIZES[r];i++)
    VALID.add(ck(r, ROW_STARTS[r]+i*2));

function isCell(r,c){ return VALID.has(ck(r,c)); }

function neighbours(r,c){
  const out=[];
  for (const [dr,dc] of [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]])
    if (isCell(r+dr,c+dc)) out.push({r:r+dr,c:c+dc});
  return out;
}

// ─── Fast-Paced Symmetrical Jumps ────────────────────────────
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

    // Jumped over a marble at distance d. Symmetrical landing is at 2*d.
    const lr = r+2*d*dr, lc = c+2*d*dc;
    if(!isCell(lr,lc) || board[ck(lr,lc)]!==undefined) continue;

    // Check spaces between d and 2*d
    let valid = true;
    for(let k = d+1; k < 2*d; k++){
      if(board[ck(r+k*dr, c+k*dc)]!==undefined){ valid = false; break; }
    }
    if(valid) res.push({r:lr, c:lc});
  }
  return res;
}

function isForbiddenBase(r, c, zi){
  const k = ck(r,c);
  for(let i=0; i<6; i++){
    if(i !== zi && i !== OPP[zi]){
      if(ZONE_KEYS[i].has(k)) return true;
    }
  }
  return false;
}


// ─── Zone definitions ────────────────────────────────────────
// Zone 0=top  1=top-right  2=bot-right  3=bottom  4=bot-left  5=top-left
function makeZone(rows, counts, fromRight){
  return rows.flatMap((row,i)=>{
    const cnt=counts[i], st=ROW_STARTS[row], sz=ROW_SIZES[row];
    return Array.from({length:cnt},(_,j)=>({
      r:row,
      c: fromRight ? st+(sz-cnt+j)*2 : st+j*2
    }));
  });
}
const ZONES=[
  makeZone([0,1,2,3],   [1,2,3,4], false),   // 0 top
  makeZone([4,5,6,7],   [4,3,2,1], true),     // 1 top-right
  makeZone([9,10,11,12],[1,2,3,4], true),     // 2 bot-right
  makeZone([13,14,15,16],[4,3,2,1],false),    // 3 bottom
  makeZone([9,10,11,12],[1,2,3,4], false),    // 4 bot-left
  makeZone([4,5,6,7],   [4,3,2,1], false),    // 5 top-left
];
const ZONE_KEYS=ZONES.map(z=>new Set(z.map(c=>ck(c.r,c.c))));
const OPP=[3,4,5,0,1,2];

const ZONE_CFG={ 2:[0,3], 3:[0,2,4], 4:[1,2,4,5], 5:[0,1,2,3,4], 6:[0,1,2,3,4,5] };

function initBoard(playerZones){
  const b={};
  playerZones.forEach((zi,pi)=>ZONES[zi].forEach(({r,c})=>{ b[ck(r,c)]=pi+1; }));
  return b;
}

function checkWin(board, pi, zi){
  const tgt=ZONE_KEYS[OPP[zi]];
  for(const k of tgt) if(board[k]!==pi+1) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  SERVER
// ═══════════════════════════════════════════════════════════════
const app=express();
const srv=http.createServer(app);
const io=new Server(srv,{cors:{origin:'*'}});
app.use(express.static(path.join(__dirname,'public')));

const COLORS=['#e74c3c','#4a90e2','#2ecc71','#f1c40f','#a855f7','#f97316'];

const rooms=new Map();
function genCode(){
  const C='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
  do{ code=Array.from({length:6},()=>C[Math.floor(Math.random()*C.length)]).join(''); }
  while(rooms.has(code));
  return code;
}

class Room{
  constructor(code,hostId){
    this.code=code; this.hostId=hostId;
    this.players=[]; this.spectators=[];
    this.gameStarted=false; this.board=null; this.turn=0;
    this.midTurnPiece=null; this.turnStartPos=null;
    this.settings={maxPlayers:2,timerEnabled:true,timerSeconds:30};
    this.timerTimeout=null;
  }
  startServerTimer() {
    if (!this.settings.timerEnabled) return;
    if (this.timerTimeout) clearTimeout(this.timerTimeout);
    this.timerTimeout = setTimeout(() => { this.handleTurnTimeout(); }, (this.settings.timerSeconds + 1) * 1000);
  }
  handleTurnTimeout() {
    if (!this.gameStarted) return;
    if(this.midTurnPiece) {
      const fk = ck(this.midTurnPiece.r, this.midTurnPiece.c);
      this.board[ck(this.turnStartPos.r, this.turnStartPos.c)] = this.board[fk];
      delete this.board[fk];
      this.midTurnPiece = null;
    }
    this.turn = (this.turn + 1) % this.players.length;
    io.to(this.code).emit('turn-skipped', {turn: this.turn, board: this.board});
    this.startServerTimer();
  }
  addPlayer(id,name,spec=false){
    if(spec){ this.spectators.push({id,name}); return null; }
    const idx=this.players.length;
    const p={id,name,idx,color:COLORS[idx],zi:-1};
    this.players.push(p); return p;
  }
  removePlayer(id){
    const p=this.players.find(x=>x.id===id);
    this.players=this.players.filter(x=>x.id!==id);
    this.spectators=this.spectators.filter(x=>x.id!==id);
    if(this.hostId===id&&this.players.length>0){ this.hostId=this.players[0].id; return 'hc'; }
    return null;
  }
  getPlayer(id){ return this.players.find(p=>p.id===id)||this.spectators.find(s=>s.id===id); }
  isFull(){ return this.players.length>=this.settings.maxPlayers; }
  isEmpty(){ return this.players.length===0&&this.spectators.length===0; }
  pList(){ return this.players.map(p=>({id:p.id,name:p.name,idx:p.idx,color:p.color,isHost:p.id===this.hostId})); }
  startGame(){
    const zc=ZONE_CFG[this.players.length]||ZONE_CFG[2];
    this.players.forEach((p,i)=>{ p.zi=zc[i]; });
    this.board=initBoard(this.players.map(p=>p.zi));
    this.gameStarted=true; 
    this.turn = Math.floor(Math.random() * this.players.length);
    this.startServerTimer();
    return this.state();
  }
  state(){
    return {
      board:this.board,
      players:this.players.map(p=>({id:p.id,name:p.name,idx:p.idx,color:p.color,zi:p.zi,target:OPP[p.zi],isHost:p.id===this.hostId})),
      turn:this.turn, midTurnPiece:this.midTurnPiece, settings:this.settings
    };
  }
  move(sid,from,to){
    if(!this.gameStarted) return {ok:false,err:'Game not started'};
    const pl=this.players[this.turn];
    if(!pl||pl.id!==sid) return {ok:false,err:'Not your turn'};
    
    const isMidTurn = !!this.midTurnPiece;
    if(isMidTurn){
      if(from.r!==this.midTurnPiece.r || from.c!==this.midTurnPiece.c) return {ok:false, err:'Must continue with active piece'};
    }
    
    const fk=ck(from.r,from.c);
    if(this.board[fk]!==pl.idx+1) return {ok:false,err:'Wrong marble'};
    
    let isJump = false;
    let vd = [];
    if(isMidTurn){
      vd = validSingleJumps(this.board, from.r, from.c);
      isJump = true;
    } else {
      const steps = validSingleSteps(this.board, from.r, from.c);
      const jumps = validSingleJumps(this.board, from.r, from.c);
      vd = [...steps, ...jumps];
      isJump = jumps.some(d=>d.r===to.r&&d.c===to.c);
    }
    
    if(!vd.some(d=>d.r===to.r&&d.c===to.c)) return {ok:false,err:'Invalid move'};
    
    if(!isMidTurn) this.turnStartPos = {r:from.r, c:from.c};
    
    this.board[ck(to.r,to.c)]=this.board[fk];
    delete this.board[fk];
    
    const won=checkWin(this.board,pl.idx,pl.zi);
    if(won){
      if(this.timerTimeout) clearTimeout(this.timerTimeout);
      return {ok:true,won:true,winner:pl,path:[from,to]};
    }
    
    let endTurn = true;
    if(isJump){
      const moreJumps = validSingleJumps(this.board, to.r, to.c);
      if(moreJumps.length > 0){
        endTurn = false;
        this.midTurnPiece = {r:to.r, c:to.c};
      }
    }
    
    if(endTurn){
      this.midTurnPiece = null;
      this.turn=(this.turn+1)%this.players.length;
      this.startServerTimer();
    }
    
    return {ok:true, won:false, path:[from,to], endTurn};
  }
  undoTurn(sid){
    if(!this.gameStarted || !this.midTurnPiece) return false;
    const pl=this.players[this.turn];
    if(!pl||pl.id!==sid) return false;
    const fk = ck(this.midTurnPiece.r, this.midTurnPiece.c);
    this.board[ck(this.turnStartPos.r, this.turnStartPos.c)] = this.board[fk];
    delete this.board[fk];
    this.midTurnPiece = null;
    this.turn = (this.turn+1)%this.players.length;
    this.startServerTimer();
    return true;
  }
  endTurn(sid){
    if(!this.gameStarted || !this.midTurnPiece) return {ok:false};
    const pl=this.players[this.turn];
    if(!pl||pl.id!==sid) return {ok:false};
    if(isForbiddenBase(this.midTurnPiece.r, this.midTurnPiece.c, pl.zi)){
       this.undoTurn(sid);
       return {ok:true, undone:true};
    }
    this.midTurnPiece = null;
    this.turn = (this.turn+1)%this.players.length;
    this.startServerTimer();
    return {ok:true, undone:false};
  }
  skipTurn(sid){
    const pl=this.players[this.turn];
    if(pl&&pl.id===sid){ 
       this.handleTurnTimeout();
       return true; 
    }
    return false;
  }
}

io.on('connection',sock=>{
  console.log('+ ',sock.id);

  sock.on('create-room',({name,maxPlayers})=>{
    const code=genCode();
    const room=new Room(code,sock.id);
    room.settings.maxPlayers=Math.min(Math.max(+maxPlayers||2,2),6);
    rooms.set(code,room);
    room.addPlayer(sock.id,name||'Player 1');
    sock.join(code); sock.data.rc=code;
    sock.emit('room-created',{code,players:room.pList(),settings:room.settings});
  });

  sock.on('join-room',({code,name})=>{
    const rc=(code||'').toUpperCase().trim();
    const room=rooms.get(rc);
    if(!room){sock.emit('join-error',{msg:'Room not found!'});return;}
    if(!room.gameStarted&&room.isFull()){sock.emit('join-error',{msg:'Room is full!'});return;}
    const spec=room.gameStarted;
    room.addPlayer(sock.id,name||'Guest',spec);
    sock.join(rc); sock.data.rc=rc;
    sock.emit('room-joined',{code:rc,players:room.pList(),settings:room.settings,spec,gameState:spec?room.state():null});
    io.to(rc).emit('player-joined',{name:name||'Guest',players:room.pList()});
  });

  sock.on('start-game',()=>{
    const room=rooms.get(sock.data.rc);
    if(!room||room.hostId!==sock.id) return;
    if(room.players.length<2){sock.emit('err',{msg:'Need at least 2 players!'});return;}
    io.to(room.code).emit('game-started',room.startGame());
  });

  sock.on('make-move',({from,to})=>{
    const room=rooms.get(sock.data.rc);
    if(!room) return;
    const res=room.move(sock.id,from,to);
    if(!res.ok){sock.emit('move-rejected',{reason:res.err});return;}
    if(res.won){
      io.to(room.code).emit('game-over',{winner:{name:res.winner.name,idx:res.winner.idx,color:res.winner.color},from,to,path:res.path,board:room.board});
    } else {
      io.to(room.code).emit('move-made',{from,to,path:res.path,board:room.board,turn:room.turn,midTurnPiece:room.midTurnPiece,endTurn:res.endTurn});
    }
  });

  sock.on('end-turn',()=>{
    const room=rooms.get(sock.data.rc);
    if(!room) return;
    const res = room.endTurn(sock.id);
    if(res.ok) io.to(room.code).emit('turn-ended',{board:room.board, turn:room.turn, undone:res.undone});
  });

  sock.on('undo-turn',()=>{
    const room=rooms.get(sock.data.rc);
    if(!room) return;
    if(room.undoTurn(sock.id)) io.to(room.code).emit('turn-ended',{board:room.board, turn:room.turn, undone:true});
  });

  sock.on('chat',({msg})=>{
    const room=rooms.get(sock.data.rc);
    if(!room||!msg?.trim()) return;
    const p=room.getPlayer(sock.id);
    io.to(room.code).emit('chat',{name:p?.name||'?',idx:p?.idx??-1,color:p?.idx>=0?COLORS[p.idx]:'#aaa',msg:msg.trim().slice(0,200),ts:Date.now()});
  });

  sock.on('update-settings',({settings})=>{
    const room=rooms.get(sock.data.rc);
    if(!room||room.hostId!==sock.id||room.gameStarted) return;
    if(settings.maxPlayers) room.settings.maxPlayers=Math.min(Math.max(+settings.maxPlayers,2),6);
    if(settings.timerEnabled!==undefined) room.settings.timerEnabled=!!settings.timerEnabled;
    if(settings.timerSeconds) room.settings.timerSeconds=Math.min(Math.max(+settings.timerSeconds,10),120);
    io.to(room.code).emit('settings-updated',room.settings);
  });

  sock.on('timer-expired',()=>{
    const room=rooms.get(sock.data.rc);
    if(room&&room.skipTurn(sock.id)) io.to(room.code).emit('turn-skipped',{turn:room.turn});
  });

  // Client pressed "Play Again" — acknowledge (game state reset requires a new game start)
  sock.on('return-to-lobby',()=>{
    const room=rooms.get(sock.data.rc);
    if(!room) return;
    // Reset game state so players can start again
    room.gameStarted=false; room.board=null;
    room.turn=0; room.midTurnPiece=null; room.turnStartPos=null;
    if(room.timerTimeout) clearTimeout(room.timerTimeout);
    io.to(room.code).emit('player-joined',{name:'',players:room.pList()});
  });

  sock.on('disconnect',()=>{
    console.log('- ',sock.id);
    const room=rooms.get(sock.data.rc);
    if(!room) return;
    const p=room.getPlayer(sock.id);
    const ev=room.removePlayer(sock.id);
    if(room.isEmpty()){ rooms.delete(room.code); return; }
    io.to(room.code).emit('player-left',{name:p?.name||'?',players:room.pList(),newHost:ev==='hc'?room.hostId:null});
    if(room.gameStarted) io.to(room.code).emit('sys-msg',{text:`${p?.name||'A player'} disconnected.`});
  });
});

const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>console.log(`🎮  http://localhost:${PORT}`));
