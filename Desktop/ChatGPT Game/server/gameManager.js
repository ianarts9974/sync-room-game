/**
 * gameManager.js — Room & game state machine
 *
 * State transitions:
 *   waiting → choosing → drawing → roundEnd → [next round or] gameEnd
 */

const WORDS = require('./words.js');
const ALL_WORDS = Object.values(WORDS).flat();

const ROUND_DURATION_MS  = 60_000;   // 60 seconds per turn
const CHOOSE_DURATION_MS = 15_000;   // word choice window
const ROUND_END_DELAY_MS =  5_000;   // brief reveal before next round

function pickWords(n = 3) {
  const pool = [...ALL_WORDS];
  const chosen = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  return chosen;
}

function maskWord(word) {
  // Replace letters with underscores, keep spaces
  return word.replace(/[^ ]/g, '_');
}

class Room {
  constructor(code, io) {
    this.code      = code;
    this.io        = io;
    this.players   = new Map();   // socketId → { name, score, hasGuessed }
    this.state     = 'waiting';   // waiting | choosing | drawing | roundEnd | gameEnd
    this.round     = 0;
    this.maxRounds = 3;
    this.drawOrder = [];          // socketIds in draw order
    this.drawerIdx = 0;
    this.word      = null;
    this.maskedWord = null;
    this.timer     = null;
    this.roundStart = null;
    this.strokes   = [];          // replay buffer for late joiners
    this.wordChoices = [];
  }

  get drawerSocket() {
    return this.drawOrder[this.drawerIdx] ?? null;
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, { name, score: 0, hasGuessed: false });
    this.broadcastLobby();
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    // If the drawer left, advance
    if (this.state === 'drawing' && socketId === this.drawerSocket) {
      this._nextTurn();
    }
    this.broadcastLobby();
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobbyUpdate', {
      players: this._playerList(),
      state:   this.state,
      round:   this.round,
      maxRounds: this.maxRounds,
    });
  }

  startGame(hostId) {
    if (this.state !== 'waiting') return;
    if (this.players.size < 2) return { error: 'Need at least 2 players' };

    this.round     = 1;
    this.drawOrder = [...this.players.keys()];
    this.drawerIdx = 0;
    this._startTurn();
  }

  // ── Turn lifecycle ──────────────────────────────────────────────────────────

  _startTurn() {
    this.state      = 'choosing';
    this.strokes    = [];
    this.word       = null;
    this.maskedWord = null;

    // Reset guessed flags
    for (const p of this.players.values()) p.hasGuessed = false;

    const drawerId     = this.drawerSocket;
    this.wordChoices   = pickWords(3);

    // Tell drawer to pick a word
    this.io.to(drawerId).emit('pickWord', { choices: this.wordChoices });

    // Tell everyone else who's drawing
    const drawerName = this.players.get(drawerId)?.name ?? 'Someone';
    this.io.to(this.code).except(drawerId).emit('turnInfo', {
      drawerName,
      state: 'choosing',
      round: this.round,
      maxRounds: this.maxRounds,
    });

    this.broadcastLobby();

    // Auto-pick if drawer doesn't choose in time
    this.timer = setTimeout(() => {
      if (this.state === 'choosing') {
        this._beginDrawing(this.wordChoices[0]);
      }
    }, CHOOSE_DURATION_MS);
  }

  chooseWord(socketId, word) {
    if (this.state !== 'choosing') return;
    if (socketId !== this.drawerSocket) return;
    if (!this.wordChoices.includes(word)) return;

    clearTimeout(this.timer);
    this._beginDrawing(word);
  }

  _beginDrawing(word) {
    this.state      = 'drawing';
    this.word       = word;
    this.maskedWord = maskWord(word);
    this.roundStart = Date.now();

    const drawerId   = this.drawerSocket;
    const drawerName = this.players.get(drawerId)?.name ?? 'Someone';

    // Drawer sees the real word
    this.io.to(drawerId).emit('drawingStarted', {
      word,
      maskedWord: this.maskedWord,
      duration: ROUND_DURATION_MS,
      round: this.round,
      maxRounds: this.maxRounds,
    });

    // Others see masked word
    this.io.to(this.code).except(drawerId).emit('drawingStarted', {
      maskedWord: this.maskedWord,
      drawerName,
      duration: ROUND_DURATION_MS,
      round: this.round,
      maxRounds: this.maxRounds,
    });

    this.broadcastLobby();

    this.timer = setTimeout(() => this._endRound(false), ROUND_DURATION_MS);
  }

  handleGuess(socketId, text) {
    if (this.state !== 'drawing') return;
    if (socketId === this.drawerSocket) return;

    const player = this.players.get(socketId);
    if (!player || player.hasGuessed) return;

    const guess = text.trim().toLowerCase();
    const correct = guess === this.word.toLowerCase();

    if (correct) {
      player.hasGuessed = true;

      // Points: more for being fast
      const elapsed = Date.now() - this.roundStart;
      const fraction = Math.max(0, 1 - elapsed / ROUND_DURATION_MS);
      const pts = Math.round(100 + fraction * 400); // 100–500
      player.score += pts;

      // Drawer gets bonus per correct guesser
      const drawer = this.players.get(this.drawerSocket);
      if (drawer) drawer.score += 50;

      this.io.to(this.code).emit('correctGuess', {
        name:   player.name,
        points: pts,
        scores: this._playerList(),
      });

      // Check if everyone guessed
      const guessers = [...this.players.values()].filter(
        (p, _) => _ !== undefined  // keep all
      );
      const nonDrawers = [...this.players.entries()].filter(
        ([id]) => id !== this.drawerSocket
      );
      const allGuessed = nonDrawers.every(([, p]) => p.hasGuessed);
      if (allGuessed) {
        clearTimeout(this.timer);
        this._endRound(true);
      }
    } else {
      // Broadcast guess to everyone as chat
      this.io.to(this.code).emit('chatMessage', {
        name: player.name,
        text,
        isGuess: true,
      });
    }
  }

  _endRound(allGuessed) {
    this.state = 'roundEnd';
    clearTimeout(this.timer);

    this.io.to(this.code).emit('roundEnd', {
      word:    this.word,
      scores:  this._playerList(),
      allGuessed,
    });

    this.timer = setTimeout(() => this._nextTurn(), ROUND_END_DELAY_MS);
  }

  _nextTurn() {
    clearTimeout(this.timer);

    // Advance to next drawer
    this.drawerIdx++;

    if (this.drawerIdx >= this.drawOrder.length) {
      // Completed a full rotation
      this.round++;
      this.drawerIdx = 0;
      // Re-sync draw order (players may have left)
      this.drawOrder = [...this.players.keys()];
    }

    if (this.round > this.maxRounds || this.players.size < 2) {
      this._endGame();
    } else {
      this._startTurn();
    }
  }

  _endGame() {
    this.state = 'gameEnd';
    const sorted = this._playerList().sort((a, b) => b.score - a.score);
    this.io.to(this.code).emit('gameEnd', { scores: sorted });
    clearTimeout(this.timer);
  }

  handleDraw(socketId, data) {
    if (socketId !== this.drawerSocket) return;
    // Store stroke for replay
    this.strokes.push(data);
    // Broadcast to all other clients
    this.io.to(this.code).except(socketId).emit('draw', data);
  }

  handleClear(socketId) {
    if (socketId !== this.drawerSocket) return;
    this.strokes = [];
    this.io.to(this.code).except(socketId).emit('clearCanvas');
  }

  replayStrokes(socketId) {
    for (const stroke of this.strokes) {
      this.io.to(socketId).emit('draw', stroke);
    }
  }

  sendChat(socketId, text) {
    const player = this.players.get(socketId);
    if (!player) return;
    // Don't let chat reveal the word
    const safe = text.replace(new RegExp(this.word ?? '~~~', 'gi'), '***');
    this.io.to(this.code).emit('chatMessage', { name: player.name, text: safe });
  }

  _playerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      name:       p.name,
      score:      p.score,
      hasGuessed: p.hasGuessed,
      isDrawer:   id === this.drawerSocket,
    }));
  }

  get isEmpty() {
    return this.players.size === 0;
  }
}

module.exports = { Room };
