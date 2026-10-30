/**
 * game.js — Client-side game logic
 * Handles: Socket.IO events, canvas drawing, timer, chat
 */

// ── Session data ─────────────────────────────────────────────────────────────
const roomCode   = new URLSearchParams(location.search).get('room') ?? sessionStorage.getItem('roomCode');
const playerName = sessionStorage.getItem('playerName') ?? 'Player';
let   isHost     = sessionStorage.getItem('isHost') === '1';
let   isDrawer   = false;
let   roundDuration = 60_000;
let   roundStart    = 0;
let   timerRAF      = null;

if (!roomCode) { location.href = '/'; }

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io();

// Re-join in case of refresh
socket.emit('joinRoom', { code: roomCode, name: playerName });

socket.on('joined', ({ code, playerId, isHost: host }) => {
  isHost = host;
  document.getElementById('display-code').textContent = code;
  sessionStorage.setItem('isHost', host ? '1' : '0');
  showOverlay('lobby');
});

socket.on('error', ({ msg }) => {
  alert('⚠️ ' + msg);
  location.href = '/';
});

// ── Lobby / player list ───────────────────────────────────────────────────────
socket.on('lobbyUpdate', ({ players, state, round, maxRounds }) => {
  renderLobbyPlayers(players);
  if (state === 'waiting') {
    showOverlay('lobby');
    const canStart = players.length >= 2;
    const startBtn  = document.getElementById('btn-start');
    const startHint = document.getElementById('start-hint');
    if (isHost) {
      document.getElementById('host-controls').classList.remove('hidden');
      document.getElementById('guest-waiting').classList.add('hidden');
      startBtn.disabled = !canStart;
      startHint.textContent = canStart
        ? `${players.length} players ready — start when you like!`
        : 'You need at least 2 players to start.';
    } else {
      document.getElementById('guest-waiting').classList.remove('hidden');
      document.getElementById('host-controls').classList.add('hidden');
    }
  }
  // Always refresh scoreboard if game running
  if (state !== 'waiting' && state !== 'gameEnd') {
    renderScoreboard(players, round, maxRounds);
  }
});

function renderLobbyPlayers(players) {
  const el = document.getElementById('lobby-players');
  el.innerHTML = '';
  players.forEach((p, i) => {
    const pill = document.createElement('div');
    pill.className = 'pill' + (i === 0 ? ' host' : '');
    pill.textContent = (i === 0 ? '👑 ' : '') + p.name;
    el.appendChild(pill);
  });
}

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('startGame');
});

// Room code copy
document.getElementById('display-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    const el = document.getElementById('display-code');
    const orig = el.textContent;
    el.textContent = '✅ Copied!';
    setTimeout(() => (el.textContent = orig), 1500);
  });
});

// ── Word picking (drawer) ────────────────────────────────────────────────────
socket.on('pickWord', ({ choices }) => {
  const container = document.getElementById('word-choices');
  container.innerHTML = '';
  choices.forEach(w => {
    const btn = document.createElement('button');
    btn.className = 'word-choice-btn';
    btn.textContent = w;
    btn.addEventListener('click', () => {
      socket.emit('chooseWord', { word: w });
      hideAllOverlays();
    });
    container.appendChild(btn);
  });
  showOverlay('pick');
});

// ── Drawing started ───────────────────────────────────────────────────────────
socket.on('drawingStarted', ({ word, maskedWord, drawerName, duration, round, maxRounds }) => {
  hideAllOverlays();
  showGameUI();

  isDrawer = !!word;   // drawer receives the real word; others get maskedWord
  roundDuration = duration;
  roundStart = Date.now();

  // Word display
  const wd = document.getElementById('word-display');
  if (isDrawer) {
    wd.textContent = word;
    wd.title = '';
    document.getElementById('draw-toolbar').classList.remove('hidden');
    document.getElementById('viewer-hint').classList.add('hidden');
    enableCanvas(true);
    addSystemMsg(`🎨 Draw: "${word}"!`);
  } else {
    wd.textContent = maskedWord;
    document.getElementById('draw-toolbar').classList.add('hidden');
    document.getElementById('viewer-hint').classList.remove('hidden');
    enableCanvas(false);
    addSystemMsg(`✏️ ${drawerName} is drawing! Guess the word!`);
    clearCanvas();
  }

  // Round badge
  document.getElementById('round-badge').textContent = `R${round}/${maxRounds}`;

  // Start timer
  startTimer(duration);
});

// ── Turn info for non-drawers during choosing phase ──────────────────────────
socket.on('turnInfo', ({ drawerName, round, maxRounds }) => {
  hideAllOverlays();
  showGameUI();
  isDrawer = false;
  enableCanvas(false);
  document.getElementById('word-display').textContent = '⏳ Picking a word…';
  document.getElementById('draw-toolbar').classList.add('hidden');
  document.getElementById('viewer-hint').classList.remove('hidden');
  document.getElementById('round-badge').textContent = `R${round}/${maxRounds}`;
  addSystemMsg(`✏️ ${drawerName} is choosing a word…`);
  clearCanvas();
});

// ── Correct guess ─────────────────────────────────────────────────────────────
socket.on('correctGuess', ({ name, points, scores }) => {
  addSystemMsg(`✅ ${name} guessed correctly! +${points} pts`);
  renderScoreboard(scores);
});

// ── Chat messages ─────────────────────────────────────────────────────────────
socket.on('chatMessage', ({ name, text, isGuess }) => {
  addChatMsg(name, text, isGuess ? 'guess' : '');
});

// ── Round end ─────────────────────────────────────────────────────────────────
socket.on('roundEnd', ({ word, scores, allGuessed }) => {
  stopTimer();
  document.getElementById('reveal-word').textContent = word;
  renderScoreList('roundend-scores', scores);
  showOverlay('roundend');
  isDrawer = false;
  enableCanvas(false);
});

// ── Game end ──────────────────────────────────────────────────────────────────
socket.on('gameEnd', ({ scores }) => {
  stopTimer();
  renderScoreList('gameend-scores', scores, true);
  showOverlay('gameend');
});

// ── Draw relay ────────────────────────────────────────────────────────────────
socket.on('draw', (data) => {
  if (isDrawer) return;   // don't echo back to self
  remoteStroke(data);
});

socket.on('clearCanvas', () => {
  if (!isDrawer) clearCanvas();
});

// ═══════════════════════════════════════════════════════════
// CANVAS
// ═══════════════════════════════════════════════════════════

const canvas = document.getElementById('main-canvas');
const ctx    = canvas.getContext('2d');
let   drawing = false;
let   lastX = 0, lastY = 0;
let   currentColor = '#1a1a1a';
let   brushSize = 8;
let   eraser = false;

// Resize canvas to fill its container
function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  // Save pixel ratio for hi-DPI
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function enableCanvas(on) {
  canvas.style.cursor = on ? 'crosshair' : 'default';
  canvas.style.pointerEvents = on ? 'auto' : 'none';
}

// ── Pointer events (mouse + touch) ────────────────────────────────────────────
function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left),
    y: (src.clientY - rect.top),
  };
}

function startDraw(e) {
  if (!isDrawer) return;
  e.preventDefault();
  drawing = true;
  const { x, y } = getPos(e);
  lastX = x; lastY = y;
  // Emit a dot
  emitStroke(x, y, x, y);
}

function moveDraw(e) {
  if (!isDrawer || !drawing) return;
  e.preventDefault();
  const { x, y } = getPos(e);
  emitStroke(lastX, lastY, x, y);
  drawStroke(lastX, lastY, x, y, currentColor, brushSize, eraser);
  lastX = x; lastY = y;
}

function endDraw(e) {
  if (!isDrawer) return;
  drawing = false;
}

canvas.addEventListener('mousedown',  startDraw);
canvas.addEventListener('mousemove',  moveDraw);
canvas.addEventListener('mouseup',    endDraw);
canvas.addEventListener('mouseleave', endDraw);
canvas.addEventListener('touchstart', startDraw, { passive: false });
canvas.addEventListener('touchmove',  moveDraw,  { passive: false });
canvas.addEventListener('touchend',   endDraw);

function drawStroke(x0, y0, x1, y1, color, size, isEraser) {
  ctx.save();
  ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = color;
  ctx.lineWidth   = size;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

function remoteStroke({ x0, y0, x1, y1, color, size, isEraser, cw, ch }) {
  // Scale from sender's canvas dimensions
  const scaleX = canvas.clientWidth  / (cw || canvas.clientWidth);
  const scaleY = canvas.clientHeight / (ch || canvas.clientHeight);
  drawStroke(x0*scaleX, y0*scaleY, x1*scaleX, y1*scaleY, color, size, isEraser);
}

function emitStroke(x0, y0, x1, y1) {
  const data = {
    x0, y0, x1, y1,
    color: currentColor,
    size:  brushSize,
    isEraser: eraser,
    cw: canvas.clientWidth,
    ch: canvas.clientHeight,
  };
  socket.emit('draw', data);
  // Also draw locally immediately
  drawStroke(x0, y0, x1, y1, currentColor, brushSize, eraser);
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
const PALETTE = [
  '#1a1a1a','#ffffff','#ef4444','#f97316','#eab308',
  '#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899',
  '#92400e','#6b7280','#d97706','#065f46','#1e40af',
];

const swatchContainer = document.getElementById('color-swatches');
PALETTE.forEach(c => {
  const s = document.createElement('div');
  s.className = 'swatch';
  s.style.background = c;
  s.title = c;
  s.dataset.color = c;
  s.addEventListener('click', () => {
    eraser = false;
    currentColor = c;
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    document.getElementById('btn-eraser').style.opacity = '1';
  });
  swatchContainer.appendChild(s);
});
// Activate first swatch
swatchContainer.firstChild?.classList.add('active');

document.getElementById('brush-size').addEventListener('input', e => {
  brushSize = +e.target.value;
});

document.getElementById('btn-eraser').addEventListener('click', () => {
  eraser = !eraser;
  document.getElementById('btn-eraser').style.opacity = eraser ? '0.5' : '1';
});

document.getElementById('btn-clear').addEventListener('click', () => {
  clearCanvas();
  socket.emit('clearCanvas');
});

// ═══════════════════════════════════════════════════════════
// TIMER
// ═══════════════════════════════════════════════════════════

function startTimer(durationMs) {
  stopTimer();
  const bar = document.getElementById('timer-bar');
  const txt = document.getElementById('timer-text');
  bar.classList.remove('warn', 'danger');

  function tick() {
    const elapsed = Date.now() - roundStart;
    const pct     = Math.max(0, 1 - elapsed / durationMs) * 100;
    const secsLeft = Math.ceil((durationMs - elapsed) / 1000);

    bar.style.setProperty('--pct', pct + '%');
    txt.textContent = Math.max(0, secsLeft);

    bar.classList.toggle('warn',   secsLeft <= 30 && secsLeft > 10);
    bar.classList.toggle('danger', secsLeft <= 10);

    if (elapsed < durationMs) {
      timerRAF = requestAnimationFrame(tick);
    } else {
      txt.textContent = '0';
      bar.style.setProperty('--pct', '0%');
    }
  }

  timerRAF = requestAnimationFrame(tick);
}

function stopTimer() {
  if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }
}

// ═══════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════

function addChatMsg(name, text, type = '') {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + type;
  div.innerHTML = `<span class="cm-name">${escHtml(name)}:</span> ${escHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function addSystemMsg(text) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

const chatInput = document.getElementById('chat-input');

document.getElementById('btn-send').addEventListener('click', sendGuess);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendGuess(); });

function sendGuess() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  socket.emit('guess', { text });
  // If drawer, send as chat only (server will filter)
  if (isDrawer) addChatMsg(playerName, text, '');
}

// ═══════════════════════════════════════════════════════════
// SCOREBOARD
// ═══════════════════════════════════════════════════════════

function renderScoreboard(players, round, maxRounds) {
  const el = document.getElementById('scoreboard');
  el.innerHTML = '';
  if (round !== undefined && maxRounds !== undefined) {
    document.getElementById('round-badge').textContent = `R${round}/${maxRounds}`;
  }
  [...players].sort((a, b) => b.score - a.score).forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'score-item'
      + (p.isDrawer  ? ' is-drawer' : '')
      + (p.hasGuessed ? ' guessed'  : '');
    div.innerHTML = `
      <span class="si-icon">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  '}</span>
      <span class="si-name">${escHtml(p.name)}${p.isDrawer ? ' ✏️' : ''}</span>
      <span class="si-pts">${p.score}</span>
    `;
    el.appendChild(div);
  });
}

function renderScoreList(containerId, players, withRank = false) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  [...players].sort((a, b) => b.score - a.score).forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'score-item';
    div.innerHTML = `
      <span class="si-icon">${withRank ? (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`) : ''}</span>
      <span class="si-name">${escHtml(p.name)}</span>
      <span class="si-pts">${p.score} pts</span>
    `;
    el.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════
// OVERLAY HELPERS
// ═══════════════════════════════════════════════════════════

function hideAllOverlays() {
  ['lobby','pick','roundend','gameend'].forEach(id => {
    document.getElementById(`overlay-${id}`)?.classList.add('hidden');
  });
}

function showOverlay(id) {
  hideAllOverlays();
  document.getElementById(`overlay-${id}`)?.classList.remove('hidden');
}

function showGameUI() {
  document.getElementById('game-ui').classList.remove('hidden');
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
