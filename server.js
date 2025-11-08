const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

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
  currentBasePrice: null, // number for the current player
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

// Player submissions (name + base price 50-100)
app.post('/api/players', (req, res) => {
  const nameRaw = (req.body.name || '').toString().trim();
  const bpRaw = req.body.basePrice;
  if (!nameRaw) return res.status(400).json({ ok: false, error: 'name required' });
  const basePrice = parseInt(bpRaw, 10);
  if (!Number.isFinite(basePrice) || basePrice < 50 || basePrice > 100) {
    return res.status(400).json({ ok: false, error: 'basePrice must be 50-100' });
  }
  const entry = { name: nameRaw, basePrice, ts: Date.now() };
  playersQueue.push(entry);

  // Auto-load next player into current slot if idle and none set (do not start)
  if (auction.phase === 'idle' && !auction.currentPlayer) {
    pullNextPlayer();
  }
  queueStateBroadcast();
  res.json({ ok: true, queued: { name: entry.name, basePrice: entry.basePrice, position: playersQueue.length } });
});

// Excel export (xlsx)
app.get('/api/export.xlsx', async (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="auction_results.xlsx"');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Results');

  // Title and timestamp
  ws.addRow(['Auction Results']).font = { size: 16, bold: true, color: { argb: 'FF222222' } };
  ws.addRow([new Date().toLocaleString()]).font = { size: 11, color: { argb: 'FF444444' } };
  ws.addRow([]);

  TEAMS.forEach((t, idx) => {
    const ts = teamsState.get(t.id) || { tokens: 0, purchases: [] };
    const header = ws.addRow([`${t.id} / ${t.name || ''}`, `Tokens: ${ts.tokens}`]);
    header.font = { bold: true, color: { argb: 'FF222222' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };

    const colsHeader = ws.addRow(['Time', 'Player', 'Amount']);
    colsHeader.font = { bold: true, color: { argb: 'FF222222' } };

    if (ts.purchases && ts.purchases.length) {
      ts.purchases.slice().reverse().forEach(p => {
        const row = ws.addRow([new Date(p.ts).toLocaleString(), p.player, p.amount]);
        row.font = { color: { argb: 'FF222222' } };
      });
    } else {
      const row = ws.addRow(['-', 'No purchases', '-']);
      row.font = { color: { argb: 'FF444444' }, italic: true };
    }
    ws.addRow([]);
  });

  // Column sizing
  ws.columns = [
    { key: 'time', width: 24 },
    { key: 'player', width: 32 },
    { key: 'amount', width: 12 },
  ];

  // Darken all text a bit
  ws.eachRow(r => r.eachCell(c => { c.font = { ...(c.font||{}), color: { argb: (c.font && c.font.bold) ? 'FF222222' : 'FF222222' } }; }));

  await wb.xlsx.write(res);
  res.end();
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
  const sold = auction.history.filter(h => !h.unsold).length;
  const unsold = auction.history.filter(h => h.unsold).length;
  return {
    auction: {
      phase: auction.phase,
      currentPlayer: auction.currentPlayer,
      currentBid: auction.currentBid,
      currentBasePrice: auction.currentBasePrice,
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
    counts: { sold, unsold }
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

function setPlayer(name, basePrice) {
  auction.currentPlayer = name || null;
  auction.currentBid = null;
  auction.currentBasePrice = basePrice || null;
}

function pullNextPlayer() {
  const next = playersQueue.shift();
  if (next) setPlayer(next.name, next.basePrice);
  else setPlayer(null, null);
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
  auction.currentBasePrice = null;
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
  auction.currentBasePrice = null;
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
            setDeadline(33);
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
            setDeadline(33);
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
          const t = teamsState.get(ws.user.teamId);
          if (!t) throw new Error('Unknown team');
          // Enforce player's base price only for first bid on a player
          if (!auction.currentBid) {
            const base = Math.min(100, Math.max(50, auction.currentBasePrice || 50));
            if (amount < base) throw new Error(`First bid must be ≥ player's base price (${base})`);
          } else {
            if (amount <= current) throw new Error('Bid must be greater than current');
          }
          if (t.tokens < amount) throw new Error('Insufficient tokens');
          auction.currentBid = { teamId: ws.user.teamId, amount };
          setDeadline(33); // extend timer on each bid
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
