/* ═══════════════════════════════════════════════════════════════
   CHINESE CHECKERS ONLINE — CLIENT ENGINE  v2.0
   Board coords: (r,c) double-width. r∈[0,16], c varies by row.
   Neighbours: same-row |dc|=2  |  adjacent rows |dr|=1,|dc|=1

   Canvas uses devicePixelRatio for crisp Retina rendering.
   All input coordinates are mapped via getBoundingClientRect()
   to ensure 100% accurate touch/click on every screen size.
═══════════════════════════════════════════════════════════════ */
'use strict';

// ── Board constants (mirror of server) ──────────────────────────
const ROW_SIZES  = [1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1];
const ROW_STARTS = [12, 11, 10, 9, 0, 1, 2, 3, 4, 3, 2, 1, 0, 9, 10, 11, 12];

const VALID = new Set();
for (let r = 0; r < 17; r++)
  for (let i = 0; i < ROW_SIZES[r]; i++)
    VALID.add(ck(r, ROW_STARTS[r] + i * 2));

function ck(r, c) { return r * 100 + c; }
function isCell(r, c) { return VALID.has(ck(r, c)); }

function neighbours(r, c) {
  const out = [];
  for (const [dr, dc] of [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]])
    if (isCell(r + dr, c + dc)) out.push({ r: r + dr, c: c + dc });
  return out;
}

function validSingleSteps(board, r, c) {
  const dests = [];
  for (const n of neighbours(r, c))
    if (board[ck(n.r, n.c)] === undefined) dests.push(n);
  return dests;
}

function validSingleJumps(board, r, c) {
  const res = [];
  for (const [dr, dc] of [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let d = 1;
    while (isCell(r + d*dr, c + d*dc) && board[ck(r + d*dr, c + d*dc)] === undefined) d++;
    if (!isCell(r + d*dr, c + d*dc)) continue;
    const lr = r + 2*d*dr, lc = c + 2*d*dc;
    if (!isCell(lr, lc) || board[ck(lr, lc)] !== undefined) continue;
    let valid = true;
    for (let k = d + 1; k < 2 * d; k++) {
      if (board[ck(r + k*dr, c + k*dc)] !== undefined) { valid = false; break; }
    }
    if (valid) res.push({ r: lr, c: lc });
  }
  return res;
}

// ── Player colour palette ────────────────────────────────────────
const P_COLORS = [
  { main: '#e74c3c', light: '#ff9999', dark: '#8b1a1a', name: 'Red'    },
  { main: '#4a90e2', light: '#90c0ff', dark: '#1c4a8a', name: 'Blue'   },
  { main: '#2ecc71', light: '#80f0b0', dark: '#157a3e', name: 'Green'  },
  { main: '#f1c40f', light: '#ffe660', dark: '#a08000', name: 'Yellow' },
  { main: '#a855f7', light: '#d09aff', dark: '#6020b0', name: 'Purple' },
  { main: '#f97316', light: '#ffb060', dark: '#a03808', name: 'Orange' },
];

// ── Global state ─────────────────────────────────────────────────
const G = {
  socket: null,
  screen: 'menu',
  myId: '',
  myName: '',
  myIdx: -1,
  isHost: false,
  isSpec: false,
  roomCode: '',
  players: [],
  settings: { maxPlayers: 2, timerEnabled: true, timerSeconds: 30 },

  board: {},
  turn: 0,
  myTurn: false,
  midTurnPiece: null,
  selectedR: -1,
  selectedC: -1,
  highlights: [],

  // camera (in logical/CSS pixels)
  cam: { x: 0, y: 0, zoom: 1 },
  dragging: false,
  dragLast: { x: 0, y: 0 },

  // animation
  anim: null,
  gameTime: 0,

  // timer
  timerLeft: 0,
  timerMax: 30,
  timerRunning: false,
  timerInterval: null,

  // audio
  audioCtx: null,
  audioEnabled: true,

  // DPR
  dpr: 1,
};

// ── Canvas setup ─────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

/**
 * Resize canvas to fill its CSS container, accounting for devicePixelRatio.
 * canvas.width/height = physical pixels (sharp on Retina).
 * All drawing uses logical (CSS) pixels via the dpr scale transform.
 */
function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  const dpr  = window.devicePixelRatio || 1;
  G.dpr      = dpr;

  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;

  // Physical pixel size
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  // Keep CSS size unchanged so layout is unaffected
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
}

window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 120));

/** Logical width (CSS pixels) */
function logicalW() { return canvas.width  / G.dpr; }
/** Logical height (CSS pixels) */
function logicalH() { return canvas.height / G.dpr; }

/**
 * Convert a raw clientX/Y from a mouse/touch event to canvas logical coords.
 * Uses getBoundingClientRect() so it works regardless of canvas CSS scaling,
 * zoom levels, or any layout transform.
 */
function clientToLogical(clientX, clientY) {
  const rect  = canvas.getBoundingClientRect();
  const scaleX = logicalW() / rect.width;   // always ~1.0 because CSS = logical
  const scaleY = logicalH() / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top)  * scaleY,
  };
}

// Step = spacing between board holes in logical pixels
function getStep() {
  const margin = 70;
  const usableW = logicalW() - margin * 2;
  const usableH = logicalH() - margin * 2;
  const sW = usableW / 12;
  const sH = usableH / (16 * Math.sqrt(3) / 2);
  return Math.min(sW, sH, 54);
}

// Board (r,c) → world coords (logical px, origin at board centre)
function cell2px(r, c) {
  const S = getStep(), H = S * Math.sqrt(3) / 2;
  return { x: (c - 12) * S / 2, y: (r - 8) * H };
}

// Screen logical px → game world coords
function screen2world(sx, sy) {
  const { x: cx, y: cy, zoom } = G.cam;
  return {
    x: (sx - logicalW() / 2 - cx) / zoom,
    y: (sy - logicalH() / 2 - cy) / zoom,
  };
}

// World coords → nearest board cell (or null)
function world2cell(wx, wy) {
  const S = getStep(), H = S * Math.sqrt(3) / 2;
  const approxR = wy / H + 8;
  const r0 = Math.max(0, Math.floor(approxR - 1));
  const r1 = Math.min(16, Math.ceil(approxR  + 1));
  let best = null, bestD = Infinity;
  for (let r = r0; r <= r1; r++) {
    const st = ROW_STARTS[r], sz = ROW_SIZES[r];
    for (let i = 0; i < sz; i++) {
      const c = st + i * 2;
      const p = cell2px(r, c);
      const d = Math.hypot(wx - p.x, wy - p.y);
      if (d < bestD) { bestD = d; best = { r, c }; }
    }
  }
  return bestD < S * 0.65 ? best : null;
}

// ═══════════════════════════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════════════════════════

/**
 * All drawing is in logical (CSS) pixel space.
 * We set a base transform of dpr×dpr so ctx coordinates are always logical.
 */
function applyCamera(fn) {
  ctx.save();
  // scale by DPR first to map logical→physical
  ctx.scale(G.dpr, G.dpr);
  // then camera transform (logical)
  ctx.translate(logicalW() / 2 + G.cam.x, logicalH() / 2 + G.cam.y);
  ctx.scale(G.cam.zoom, G.cam.zoom);
  try { fn(); } finally { ctx.restore(); }
}

// Draw hexagram-shaped board background
function drawBoardBg() {
  const S = getStep();
  const outerR = S * 4 * Math.sqrt(3) + S * 0.4;
  const innerR = S * 4 + S * 0.25;

  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const oa = (-90 + i * 60) * Math.PI / 180;
    const ia = (-60 + i * 60) * Math.PI / 180;
    const ox = outerR * Math.cos(oa), oy = outerR * Math.sin(oa);
    const ix = innerR * Math.cos(ia), iy = innerR * Math.sin(ia);
    if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
    ctx.lineTo(ix, iy);
  }
  ctx.closePath();

  // Board shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur  = 30;
  ctx.shadowOffsetY = 12;

  // Rich dark wood gradient
  const grad = ctx.createRadialGradient(0, -outerR * 0.25, 0, 0, 0, outerR * 1.15);
  grad.addColorStop(0,   '#4e2b12');
  grad.addColorStop(0.4, '#391606');
  grad.addColorStop(1,   '#1e0903');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // Wood grain texture
  ctx.save();
  ctx.clip();
  for (let i = 0; i < 55; i++) {
    const y = -outerR + i * (outerR * 2 / 55);
    ctx.beginPath();
    ctx.moveTo(-outerR, y);
    ctx.bezierCurveTo(
      -outerR * 0.5, y + Math.sin(i * 0.9) * 18,
       outerR * 0.5, y - Math.cos(i * 0.8) * 18,
       outerR, y
    );
    ctx.strokeStyle = `rgba(0,0,0,${0.025 + (i % 3) * 0.015})`;
    ctx.lineWidth = 1.5 + (i % 2); ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-outerR, y + 1.5);
    ctx.bezierCurveTo(
      -outerR * 0.5, y + 1.5 + Math.sin(i * 0.9) * 18,
       outerR * 0.5, y + 1.5 - Math.cos(i * 0.8) * 18,
       outerR, y + 1.5
    );
    ctx.strokeStyle = `rgba(200,110,50,${0.015 + (i % 2) * 0.008})`;
    ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.restore();

  // Border highlight / bevel
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.stroke();
}

// Subtle zone colour tints (home & target areas)
function drawZoneTints() {
  if (!G.players.length) return;
  const S = getStep();
  G.players.forEach(pl => {
    if (pl.zi < 0) return;
    const col = P_COLORS[pl.idx % 6];
    getZoneCells(pl.zi).forEach(({ r, c }) => {
      const { x, y } = cell2px(r, c);
      ctx.beginPath();
      ctx.arc(x, y, S * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = col.main + '1c';
      ctx.fill();
    });
  });
}

function drawTargetTints() {
  if (!G.players.length) return;
  const myPl = G.players.find(p => p.idx === G.myIdx);
  if (!myPl || myPl.zi < 0) return;
  const OPP = [3,4,5,0,1,2];
  const tgtCells = getZoneCells(OPP[myPl.zi]);
  const col = P_COLORS[myPl.idx % 6];
  const S = getStep();
  tgtCells.forEach(({ r, c }) => {
    const { x, y } = cell2px(r, c);
    ctx.beginPath();
    ctx.arc(x, y, S * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = col.main + '14';
    ctx.fill();
    ctx.strokeStyle = col.main + '28';
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

// Realistic recessed holes
function drawHoles() {
  const S = getStep();
  const hR = S * 0.27;
  for (let r = 0; r < 17; r++) {
    const st = ROW_STARTS[r], sz = ROW_SIZES[r];
    for (let i = 0; i < sz; i++) {
      const c = st + i * 2;
      const { x, y } = cell2px(r, c);

      // Deep hole base
      ctx.beginPath(); ctx.arc(x, y, hR, 0, Math.PI * 2);
      ctx.fillStyle = '#130603'; ctx.fill();

      // Inner shadow gradient
      const hg = ctx.createLinearGradient(x, y - hR, x, y + hR);
      hg.addColorStop(0, 'rgba(0,0,0,0.92)');
      hg.addColorStop(1, 'rgba(0,0,0,0.08)');
      ctx.fillStyle = hg; ctx.fill();

      // Outer rim shadow
      ctx.beginPath(); ctx.arc(x, y, hR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 2.5; ctx.stroke();

      // Bottom rim highlight (3D inset)
      ctx.beginPath(); ctx.arc(x, y + 1.2, hR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
}

// Animated highlight dots for valid moves
function drawHighlights() {
  if (!G.highlights.length) return;
  const S = getStep();
  const t = G.gameTime;
  const pulse = 0.5 + 0.5 * Math.sin(t * 5.2);

  G.highlights.forEach(({ r, c }) => {
    const { x, y } = cell2px(r, c);

    // Outer glow ring
    ctx.beginPath(); ctx.arc(x, y, S * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,215,0,${0.38 + 0.45 * pulse})`;
    ctx.lineWidth = 2 + pulse * 0.8;
    ctx.stroke();

    // Centre dot
    ctx.beginPath(); ctx.arc(x, y, S * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,215,0,${0.55 + 0.4 * pulse})`;
    ctx.fill();
  });

  // Selected cell ring
  if (G.selectedR >= 0) {
    const { x, y } = cell2px(G.selectedR, G.selectedC);
    ctx.beginPath(); ctx.arc(x, y, S * 0.44, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.62 + 0.38 * pulse})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

/**
 * Draw a single glass marble with sphere shading, specular highlights, and glow.
 */
function drawMarble(x, y, radius, colObj, scale = 1, alpha = 1) {
  const r = radius * scale;
  ctx.save();
  ctx.globalAlpha = alpha;

  // Drop shadow
  ctx.beginPath();
  ctx.arc(x + r * 0.18, y + r * 0.22, r * 0.88, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  // Glow halo (subtle)
  const glow = ctx.createRadialGradient(x, y, r * 0.7, x, y, r * 1.6);
  glow.addColorStop(0, colObj.main + '20');
  glow.addColorStop(1, colObj.main + '00');
  ctx.beginPath();
  ctx.arc(x, y, r * 1.6, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();

  // Main sphere (radial gradient — glass look)
  const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, r * 0.04, x, y, r);
  g.addColorStop(0,    colObj.light);
  g.addColorStop(0.42, colObj.main);
  g.addColorStop(1,    colObj.dark);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();

  // Primary specular highlight
  const sg = ctx.createRadialGradient(x - r * 0.30, y - r * 0.34, 0, x - r * 0.24, y - r * 0.28, r * 0.36);
  sg.addColorStop(0, 'rgba(255,255,255,0.90)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath(); ctx.arc(x - r * 0.24, y - r * 0.28, r * 0.36, 0, Math.PI * 2);
  ctx.fillStyle = sg; ctx.fill();

  // Secondary micro-highlight
  ctx.beginPath(); ctx.arc(x - r * 0.10, y - r * 0.12, r * 0.11, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.fill();

  // Rim stroke
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.restore();
}

// Draw all static marbles from board state
function drawMarbles() {
  const S  = getStep();
  const mR = S * 0.37;
  const animFrom = G.anim ? G.anim.from : null;

  for (const [keyStr, pi] of Object.entries(G.board)) {
    const k = +keyStr;
    const r = Math.floor(k / 100), c = k % 100;
    // Skip the marble currently being animated (draw it separately)
    if (animFrom && animFrom.r === r && animFrom.c === c) continue;
    if (G.anim && G.anim.toR === r && G.anim.toC === c) continue;

    const { x, y } = cell2px(r, c);
    const col = P_COLORS[(pi - 1) % 6];
    drawMarble(x, y, mR, col);
  }
}

// Draw the travelling marble
function drawAnimMarble() {
  if (!G.anim) return;
  const S  = getStep();
  const mR = S * 0.37;
  const { x, y } = G.anim.getPos();
  const col = P_COLORS[(G.anim.pi - 1) % 6];
  drawMarble(x, y, mR, col);
}

// Main render — always resets to identity first so nothing can accumulate
function render() {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (G.screen !== 'game') return;

  applyCamera(() => {
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

class MarbleAnim {
  constructor(path, pi, onDone) {
    this.path   = path;   // [{r,c}, ...]
    this.pi     = pi;
    this.onDone = onDone;
    this.hop    = 0;
    this.t      = 0;
    this.hopDur = 0.30;   // seconds per hop
    this.done   = false;
    this.from   = path[0];
    this.toR    = path[path.length - 1].r;
    this.toC    = path[path.length - 1].c;
  }
  update(dt) {
    this.t += dt / this.hopDur;
    if (this.t >= 1) {
      this.t = 0; this.hop++;
      playClack();
      if (this.hop >= this.path.length - 1) {
        this.done = true;
        if (this.onDone) this.onDone();
      }
    }
  }
  getPos() {
    const a = this.path[this.hop], b = this.path[this.hop + 1] || a;
    const pa = cell2px(a.r, a.c), pb = cell2px(b.r, b.c);
    const e  = easeInOut(this.t);
    // Arc height proportional to distance
    const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const arcH = dist * 0.22;
    return {
      x: pa.x + (pb.x - pa.x) * e,
      y: pa.y + (pb.y - pa.y) * e - Math.sin(e * Math.PI) * arcH,
    };
  }
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function playAnimation(path, pi, onDone) {
  const anim = new MarbleAnim(path, pi, () => {
    if (G.anim === anim) G.anim = null;
    if (onDone) onDone();
  });
  G.anim = anim;
}

// ═══════════════════════════════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════════════════════════════

function initAudio() {
  try { G.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  catch (e) { G.audioEnabled = false; }
}

function playClack() {
  if (!G.audioEnabled || !G.audioCtx) return;
  try {
    const osc  = G.audioCtx.createOscillator();
    const gain = G.audioCtx.createGain();
    const now  = G.audioCtx.currentTime;
    osc.connect(gain); gain.connect(G.audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(950, now);
    osc.frequency.exponentialRampToValueAtTime(260, now + 0.09);
    gain.gain.setValueAtTime(0.38, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    osc.start(now); osc.stop(now + 0.13);
  } catch (e) {}
}

function playUIClick() {
  if (!G.audioEnabled || !G.audioCtx) return;
  try {
    const osc  = G.audioCtx.createOscillator();
    const gain = G.audioCtx.createGain();
    const now  = G.audioCtx.currentTime;
    osc.connect(gain); gain.connect(G.audioCtx.destination);
    osc.type = 'triangle'; osc.frequency.value = 620;
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.start(now); osc.stop(now + 0.07);
  } catch (e) {}
}

function playWin() {
  if (!G.audioEnabled || !G.audioCtx) return;
  [261, 329, 392, 523].forEach((f, i) => {
    try {
      const osc  = G.audioCtx.createOscillator();
      const gain = G.audioCtx.createGain();
      osc.connect(gain); gain.connect(G.audioCtx.destination);
      osc.type = 'triangle'; osc.frequency.value = f;
      const t = G.audioCtx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.24, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
      osc.start(t); osc.stop(t + 0.65);
    } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════════════════
//  TIMER
// ═══════════════════════════════════════════════════════════════

function startTimer(seconds) {
  stopTimer();
  G.timerLeft = seconds; G.timerMax = seconds; G.timerRunning = true;
  updateTimerUI();
  G.timerInterval = setInterval(() => {
    G.timerLeft--;
    updateTimerUI();
    if (G.timerLeft <= 0) {
      stopTimer();
      if (G.myTurn) G.socket.emit('timer-expired');
    }
  }, 1000);
}

function stopTimer() {
  G.timerRunning = false;
  clearInterval(G.timerInterval);
  G.timerInterval = null;
}

function updateTimerUI() {
  const num  = document.getElementById('timer-num');
  const ring = document.getElementById('timer-ring');
  const wrap = document.getElementById('timer-wrap');
  if (!ring || !num) return;
  const frac = Math.max(0, G.timerLeft / G.timerMax);
  const circ = 2 * Math.PI * 18;
  ring.style.strokeDashoffset = (circ * (1 - frac)).toFixed(2);
  num.textContent = G.timerLeft;
  const color = frac > 0.5 ? '#5b7fff' : frac > 0.25 ? '#f1c40f' : '#ef4444';
  ring.style.stroke = color;
  const urgent = G.timerLeft <= 10 && G.timerLeft > 0;
  wrap.classList.toggle('timer-urgent', urgent);
}

// ═══════════════════════════════════════════════════════════════
//  ZONE HELPER
// ═══════════════════════════════════════════════════════════════

function makeZone(rows, counts, fromRight) {
  return rows.flatMap((row, i) => {
    const cnt = counts[i], st = ROW_STARTS[row], sz = ROW_SIZES[row];
    return Array.from({ length: cnt }, (_, j) => ({
      r: row, c: fromRight ? st + (sz - cnt + j) * 2 : st + j * 2
    }));
  });
}
const ZONES = [
  makeZone([0,1,2,3],    [1,2,3,4], false),
  makeZone([4,5,6,7],    [4,3,2,1], true),
  makeZone([9,10,11,12], [1,2,3,4], true),
  makeZone([13,14,15,16],[4,3,2,1], false),
  makeZone([9,10,11,12], [1,2,3,4], false),
  makeZone([4,5,6,7],    [4,3,2,1], false),
];
function getZoneCells(zi) { return ZONES[zi] || []; }

// ═══════════════════════════════════════════════════════════════
//  INPUT HANDLING
// ═══════════════════════════════════════════════════════════════

function handleCanvasClick(clientX, clientY) {
  if (G.screen !== 'game' || G.isSpec || !G.myTurn || G.anim) return;
  if (G.dragging) return;

  // Map screen coords → logical canvas coords using getBoundingClientRect()
  const { x: sx, y: sy } = clientToLogical(clientX, clientY);
  const w    = screen2world(sx, sy);
  const cell = world2cell(w.x, w.y);
  if (!cell) { clearSelection(); return; }

  const { r, c } = cell;
  const cellPi = G.board[ck(r, c)];
  const myPi   = G.myIdx + 1;

  if (G.selectedR >= 0) {
    // Try to move to highlighted cell
    const isHighlit = G.highlights.some(h => h.r === r && h.c === c);
    if (isHighlit) {
      G.socket.emit('make-move', { from: { r: G.selectedR, c: G.selectedC }, to: { r, c } });
      clearSelection();
      return;
    }
    // Mid-turn: clicking active piece again ends the turn
    if (G.midTurnPiece && r === G.midTurnPiece.r && c === G.midTurnPiece.c) {
      G.socket.emit('end-turn');
      clearSelection();
      return;
    }
    // Re-select another own marble (only if not mid-turn)
    if (cellPi === myPi && !G.midTurnPiece) { selectCell(r, c); return; }
    if (!G.midTurnPiece) clearSelection();
  } else {
    // Select own marble
    if (cellPi === myPi) {
      if (G.midTurnPiece && (r !== G.midTurnPiece.r || c !== G.midTurnPiece.c)) return;
      selectCell(r, c); playUIClick();
    }
  }
}

function selectCell(r, c) {
  G.selectedR = r; G.selectedC = c;
  if (G.midTurnPiece && r === G.midTurnPiece.r && c === G.midTurnPiece.c) {
    G.highlights = validSingleJumps(G.board, r, c);
  } else {
    const mk = ck(r, c), mm = G.board[mk]; delete G.board[mk];
    G.highlights = [...validSingleSteps(G.board, r, c), ...validSingleJumps(G.board, r, c)];
    G.board[mk] = mm;
  }
}

function clearSelection() { G.selectedR = -1; G.selectedC = -1; G.highlights = []; }

// ── Camera — pan via pointer events ──────────────────────────────
function onPointerDown(e) {
  G.dragging = false;
  G.dragLast = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup',   onPointerUp,   { once: true });
  canvas.addEventListener('pointercancel', onPointerUp, { once: true });
}
function onPointerMove(e) {
  const dx = e.clientX - G.dragLast.x;
  const dy = e.clientY - G.dragLast.y;
  if (Math.hypot(dx, dy) > 5) G.dragging = true;
  if (G.dragging) { G.cam.x += dx; G.cam.y += dy; }
  G.dragLast = { x: e.clientX, y: e.clientY };
}
function onPointerUp(e) {
  canvas.releasePointerCapture(e.pointerId);
  canvas.removeEventListener('pointermove', onPointerMove);
  canvas.removeEventListener('pointercancel', onPointerUp);
  if (!G.dragging) handleCanvasClick(e.clientX, e.clientY);
  setTimeout(() => { G.dragging = false; }, 10);
}

// ── Camera — scroll-wheel zoom ────────────────────────────────────
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const { x: sx, y: sy } = clientToLogical(e.clientX, e.clientY);
  const newZoom = Math.min(Math.max(G.cam.zoom * (e.deltaY < 0 ? 1.12 : 0.892), 0.3), 5);
  const f = newZoom / G.cam.zoom;
  G.cam.x = (sx - logicalW() / 2) * (1 - f) + G.cam.x * f;
  G.cam.y = (sy - logicalH() / 2) * (1 - f) + G.cam.y * f;
  G.cam.zoom = newZoom;
}, { passive: false });

canvas.addEventListener('pointerdown', onPointerDown);

// ── Touch: pinch-to-zoom (in-game) and anti-zoom for the whole page ──
let pinchDist0 = 0, camZoom0 = 1;
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (e.touches.length === 2) {
    pinchDist0 = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    camZoom0 = G.cam.zoom;
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 2 && pinchDist0 > 0) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    G.cam.zoom = Math.min(Math.max(camZoom0 * (d / pinchDist0), 0.3), 5);
  }
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
}, { passive: false });

// Strict document-level block of native pinch-zoom (iOS Safari / Android Chrome)
document.addEventListener('touchstart', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
// Block ctrl+wheel zoom
document.addEventListener('wheel', e => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });

// ═══════════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════════

function addChatMsg(container, data) {
  const div = document.createElement('div');
  if (data.sys) {
    div.className = 'chat-msg';
    div.innerHTML = `<div class="chat-sys">${esc(data.text)}</div>`;
  } else {
    const col  = data.color || '#aaa';
    const time = new Date(data.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.className = 'chat-msg';
    div.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-dot" style="background:${col}"></span>
        <span class="chat-author" style="color:${col}">${esc(data.name)}</span>
        <span class="chat-time">${time}</span>
      </div>
      <div class="chat-text">${esc(data.msg)}</div>`;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setupChat(inputId, sendId) {
  const input = document.getElementById(inputId);
  const btn   = document.getElementById(sendId);
  function send() {
    const msg = input.value.trim();
    if (!msg) return;
    G.socket.emit('chat', { msg });
    input.value = '';
  }
  btn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

// ═══════════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════════

let _toastTimer = null;
function toast(msg, dur = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ═══════════════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.toggle('active', s.id === 'screen-' + name);
  });
  G.screen = name;
  if (name === 'game') { resizeCanvas(); resetCamera(); }
}

function resetCamera() { G.cam = { x: 0, y: 0, zoom: 1 }; }

// ── Lobby UI update ──────────────────────────────────────────────
function updateLobbyUI() {
  document.getElementById('room-code-display').textContent = G.roomCode;
  const pList = document.getElementById('player-list');
  pList.innerHTML = '';
  G.players.forEach(p => {
    const li  = document.createElement('li');
    const col = P_COLORS[p.idx % 6];
    li.innerHTML = `
      <span class="pl-marble" style="background:${col.main};box-shadow:0 0 12px ${col.main}"></span>
      <span class="pl-name">${esc(p.name)}</span>
      ${p.isHost ? '<span class="pl-host-badge">HOST</span>' : ''}`;
    pList.appendChild(li);
  });
  document.getElementById('player-count-display').textContent =
    `${G.players.length} / ${G.settings.maxPlayers}`;

  const startBtn = document.getElementById('btn-start');
  startBtn.disabled  = !G.isHost || G.players.length < 2;
  startBtn.textContent = G.isHost ? 'Start Game' : 'Waiting for host…';

  document.getElementById('settings-panel').style.display = G.isHost ? '' : 'none';
  if (G.isHost) {
    document.getElementById('set-maxplayers').value  = G.settings.maxPlayers;
    document.getElementById('set-timer').checked     = G.settings.timerEnabled;
    document.getElementById('set-timersecs').value   = G.settings.timerSeconds;
    document.getElementById('timer-secs-row').style.display = G.settings.timerEnabled ? '' : 'none';
  }
}

// ── HUD update ───────────────────────────────────────────────────
function updateHUD() {
  if (!G.players.length) return;
  G.myTurn = (G.players[G.turn]?.idx === G.myIdx) && !G.isSpec;
  const curPl = G.players[G.turn];
  const tm = document.getElementById('turn-marble');
  const tt = document.getElementById('turn-text');
  if (curPl) {
    const col = P_COLORS[curPl.idx % 6];
    tm.style.background = col.main;
    tm.style.boxShadow  = `0 0 12px ${col.main}`;
    tt.textContent = curPl.idx === G.myIdx ? 'Your Turn!' : curPl.name + "'s Turn";
    tt.style.color = curPl.idx === G.myIdx ? '#c8d8ff' : '#8899cc';
  }

  const bar      = document.getElementById('player-bar');
  bar.innerHTML  = '';
  const activePl = G.players[G.turn];
  G.players.forEach(p => {
    const col = P_COLORS[p.idx % 6];
    const div = document.createElement('div');
    div.className = 'pb-player' + (activePl && p.idx === activePl.idx ? ' active-turn' : '');
    div.innerHTML = `<span class="pb-dot" style="background:${col.main};box-shadow:0 0 6px ${col.main}"></span>${esc(p.name)}`;
    bar.appendChild(div);
  });

  const mtControls = document.getElementById('mid-turn-controls');
  mtControls.style.display = (G.myTurn && G.midTurnPiece) ? 'flex' : 'none';
  document.getElementById('spectator-badge').style.display = G.isSpec ? '' : 'none';
}

// ── Confetti ─────────────────────────────────────────────────────
function spawnConfetti(color) {
  const box = document.getElementById('winner-confetti');
  box.innerHTML = '';
  for (let i = 0; i < 48; i++) {
    const d = document.createElement('div');
    d.className = 'confetti-piece';
    const colors = ['#ffd700','#e74c3c','#4a90e2','#2ecc71','#a855f7', color];
    d.style.cssText = `
      left:${Math.random() * 100}%;
      background:${colors[Math.floor(Math.random() * colors.length)]};
      animation-delay:${Math.random() * 0.9}s;
      animation-duration:${1.6 + Math.random() * 0.8}s;
      border-radius:${Math.random() > 0.5 ? '50%' : '3px'};
    `;
    box.appendChild(d);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO CLIENT
// ═══════════════════════════════════════════════════════════════

function initSocket() {
  G.socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });

  G.socket.on('disconnect', () => {
    toast('⚠ Disconnected! Reconnecting…', 5000);
  });

  G.socket.on('connect_error', () => {
    toast('⚠ Connection lost. Retrying…', 3000);
  });

  G.socket.on('connect', () => {
    const ls = document.getElementById('screen-loading');
    if (ls) ls.classList.add('hidden');

    if (G.myId && G.myId !== G.socket.id && G.roomCode && G.screen !== 'menu') {
      const myPl = G.players.find(p => p.idx === G.myIdx);
      G.socket.emit('join-room', { code: G.roomCode, name: myPl?.name || 'Player' });
      toast('✅ Reconnected!');
    }
    G.myId = G.socket.id;
  });

  G.socket.on('room-created', ({ code, players, settings }) => {
    G.roomCode = code; G.players = players; G.settings = settings;
    G.isHost = true;  G.isSpec  = false;
    const me = players.find(p => p.id === G.myId);
    if (me) G.myIdx = me.idx;
    showScreen('lobby'); updateLobbyUI();
  });

  G.socket.on('room-joined', ({ code, players, settings, spec, gameState }) => {
    G.roomCode = code; G.players = players; G.settings = settings;
    G.isSpec   = spec;
    const me = players.find(p => p.id === G.myId);
    if (me) G.myIdx = me.idx;
    if (spec && gameState) {
      applyGameState(gameState);
      showScreen('game'); updateHUD();
    } else {
      showScreen('lobby'); updateLobbyUI();
    }
  });

  G.socket.on('join-error', ({ msg }) => { showModalError(msg); });

  G.socket.on('player-joined', ({ name, players }) => {
    G.players = players; updateLobbyUI();
    addChatMsg(document.getElementById('lobby-chat-messages'), { sys: true, text: `${esc(name)} joined the lobby.` });
  });

  G.socket.on('player-left', ({ name, players, newHost }) => {
    G.players = players;
    if (newHost === G.myId) G.isHost = true;
    if (G.screen === 'lobby') updateLobbyUI(); else updateHUD();
    const mc = G.screen === 'lobby'
      ? document.getElementById('lobby-chat-messages')
      : document.getElementById('game-chat-messages');
    if (mc) addChatMsg(mc, { sys: true, text: `${esc(name)} left.` });
  });

  G.socket.on('settings-updated', settings => {
    G.settings = settings;
    if (G.screen === 'lobby') updateLobbyUI();
  });

  G.socket.on('game-started', state => {
    applyGameState(state);
    clearSelection();
    showScreen('game');
    updateHUD();
    if (G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    toast('🎮 Game started!');
  });

  G.socket.on('move-made', data => {
    G.board        = data.board;
    G.turn         = data.turn;
    G.midTurnPiece = data.midTurnPiece;

    if (data.endTurn && G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    updateHUD();

    const isMyTurnNext = G.players[G.turn]?.idx === G.myIdx;
    if (isMyTurnNext && G.midTurnPiece) {
      selectCell(G.midTurnPiece.r, G.midTurnPiece.c);
    } else {
      clearSelection();
    }

    const pi = data.board[ck(data.to.r, data.to.c)];
    playAnimation(data.path, pi);
  });

  G.socket.on('move-rejected', ({ reason }) => { toast('⚠ ' + reason); });

  G.socket.on('turn-skipped', data => {
    if (data.board) G.board = data.board;
    G.turn = data.turn; G.midTurnPiece = null; clearSelection();
    if (G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    toast('⏱ Turn skipped — time limit!');
    updateHUD();
  });

  G.socket.on('turn-ended', data => {
    G.board = data.board; G.turn = data.turn; G.midTurnPiece = null;
    clearSelection(); updateHUD();
    if (G.settings.timerEnabled) startTimer(G.settings.timerSeconds);
    if (data.undone) toast('↩ Turn undone.');
  });

  G.socket.on('game-over', ({ winner, path, from, board }) => {
    G.board = board;
    stopTimer(); clearSelection();
    const pi = board[ck(from.r, from.c)] || winner.idx + 1;
    playAnimation(path || [from, from], pi, () => showWinner(winner));
    playWin();
  });

  G.socket.on('sys-msg', ({ text }) => {
    toast(text, 3500);
    const mc = document.getElementById('game-chat-messages');
    if (mc) addChatMsg(mc, { sys: true, text });
  });

  G.socket.on('chat', data => {
    const lc = document.getElementById('lobby-chat-messages');
    const gc = document.getElementById('game-chat-messages');
    if (G.screen === 'lobby' && lc) addChatMsg(lc, data);
    if (G.screen === 'game'  && gc) addChatMsg(gc, data);
  });

  G.socket.on('err', ({ msg }) => toast('⚠ ' + msg, 3000));
}

function applyGameState(state) {
  G.board    = state.board    || {};
  G.players  = state.players  || [];
  G.turn     = state.turn     || 0;
  G.settings = state.settings || G.settings;
  const me = G.players.find(p => p.id === G.myId);
  if (me) G.myIdx = me.idx;
  G.myTurn = (G.players[G.turn]?.idx === G.myIdx) && !G.isSpec;
}

function showWinner(winner) {
  const col = P_COLORS[winner.idx % 6];
  const nameEl = document.getElementById('winner-name');
  nameEl.textContent = winner.name + ' Wins! 🎉';
  nameEl.style.cssText =
    `background:linear-gradient(135deg,${col.light},${col.main});-webkit-background-clip:text;-webkit-text-fill-color:transparent`;
  document.getElementById('winner-sub').textContent = `Congratulations to ${winner.name}!`;
  spawnConfetti(col.main);
  document.getElementById('modal-winner').style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════
//  MODAL — name / join entry
// ═══════════════════════════════════════════════════════════════

let modalMode = 'host';

function openNameModal(mode) {
  modalMode = mode;
  document.getElementById('modal-name-title').textContent =
    mode === 'host' ? 'Create a Room' : 'Join a Room';
  document.getElementById('modal-join-code-row').style.display = mode === 'join' ? '' : 'none';
  document.getElementById('modal-error').textContent  = '';
  document.getElementById('name-input').value         = '';
  document.getElementById('code-input').value         = '';
  document.getElementById('modal-name').style.display = 'flex';
  setTimeout(() => document.getElementById('name-input').focus(), 60);
}

function showModalError(msg) {
  document.getElementById('modal-error').textContent = msg;
  document.getElementById('modal-name').style.display = 'flex';
}

function closeNameModal() {
  document.getElementById('modal-name').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ═══════════════════════════════════════════════════════════════

function bindUI() {
  // Menu
  document.getElementById('btn-host').addEventListener('click', () => openNameModal('host'));
  document.getElementById('btn-join').addEventListener('click', () => openNameModal('join'));

  // Modal confirm
  document.getElementById('modal-confirm').addEventListener('click', () => {
    const name = document.getElementById('name-input').value.trim() || 'Player';
    G.myName = name;
    if (modalMode === 'host') {
      G.socket.emit('create-room', { name, maxPlayers: 2 });
      closeNameModal();
    } else {
      const code = document.getElementById('code-input').value.trim().toUpperCase();
      if (!code) { showModalError('Enter a room code!'); return; }
      G.socket.emit('join-room', { code, name });
      closeNameModal();
    }
  });
  document.getElementById('modal-cancel').addEventListener('click', closeNameModal);
  document.getElementById('name-input').addEventListener('keydown',
    e => { if (e.key === 'Enter') document.getElementById('modal-confirm').click(); });
  document.getElementById('code-input').addEventListener('keydown',
    e => { if (e.key === 'Enter') document.getElementById('modal-confirm').click(); });

  // Copy room code
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(G.roomCode).then(() => toast('📋 Room code copied!'));
  });

  // Start game
  document.getElementById('btn-start').addEventListener('click', () => {
    G.socket.emit('start-game');
  });

  // Leave lobby
  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    location.reload();
  });

  // Leave game
  document.getElementById('btn-leave-game').addEventListener('click', () => {
    document.getElementById('modal-leave').style.display = 'flex';
  });
  document.getElementById('btn-confirm-leave').addEventListener('click', () => {
    location.reload();
  });
  document.getElementById('btn-cancel-leave').addEventListener('click', () => {
    document.getElementById('modal-leave').style.display = 'none';
  });

  // Mid-turn controls
  document.getElementById('btn-end-turn').addEventListener('click', () => {
    G.socket.emit('end-turn');
  });
  document.getElementById('btn-undo-turn').addEventListener('click', () => {
    G.socket.emit('undo-turn');
  });

  // Settings (host only)
  document.getElementById('set-maxplayers').addEventListener('change', e => {
    G.settings.maxPlayers = +e.target.value;
    G.socket.emit('update-settings', { settings: G.settings });
  });
  document.getElementById('set-timer').addEventListener('change', e => {
    G.settings.timerEnabled = e.target.checked;
    document.getElementById('timer-secs-row').style.display = e.target.checked ? '' : 'none';
    G.socket.emit('update-settings', { settings: G.settings });
  });
  document.getElementById('set-timersecs').addEventListener('change', e => {
    G.settings.timerSeconds = +e.target.value;
    G.socket.emit('update-settings', { settings: G.settings });
  });

  // Chat
  setupChat('lobby-chat-input', 'lobby-chat-send');
  setupChat('game-chat-input',  'game-chat-send');

  // Toggle chat panel
  document.getElementById('btn-toggle-chat').addEventListener('click', () => {
    document.getElementById('game-chat').classList.toggle('hidden');
  });
  document.getElementById('btn-close-chat').addEventListener('click', () => {
    document.getElementById('game-chat').classList.add('hidden');
  });

  // Toggle audio
  document.getElementById('btn-toggle-audio').addEventListener('click', e => {
    G.audioEnabled = !G.audioEnabled;
    e.currentTarget.textContent = G.audioEnabled ? '🔊' : '🔇';
    if (G.audioEnabled && !G.audioCtx) initAudio();
    if (G.audioCtx && G.audioCtx.state === 'suspended') G.audioCtx.resume();
  });

  // Winner modal
  document.getElementById('btn-back-menu').addEventListener('click', () => location.reload());
  document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('modal-winner').style.display = 'none';
    showScreen('lobby'); updateLobbyUI();
  });

  // Close name modal on overlay click
  document.getElementById('modal-name').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-name')) closeNameModal();
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN GAME LOOP
// ═══════════════════════════════════════════════════════════════

let lastRaf = 0;
function gameLoop(ts) {
  const dt = Math.min((ts - lastRaf) / 1000, 0.1);
  lastRaf = ts;
  G.gameTime += dt;
  if (G.anim) { G.anim.update(dt); if (G.anim?.done) G.anim = null; }
  render();
  requestAnimationFrame(gameLoop);
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════

(function init() {
  resizeCanvas();
  initAudio();
  initSocket();
  bindUI();
  showScreen('menu');
  requestAnimationFrame(gameLoop);
})();
