// ============================================================
// Canale WS Server
// ============================================================
// Relay in tempo reale per la piattaforma Canale. Non è una fonte di
// verità: non scrive mai nel database. Il PHP resta l'unica fonte di
// verità (scrive sempre lui) e dopo ogni scrittura chiama questo
// server su POST /broadcast per far arrivare l'evento ai client
// collegati. Se questo server è spento/irraggiungibile, la piattaforma
// PHP continua a funzionare normalmente via polling (questo server è
// puramente additivo, mai un requisito).
//
// Variabili d'ambiente richieste (vedi .env.example):
//   PORT              - porta di ascolto (Render la imposta da sé)
//   INTERNAL_SECRET   - segreto condiviso con PHP (chiamate server-to-server)
//   PHP_BASE_URL      - es. https://tuosito.tld (senza slash finale)
// ============================================================

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const PHP_BASE_URL = (process.env.PHP_BASE_URL || '').replace(/\/+$/, '');

if (!INTERNAL_SECRET) {
  console.error('[FATAL] INTERNAL_SECRET non impostato. Imposta le variabili d\'ambiente prima di avviare.');
  process.exit(1);
}
if (!PHP_BASE_URL) {
  console.error('[FATAL] PHP_BASE_URL non impostato. Imposta le variabili d\'ambiente prima di avviare.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// Health check (utile per Render + per tenerlo sveglio con un servizio di ping esterno,
// dato che i piani gratuiti "addormentano" il servizio dopo un po' di inattività).
app.get('/', (req, res) => {
  res.json({ ok: true, connections: wsConnectionsCount() });
});

// ------------------------------------------------------------
// Stato in memoria (nessun database qui: solo relay)
// ------------------------------------------------------------
// rooms: roomKey ("ch:12", "dm:5") -> Set<ws>
const rooms = new Map();
// usersSockets: userId (number) -> Set<ws>
const usersSockets = new Map();

function wsConnectionsCount() {
  let n = 0;
  for (const set of usersSockets.values()) n += set.size;
  return n;
}

function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws._rooms.add(room);
}

function leaveRoom(ws, room) {
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
  }
  ws._rooms.delete(room);
}

function leaveAllRooms(ws) {
  for (const room of Array.from(ws._rooms)) leaveRoom(ws, room);
}

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket morto, ignora */ }
  }
}

function broadcastToRoom(room, payload) {
  const set = rooms.get(room);
  if (!set) return;
  for (const ws of set) sendJSON(ws, payload);
}

function broadcastToUser(userId, payload) {
  const set = usersSockets.get(userId);
  if (!set) return;
  for (const ws of set) sendJSON(ws, payload);
}

// ------------------------------------------------------------
// Verifica il token contattando ws_auth.php (stessa API usata finora)
// ------------------------------------------------------------
async function resolveIdentity(token) {
  const res = await fetch(`${PHP_BASE_URL}/api/ws_auth.php?token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.id) return null;
  return data; // { id, username, display_name, site_role_id }
}

// Verifica che l'utente possa iscriversi a una stanza (canale/DM), chiedendolo
// a PHP (unica fonte di verità sui permessi/appartenenze).
async function verifyRoomAccess(userId, room) {
  try {
    const res = await fetch(`${PHP_BASE_URL}/api/ws_verify.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify({ user_id: userId, room }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.allowed;
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// POST /broadcast — chiamata interna da PHP dopo ogni scrittura riuscita
// Body: { room?: "ch:12"|"dm:5", user_id?: 42, event: "new_message", data: {...} }
// (usare "room" per eventi di canale/DM, "user_id" per eventi diretti come
// le notifiche o il voice signaling)
// ------------------------------------------------------------
app.post('/broadcast', (req, res) => {
  const secret = req.get('X-Internal-Secret') || '';
  if (secret !== INTERNAL_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { room, user_id, event, data } = req.body || {};
  if (!event) return res.status(400).json({ error: 'missing_event' });

  const payload = { type: event, ...data };
  if (room) broadcastToRoom(room, payload);
  if (user_id) broadcastToUser(Number(user_id), payload);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  ws._rooms = new Set();
  ws.isAlive = true;

  let userId = null;
  try {
    const url = new URL(req.url, 'http://internal');
    const token = url.searchParams.get('token') || '';
    const identity = token ? await resolveIdentity(token) : null;
    if (!identity) {
      ws.close(4001, 'invalid_token');
      return;
    }
    userId = identity.id;
    ws._userId = userId;
    if (!usersSockets.has(userId)) usersSockets.set(userId, new Set());
    usersSockets.get(userId).add(ws);

    sendJSON(ws, { type: 'ready', user_id: userId });
  } catch (e) {
    ws.close(4002, 'auth_error');
    return;
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping':
        sendJSON(ws, { type: 'pong' });
        break;

      case 'subscribe': {
        const room = String(msg.room || '');
        if (!/^(ch|dm):\d+$/.test(room)) return;
        const allowed = await verifyRoomAccess(userId, room);
        if (allowed) {
          joinRoom(ws, room);
          sendJSON(ws, { type: 'subscribed', room });
        } else {
          sendJSON(ws, { type: 'subscribe_denied', room });
        }
        break;
      }

      case 'unsubscribe': {
        const room = String(msg.room || '');
        leaveRoom(ws, room);
        break;
      }

      case 'typing': {
        // Ephemero: relay diretto ai membri della stanza già iscritti,
        // nessuna scrittura su DB necessaria per questo evento.
        const room = String(msg.room || '');
        if (!ws._rooms.has(room)) return; // deve essere già iscritto
        broadcastToRoom(room, { type: 'typing', room, user_id: userId, typing: !!msg.typing });
        break;
      }

      case 'voice_signal': {
        // Relay diretto peer-to-peer (segnalazione WebRTC): non richiede
        // che il destinatario sia iscritto a nessuna stanza, solo che sia
        // connesso. Se non è connesso via WS, il client ha comunque il
        // fallback esistente su api/voice_signal.php (polling).
        const toUserId = Number(msg.to_user_id);
        if (!toUserId) return;
        broadcastToUser(toUserId, {
          type: 'voice_signal',
          from_user_id: userId,
          channel_id: msg.channel_id,
          signal_type: msg.signal_type,
          payload: msg.payload,
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    leaveAllRooms(ws);
    const set = usersSockets.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) usersSockets.delete(userId);
    }
  });
});

// Heartbeat: chiude le connessioni morte (es. rete caduta senza un close pulito)
const HEARTBEAT_MS = 30000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, () => {
  console.log(`Canale WS server in ascolto sulla porta ${PORT}`);
});
