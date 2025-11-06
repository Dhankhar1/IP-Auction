const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const PDFDocument = require('pdfkit');

// ---- Config ----
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'Storyprotocol';
const INITIAL_TOKENS = 1000;

// Teams and credentials
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

// Queue of players (FIFO)
const playersQueue = [];

const auction = {
  phase: 'idle', // 'idle' | 'running' | 'paused'
  currentPlayer: null,
  currentBid: null, // { teamId, amount }
  history: [], // [{ player, teamId, amount, ts, unsold? }]
  deadlineAt: null, // ms timestamp
};

let deadlineTimer = null;

// ---- Server setup ----
const app = express();
app.set('etag', false);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Hide homepage
app.get(['/', '/index.html'], (_req, res) => res.status(404).send(''));

// Serve static, no-store for html/js/css
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug/state', (_req, res) => res.json(publicState()));

// Player submissions (name only)
app.post('/api/players', (req, res) => {
  const nameRaw = (req.body.name || '').toString().trim();
  if (!nameRaw) return res.status(400).json({ ok: false, error: 'name required' });
  const entry = { name: nameRaw, ts: Date.now() };
  playersQueue.push(entry);

  // Auto-load next player into current slot if idle and none set (do not start)
  if (auction.phase === 'idle' && !auction.currentPlayer) {
    pullNextPlayer();
  }
  queueStateBroadcast();
  res.json({ ok: true, queued: { name: entry.name, position: playersQueue.length } });
});

// PDF export
app.get('/api/export.pdf', (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="auction_results.pdf"');
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(res);

  doc.fontSize(18).text('Auction Results');
  doc.moveDown(0.2).fontSize(10).fillColor('#555').text(new Date().toLocaleString());
  doc.moveDown();

  doc.fillColor('#000').fontSize(14).text('Teams Summary');
  TEAMS.forEach(t => {
    const ts = teamsState.get(t.id);
    doc.fontSize(10).text(`- ${t.name || ''} (ID: ${t.id}) | Tokens: ${ts.tokens}`);
  });
  doc.moveDown();

  doc.fontSize(14).text('Sales History').moveDown(0.3);
  auction.history.forEach((h, i) => {
    const team = h.teamId ? TEAMS.find(t => t.id === h.teamId) : null;
    const status = h.unsold ? 'UNSOLD' : 'SOLD';
    const line = `${i + 1}. ${h.player} | ${status}${team ? ' to ' + (team.name || '') : ''}${h.unsold ? '' : ' for ' + h.amount} | ${new Date(h.ts).toLocaleString()}`;
    doc.fontSize(10).fillColor('#000').text(line);
  });

  doc.end();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Heartbeat state broadcast every 1s (keeps clients synced)
setInterval(() => {
  try { broadcast({ type: 'state', payload: publicState() }); } catch {}
}, 1000);

// ---- Helpers ----
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
      preview: playersQueue.slice(0, 10).map(p => p.name),
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
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function queueStateBroadcast() {
  broadcast({ type: 'state', payload: publicState() });
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
  // Preload next player's name (do not start)
  pullNextPlayer();
}

function markUnsold() {
  if (!auction.currentPlayer) return;
  const ts = Date.now();
  auction.history.unshift({ player: auction.currentPlayer, amount: 0, teamId: null, unsold: true, ts });
  auction.currentPlayer = null;
  auction.currentBid = null;
  // Preload next player's name (do not start)
  pullNextPlayer();
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
          } else if (action === 'next') {
            // Move to next queued player and keep phase idle until admin starts
            pullNextPlayer();
            setPhase('idle');
            clearDeadline();
          } else if (action === 'startNext') {
            pullNextPlayer();
            if (!auction.currentPlayer) throw new Error('No players in queue');
            setPhase('running');
            setDeadline(10);
          } else if (action === 'closeAndSell') {
            closeAndSell();
            clearDeadline();
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
  // eslint-disable-next-line no-console
  console.log(`Live Auction server running on http://localhost:${PORT}`);
});
