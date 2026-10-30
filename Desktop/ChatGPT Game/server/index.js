/**
 * index.js — Express + Socket.IO server
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { Room } = require('./gameManager.js');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html'))
);
app.get('/game', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/game.html'))
);

// ── Room registry ─────────────────────────────────────────────────────────────
const rooms = new Map(); // code → Room

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) rooms.set(code, new Room(code, io));
  return rooms.get(code);
}

// ── Socket.IO events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentCode = null;

  // ── Join / Create room
  socket.on('joinRoom', ({ code, name }) => {
    if (!code || !name) return socket.emit('error', { msg: 'Missing code or name' });

    name = name.trim().slice(0, 20);
    code = code.toUpperCase().trim();

    const room = getOrCreateRoom(code);

    if (room.players.size >= 8) {
      return socket.emit('error', { msg: 'Room is full (max 8 players)' });
    }
    if (room.state !== 'waiting') {
      return socket.emit('error', { msg: 'Game already in progress' });
    }

    socket.join(code);
    currentRoom = room;
    currentCode = code;

    room.addPlayer(socket.id, name);

    socket.emit('joined', {
      code,
      playerId: socket.id,
      isHost:   room.players.size === 1,
    });

    // Replay any existing strokes (shouldn't happen in waiting, but safety net)
    room.replayStrokes(socket.id);
  });

  // ── Host starts game
  socket.on('startGame', () => {
    if (!currentRoom) return;
    const result = currentRoom.startGame(socket.id);
    if (result?.error) socket.emit('error', { msg: result.error });
  });

  // ── Drawer picked a word
  socket.on('chooseWord', ({ word }) => {
    currentRoom?.chooseWord(socket.id, word);
  });

  // ── Drawing events
  socket.on('draw', (data) => {
    currentRoom?.handleDraw(socket.id, data);
  });

  socket.on('clearCanvas', () => {
    currentRoom?.handleClear(socket.id);
  });

  // ── Chat / Guess
  socket.on('guess', ({ text }) => {
    if (!currentRoom || !text) return;
    text = text.trim().slice(0, 100);
    if (!text) return;
    currentRoom.handleGuess(socket.id, text);
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom || !text) return;
    text = text.trim().slice(0, 100);
    if (!text) return;
    currentRoom.sendChat(socket.id, text);
  });

  // ── Disconnect
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    currentRoom.removePlayer(socket.id);
    if (currentRoom.isEmpty) {
      rooms.delete(currentCode);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎨 Draw & Guess server running at http://localhost:${PORT}\n`);
});
