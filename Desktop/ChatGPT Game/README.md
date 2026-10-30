# 🎨 Draw & Guess — Multiplayer Game

A real-time **Skribbl.io-style** drawing and guessing game. One player draws a secret word, everyone else races to type it. No login, no install — just share a room code.

## Quick Start (local)

```bash
cd "ChatGPT Game"
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Railway (free public URL)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. Your game gets a public `*.up.railway.app` URL instantly

## Deploy to Render (alternative)

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server/index.js`

## How to Play

1. One person creates a room → shares the 6-letter code
2. Friends join at the same URL and enter the code
3. Host clicks **Start Game**
4. Each round: one player draws, others type guesses in chat
5. Correct guesses score points — faster = more points
6. After 3 rounds of everyone drawing, the winner is crowned 🏆

## Tech Stack

- **Node.js** + Express
- **Socket.IO** (WebSockets) for real-time sync
- **HTML5 Canvas** for drawing (with touch support)
- Vanilla JS — zero frontend frameworks
