const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const frontendUrl = process.env.FRONTEND_URL;
const allowedOrigins = frontendUrl 
  ? [frontendUrl] 
  : ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173", "http://127.0.0.1:5173"];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

// Provide health check endpoint for verification
app.get('/health', (req, res) => {
  res.json({ status: "ok", service: "star-game-backend" });
});

// Serve frontend statically only in local development (when FRONTEND_URL is not configured)
if (!frontendUrl) {
  console.log("Serving static frontend files for local development...");
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
  });
  app.use(express.static(path.join(__dirname, '../client')));
} else {
  console.log(`Express frontend serving disabled in production (FRONTEND_URL=${frontendUrl}).`);
  app.get('/', (req, res) => {
    res.json({ status: "ok", service: "star-game-backend" });
  });
}

const PORT = process.env.PORT || 3000;

const CATEGORY_POOL = [
  {name:'Apple', emoji:'🍎'}, {name:'Banana', emoji:'🍌'}, {name:'Mango', emoji:'🥭'},
  {name:'Orange', emoji:'🍊'}, {name:'Grapes', emoji:'🍇'}, {name:'Watermelon', emoji:'🍉'},
  {name:'Strawberry', emoji:'🍓'}, {name:'Coconut', emoji:'🥥'}, {name:'Pineapple', emoji:'🍍'},
  {name:'Peach', emoji:'🍑'}, {name:'Cherry', emoji:'🍒'}, {name:'Kiwi', emoji:'🥝'}
];

const MIN_PLAYERS = 2; // User requested support for 2-8 players
const MAX_PLAYERS = 8;
const REACTION_WINDOW_MS = 8000;
const LOCK_MS = 1500; // Small penalty (1.5-second lockout) for false stars

// Room storage
const rooms = new Map(); // key: normalized code, value: room state

function normalizeCode(code) {
  if (!code) return '';
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateRoomCode() {
  let code;
  let normalized;
  do {
    const num = Math.floor(1000 + Math.random() * 9000);
    code = `STAR-${num}`;
    normalized = normalizeCode(code);
  } while (rooms.has(normalized));
  return { code, normalized };
}

// Helper to sanitize room state for a specific player (Card Privacy)
function getSanitizedRoom(room, playerId) {
  const sanitized = { ...room };
  sanitized.hands = {};
  for (const pid in room.hands) {
    if (pid === playerId) {
      sanitized.hands[pid] = room.hands[pid];
    } else {
      // Hide category and card details of other players, expose length and card IDs only
      sanitized.hands[pid] = room.hands[pid].map(c => ({ id: c.id, hidden: true }));
    }
  }
  return sanitized;
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    if (p.socketId) {
      const sanitized = getSanitizedRoom(room, p.id);
      io.to(p.socketId).emit('room-updated', sanitized);
    }
  });
}

function buildDeck(playerCount) {
  const pool = [...CATEGORY_POOL].sort(() => Math.random() - 0.5).slice(0, playerCount);
  const cats = pool.map((c, i) => ({ id: 'cat' + i, name: c.name, emoji: c.emoji }));
  let cards = [];
  cats.forEach(cat => {
    for (let i = 0; i < 4; i++) {
      cards.push({ id: 'card_' + Math.random().toString(36).slice(2, 9), catId: cat.id });
    }
  });
  cards = cards.sort(() => Math.random() - 0.5);
  return { cats, cards };
}

function handHasFour(hand) {
  if (!hand) return null;
  const counts = {};
  hand.forEach(c => {
    counts[c.catId] = (counts[c.catId] || 0) + 1;
  });
  for (const k in counts) {
    if (counts[k] >= 4) return k;
  }
  return null;
}

function nextIndex(room, idx) {
  return (idx + 1) % room.turnOrder.length;
}

io.on('connection', (socket) => {
  console.log("Player connected:", socket.id);
  let currentRoomCode = null;
  let currentPlayerId = null;

  // Cleanup helper on disconnect/leave
  function handleDisconnectOrLeave() {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === currentPlayerId);
    if (player) {
      player.connected = false;
      player.socketId = null;
    }

    // Check if anyone is still connected
    const activePlayers = room.players.filter(p => p.connected);
    if (activePlayers.length === 0) {
      // Room is empty, set a cleanup timer (e.g. remove room after 10 minutes)
      room.cleanupTimeout = setTimeout(() => {
        const r = rooms.get(currentRoomCode);
        if (r && r.players.filter(p => p.connected).length === 0) {
          rooms.delete(currentRoomCode);
          console.log(`Room ${currentRoomCode} deleted due to inactivity.`);
        }
      }, 600000);
    } else {
      // If the host disconnected, assign host to the next active player
      if (room.hostId === currentPlayerId) {
        room.hostId = activePlayers[0].id;
      }
      broadcastRoom(room);
    }
  }

  // CREATE ROOM
  socket.on('create-room', (data, callback) => {
    const { name, avatar, maxPlayers } = data;
    if (!name || !name.trim()) {
      return callback({ success: false, error: 'Name is required' });
    }

    const { code, normalized } = generateRoomCode();
    const limit = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Number(maxPlayers) || 4));

    const room = {
      code,
      normalizedCode: normalized,
      hostId: null,
      status: 'lobby',
      minPlayers: MIN_PLAYERS,
      maxPlayers: limit,
      players: [],
      categories: [],
      turnOrder: [],
      hands: {},
      actingIndex: 0,
      locks: {},
      reactionEntries: [],
      starWinnerId: null,
      winningCatId: null,
      starDeclaredAt: null,
      reactionStartAt: null,
      createdAt: Date.now()
    };

    const playerId = 'p-' + Math.random().toString(36).slice(2, 9);
    room.hostId = playerId;
    room.players.push({
      id: playerId,
      name: name.trim(),
      avatar: avatar,
      ready: true, // Host is ready by default
      connected: true,
      socketId: socket.id
    });

    rooms.set(normalized, room);
    currentRoomCode = normalized;
    currentPlayerId = playerId;

    socket.join(normalized);
    callback({ success: true, roomCode: code, playerId, room: getSanitizedRoom(room, playerId) });
    console.log(`Room created: ${code} by ${name}`);
  });

  // JOIN ROOM
  socket.on('join-room', (data, callback) => {
    const { roomCode, name, avatar } = data;
    const normalized = normalizeCode(roomCode);
    const room = rooms.get(normalized);

    if (!room) {
      return callback({ success: false, error: 'Room not found' });
    }
    if (room.status !== 'lobby') {
      return callback({ success: false, error: 'Game has already started' });
    }
    if (room.players.length >= room.maxPlayers) {
      return callback({ success: false, error: 'Room is full' });
    }
    if (!name || !name.trim()) {
      return callback({ success: false, error: 'Name is required' });
    }

    // Cancel any room cleanup timeout
    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
    }

    const playerId = 'p-' + Math.random().toString(36).slice(2, 9);
    room.players.push({
      id: playerId,
      name: name.trim(),
      avatar: avatar,
      ready: false,
      connected: true,
      socketId: socket.id
    });

    currentRoomCode = normalized;
    currentPlayerId = playerId;

    socket.join(normalized);
    callback({ success: true, roomCode: room.code, playerId, room: getSanitizedRoom(room, playerId) });
    broadcastRoom(room);
    console.log(`Player ${name} joined room ${room.code}`);
  });

  // RECONNECT PLAYER
  socket.on('reconnect-player', (data, callback) => {
    const { roomCode, playerId } = data;
    const normalized = normalizeCode(roomCode);
    const room = rooms.get(normalized);

    if (!room) {
      return callback({ success: false, error: 'Room not found' });
    }

    const player = room.players.find(p => p.id === playerId);
    if (!player) {
      return callback({ success: false, error: 'Player not found in this room' });
    }

    // Cancel cleanup timeout
    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
    }

    player.connected = true;
    player.socketId = socket.id;

    currentRoomCode = normalized;
    currentPlayerId = playerId;

    socket.join(normalized);
    callback({ success: true, room: getSanitizedRoom(room, playerId) });
    broadcastRoom(room);
    console.log(`Player ${player.name} reconnected to room ${room.code}`);
  });

  // TOGGLE READY
  socket.on('toggle-ready', () => {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'lobby') return;

    const player = room.players.find(p => p.id === currentPlayerId);
    if (player) {
      player.ready = !player.ready;
      broadcastRoom(room);
    }
  });

  // START GAME
  socket.on('start-game', () => {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'lobby') return;

    // Only host can start
    if (room.hostId !== currentPlayerId) return;

    // Verify player count
    if (room.players.length < room.minPlayers || room.players.length > room.maxPlayers) return;

    // Verify all players ready
    if (!room.players.every(p => p.ready)) return;

    const { cats, cards } = buildDeck(room.players.length);
    room.categories = cats;
    const order = room.players.map(p => p.id);
    room.turnOrder = order;

    // Deal cards (4 cards each)
    const hands = {};
    let idx = 0;
    room.players.forEach(p => {
      hands[p.id] = cards.slice(idx, idx + 4);
      idx += 4;
    });
    room.hands = hands;

    room.actingIndex = Math.floor(Math.random() * order.length);
    room.status = 'countdown';
    room.countdownAt = Date.now();
    room.starWinnerId = null;
    room.winningCatId = null;
    room.reactionEntries = [];
    room.reactionStartAt = null;
    room.locks = {};
    room.falseStarBy = null;
    room.lastPass = null;

    broadcastRoom(room);

    // Auto transition from countdown to playing after 3.5 seconds
    setTimeout(() => {
      const r = rooms.get(currentRoomCode);
      if (r && r.status === 'countdown') {
        r.status = 'playing';
        broadcastRoom(r);
      }
    }, 3500);
  });

  // PASS CARD
  socket.on('pass-card', (data) => {
    const { cardId } = data;
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;

    const activePlayerId = room.turnOrder[room.actingIndex];
    if (activePlayerId !== currentPlayerId) return; // Not their turn

    // Check lockouts
    if (room.locks[currentPlayerId] && room.locks[currentPlayerId] > Date.now()) return;

    const hand = room.hands[currentPlayerId];
    if (!hand) return;

    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return; // Player doesn't own this card

    // Pass the card
    const [card] = hand.splice(cardIdx, 1);
    const nextIdx = (room.actingIndex + 1) % room.turnOrder.length;
    const receiverId = room.turnOrder[nextIdx];

    room.hands[receiverId].push(card);
    room.actingIndex = nextIdx;

    room.lastPass = {
      from: currentPlayerId,
      to: receiverId,
      catId: card.catId,
      at: Date.now()
    };

    broadcastRoom(room);
  });

  // DECLARE STAR
  socket.on('declare-star', () => {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;

    // Check lockout
    if (room.locks[currentPlayerId] && room.locks[currentPlayerId] > Date.now()) return;

    const hand = room.hands[currentPlayerId];
    const categoryId = handHasFour(hand);

    if (categoryId) {
      // Valid STAR!
      room.status = 'starDeclared';
      room.starWinnerId = currentPlayerId;
      room.winningCatId = categoryId;
      room.starDeclaredAt = Date.now();
      room.reactionEntries = [];

      broadcastRoom(room);

      // Transition to reaction phase after 1.4 seconds
      setTimeout(() => {
        const r = rooms.get(currentRoomCode);
        if (r && r.status === 'starDeclared') {
          r.status = 'reaction';
          r.reactionStartAt = Date.now();
          broadcastRoom(r);

          // Force finalize results after 8 seconds of reaction window
          const currentReactionStart = r.reactionStartAt;
          setTimeout(() => {
            const r2 = rooms.get(currentRoomCode);
            if (r2 && r2.status === 'reaction' && r2.reactionStartAt === currentReactionStart) {
              finalizeGameResults(r2);
            }
          }, REACTION_WINDOW_MS);
        }
      }, 1400);
    } else {
      // False STAR!
      room.locks[currentPlayerId] = Date.now() + LOCK_MS;
      room.falseStarBy = {
        id: currentPlayerId,
        at: Date.now()
      };
      // Send false star alert to the player/room
      io.to(room.normalizedCode).emit('false-star', { playerId: currentPlayerId });
      broadcastRoom(room);
    }
  });

  // SEND REACTION
  socket.on('send-reaction', () => {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'reaction') return;

    // Winner doesn't react
    if (room.starWinnerId === currentPlayerId) return;

    // Check duplicate reaction
    if (room.reactionEntries.find(e => e.id === currentPlayerId)) return;

    room.reactionEntries.push({
      id: currentPlayerId,
      t: Date.now() - room.reactionStartAt
    });

    broadcastRoom(room);

    // If all other active players reacted, finalize immediately
    const othersCount = room.players.filter(p => p.id !== room.starWinnerId && p.connected).length;
    if (room.reactionEntries.length >= othersCount) {
      finalizeGameResults(room);
    }
  });

  function finalizeGameResults(room) {
    if (room.status !== 'reaction') return;

    const others = room.players.filter(p => p.id !== room.starWinnerId).map(p => p.id);
    const reacted = [...room.reactionEntries].sort((a, b) => a.t - b.t);
    const reactedIds = reacted.map(e => e.id);
    const nonReactedIds = others.filter(id => !reactedIds.includes(id));

    // Ranking order: [winner, ...reacted in order, ...non-reacted in no specific order]
    room.finalRanking = [room.starWinnerId, ...reactedIds, ...nonReactedIds];
    room.status = 'results';

    broadcastRoom(room);
    console.log(`Room ${room.code} game finished. Winner: ${room.starWinnerId}`);
  }

  // PLAY AGAIN
  socket.on('play-again', () => {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'results') return;

    // Only host can reset
    if (room.hostId !== currentPlayerId) return;

    room.status = 'lobby';
    room.players.forEach(p => {
      p.ready = (p.id === room.hostId); // Host is ready, others are reset to not ready
    });
    room.hands = {};
    room.categories = [];
    room.starWinnerId = null;
    room.winningCatId = null;
    room.finalRanking = null;
    room.reactionEntries = [];
    room.falseStarBy = null;
    room.lastPass = null;

    broadcastRoom(room);
  });

  // LEAVE ROOM
  socket.on('leave-room', () => {
    handleDisconnectOrLeave();
    socket.leave(currentRoomCode);
    currentRoomCode = null;
    currentPlayerId = null;
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log("Player disconnected:", socket.id);
    handleDisconnectOrLeave();
  });
});

server.listen(PORT, () => {
  console.log(`⭐⭐ STAR GAME Server is running on port ${PORT} ⭐⭐`);
});
