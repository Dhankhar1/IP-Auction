const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// ---- Config ----
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminpass';
const INITIAL_TOKENS = 1000;
const UPDATE_INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_MS || '1000', 10);

// Define teams and credentials (edit as needed)
const TEAMS = [
  { id: 'TEAM1', name: 'Team 1', pass: 'leopard' },
  { id: 'TEAM2', name: 'Team 2', pass: 'tiger' },
  { id: 'TEAM3', name: 'Team 3', pass: 'panther' },
  { id: 'TEAM4', name: 'Team 4', pass: 'cheetah' },
  { id: 'TEAM5', name: 'Team 5', pass: 'lynx' },
  { id: 'TEAM6', name: 'Team 6', pass: 'jaguar' },
];

// In-memory state
const teamsState = new Map(); // teamId -> { tokens, purchases: [] }
TEAMS.forEach(t => teamsState.set(t.id, { tokens: INITIAL_TOKENS, purchases: [] }));

// Queue of submitted players (FIFO)
const playersQueue = [];

const auction = {
  phase: 'idle', // 'idle' | 'running' | 'paused'
  currentPlayer: null,
  currentBid: null, // { teamId, amount }
  history: [], // [{ player, teamId, amount, ts, unsold? }]
  deadlineAt: null, // ms timestamp when bidding window expires
};

let deadlineTimer = null;

// ---- Server setup ----
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Hide homepage
app.get(['/', '/index.html'], (_req, res) => res.status(404).send(''));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Player submissions API
app.post('/api/players', (req, res) => {
  const nameRaw = (req.body.name || '').toString().trim();
  if (!nameRaw) return res.status(400).json({ ok: false, error: 'name required' });
  const entry = { name: nameRaw, ts: Date.now() };
  playersQueue.push(entry);
  queueStateBroadcast();
  res.json({ ok: true, queued: { name: entry.name, position: playersQueue.length } });
});

app.get('/api/players/pending', (_req, res) => {
  res.json({ ok: true, pending: playersQueue.slice(0, 100) });
});

// Export results (JSON or CSV)
app.get('/api/export', (req, res) => {
  const format = (req.query.format || 'json').toString().toLowerCase();
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auction_results.csv"');
    const header = 'timestamp,player,status,team_name,team_id,amount\n';
    const rows = auction.history.map(h => {
      const team = h.teamId ? TEAMS.find(t => t.id === h.teamId) : null;
      const status = h.unsold ? 'unsold' : 'sold';
      const ts = new Date(h.ts).toISOString();
      const name = (team && team.name) ? team.name.replaceAll('"','""') : '';
      return `${ts},"${(h.player||'').replaceAll('"','""')}",${status},"${name}",${team?team.id:''},${h.amount||0}`;
    }).join('\n');
    res.send(header + rows + (rows? '\n':'') );
  } else {
    res.json({
      history: auction.history,
      teams: TEAMS.map(t => ({ id: t.id, name: t.name, tokens: teamsState.get(t.id).tokens, purchases: teamsState.get(t.id).purchases })),
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Helper: broadcast current state to all clients
function publicState() {
  const teams = TEAMS.map(t => ({
    id: t.id,
    name: t.name,
    tokens: teamsState.get(t.id).tokens,
    purchases: teamsState.get(t.id).purchases,
  }));
  const now = Date.now();
  const countdownSeconds = auction.phase === 'running' && auction.deadlineAt
    ? Math.max(0, Math.ceil((auction.deadlineAt - now) / 1000))
    : 0;
  return {
    auction: {
      phase: auction.phase,
      currentPlayer: auction.currentPlayer,
      currentBid: auction.currentBid,
      history: auction.history,
      deadlineAt: auction.deadlineAt,
      countdownSeconds,
    },
    teams,
    queue: {
      count: playersQueue.length,
      upNext: playersQueue[0] ? { name: playersQueue[0].name } : null,
    },
  };
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// Throttled state broadcasts (to make updates less "snappy")
let stateTimer = null;
let lastStateSentAt = 0;
function queueStateBroadcast() {
  const send = () => {
    stateTimer = null;
    lastStateSentAt = Date.now();
    broadcast({ type: 'state', payload: publicState() });
  };
  if (stateTimer) return; // already scheduled
  const since = Date.now() - lastStateSentAt;
  const delay = Math.max(0, UPDATE_INTERVAL_MS - since);
  stateTimer = setTimeout(send, delay);
}

function setTeamName(teamId, name) {
  const t = TEAMS.find(x => x.id === teamId);
  if (t) t.name = name;
}

function ensureLogged(ws) {
  if (!ws.user) throw new Error('Not authenticated');
}

function setPhase(newPhase) {
  auction.phase = newPhase;
}

function setDeadline(seconds) {
  auction.deadlineAt = Date.now() + seconds * 1000;
  startDeadlineTimer();
}

function clearDeadline() {
  auction.deadlineAt = null;
  if (deadlineTimer) { clearInterval(deadlineTimer); deadlineTimer = null; }
}

function startDeadlineTimer() {
  if (deadlineTimer) return; // already running
  deadlineTimer = setInterval(() => {
    if (auction.phase !== 'running' || !auction.deadlineAt) return;
    const now = Date.now();
    if (now >= auction.deadlineAt) {
      // time up
      if (!auction.currentBid) {
        markUnsold();
      } else {
        closeAndSell();
      }
      clearDeadline();
      setPhase('idle');
      queueStateBroadcast();
    }
  }, 250);
}

function setPlayer(name) {
  auction.currentPlayer = name || null;
  auction.currentBid = null;
}

function pullNextPlayer() {
  const next = playersQueue.shift();
  setPlayer(next ? next.name : null);
}

function resetAll() {
  // reset auction
  auction.phase = 'idle';
  auction.currentPlayer = null;
  auction.currentBid = null;
  auction.history = [];
  // reset queue
  playersQueue.length = 0;
  // reset teams
  TEAMS.forEach(t => {
    teamsState.set(t.id, { tokens: INITIAL_TOKENS, purchases: [] });
  });
}

function closeAndSell() {
  if (!auction.currentPlayer || !auction.currentBid) return;
  const { teamId, amount } = auction.currentBid;
  const ts = Date.now();
  auction.history.unshift({ player: auction.currentPlayer, teamId, amount, ts });
  const t = teamsState.get(teamId);
  if (t) {
    t.tokens -= amount;
    t.purchases.unshift({ player: auction.currentPlayer, amount, ts });
  }
  auction.currentPlayer = null;
  auction.currentBid = null;
  auction.phase = 'idle';
}

function markUnsold() {
  if (!auction.currentPlayer) return;
  const ts = Date.now();
  auction.history.unshift({ player: auction.currentPlayer, amount: 0, teamId: null, unsold: true, ts });
  auction.currentPlayer = null;
  auction.currentBid = null;
}

// ---- WebSocket handling ----
wss.on('connection', (ws) => {
  ws.user = null; // { role: 'admin'|'team'|'audience', teamId? }

  send(ws, { type: 'hello', payload: { message: 'connected' } });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) {
      return send(ws, { type: 'error', error: 'Invalid JSON' });
    }

    try {
      switch (msg.type) {
        case 'login': {
          const { role, teamId, pass } = msg;
          if (role === 'admin') {
            if (pass !== ADMIN_PASS) return send(ws, { type: 'login_failed', error: 'Bad credentials' });
            ws.user = { role: 'admin' };
          } else if (role === 'team') {
            const team = TEAMS.find(t => t.id === teamId);
            if (!team || team.pass !== pass) return send(ws, { type: 'login_failed', error: 'Bad credentials' });
            ws.user = { role: 'team', teamId };
          } else if (role === 'audience') {
            ws.user = { role: 'audience' };
          } else {
            return send(ws, { type: 'login_failed', error: 'Unknown role' });
          }
          send(ws, { type: 'login_ok', payload: { role: ws.user.role, teamId: ws.user.teamId || null } });
          send(ws, { type: 'state', payload: publicState() });
          break;
        }
        case 'admin': {
          ensureLogged(ws);
          if (ws.user.role !== 'admin') throw new Error('Forbidden');
          const { action } = msg;
          if (action === 'start') {
            if (!auction.currentPlayer) {
              // if no player set, pull from queue first
              pullNextPlayer();
            }
            if (!auction.currentPlayer) throw new Error('No players in queue');
            setPhase('running');
            setDeadline(10);
          } else if (action === 'pause') {
            setPhase('paused');
            clearDeadline();
          } else if (action === 'setPlayer') {
            setPlayer(String(msg.player || '').trim());
            clearDeadline();
          } else if (action === 'next') {
            // Move to next queued player and keep phase idle until admin starts
            pullNextPlayer();
            setPhase('idle');
            clearDeadline();
          } else if (action === 'closeAndSell') {
            closeAndSell();
            clearDeadline();
          } else if (action === 'resetAll') {
            resetAll();
          } else {
            throw new Error('Unknown admin action');
          }
          queueStateBroadcast();
          break;
        }
        case 'bid': {
          ensureLogged(ws);
          if (ws.user.role !== 'team') throw new Error('Forbidden');
          if (auction.phase !== 'running') throw new Error('Auction not running');
          if (!auction.currentPlayer) throw new Error('No current player');
          const amount = parseInt(msg.amount, 10);
          if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid bid');
          const current = auction.currentBid ? auction.currentBid.amount : 0;
          if (amount <= current) throw new Error('Bid must be greater than current');
          const t = teamsState.get(ws.user.teamId);
          if (!t || t.tokens < amount) throw new Error('Insufficient tokens');
          auction.currentBid = { teamId: ws.user.teamId, amount };
          setDeadline(10); // extend timer on each bid
          queueStateBroadcast();
          break;
        }
        case 'team': {
          ensureLogged(ws);
          if (ws.user.role !== 'team') throw new Error('Forbidden');
          const { action } = msg;
          if (action === 'setName') {
            const newName = String(msg.name || '').trim().slice(0, 40);
            if (!newName) throw new Error('Name required');
            setTeamName(ws.user.teamId, newName);
          } else {
            throw new Error('Unknown team action');
          }
          queueStateBroadcast();
          break;
        }
        default:
          send(ws, { type: 'error', error: 'Unknown message type' });
      }
    } catch (err) {
      send(ws, { type: 'error', error: err.message || String(err) });
    }
  });

  ws.on('close', () => { /* noop */ });
});

server.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Live Auction server running on http://localhost:${PORT}`);
});
