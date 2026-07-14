'use strict';
// WA-AI-Bot v6.0

// ─── GLOBAL CRASH PROTECTION ──────────────────────────────────────
// Without these, ANY unhandled async error inside whatsapp-web.js or
// Puppeteer kills the entire Node.js process and Railway has to restart.
// These handlers log the error and keep the bot alive.
process.on('unhandledRejection', function(reason) {
  var msg = (reason && reason.message) ? reason.message : String(reason);
  console.error('[unhandledRejection]', msg);
  // Known recoverable errors — just log and continue
});
process.on('uncaughtException', function(err) {
  var msg = (err && err.message) ? err.message : String(err);
  console.error('[uncaughtException]', msg);
  // Known recoverable Puppeteer/WhatsApp errors — keep running
  if (msg.indexOf('Execution context was destroyed') !== -1 ||
      msg.indexOf('detached Frame')                !== -1 ||
      msg.indexOf('Session closed')                !== -1 ||
      msg.indexOf('Target closed')                 !== -1 ||
      msg.indexOf('Protocol error')                !== -1 ||
      msg.indexOf('auth timeout')                  !== -1 ||
      msg.indexOf('timeout')                       !== -1) {
    console.error('[uncaughtException] Recoverable — continuing');
    return;
  }
  // Other errors — log stack but stay alive
  if (err && err.stack) console.error(err.stack);
});

var fs   = require('fs');
var path = require('path');

// Remove Chromium lock files left by Docker/Railway restarts
function cleanLocks(dir) {
  var names = ['SingletonLock','SingletonCookie','SingletonSocket'];
  function walk(d, depth) {
    if (depth > 4) return;
    var entries; try { entries = fs.readdirSync(d, {withFileTypes:true}); } catch(e){ return; }
    entries.forEach(function(e) {
      var full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth+1);
      else if (names.indexOf(e.name) !== -1) {
        try { fs.unlinkSync(full); console.log('[lock] removed:', full); } catch(_){}
      }
    });
  }
  if (dir && fs.existsSync(dir)) walk(dir, 0);
}

var WWebJS    = require('whatsapp-web.js');
var Client    = WWebJS.Client;
var LocalAuth = WWebJS.LocalAuth;
var qrTerm    = require('qrcode-terminal');
var QRCode    = require('qrcode');
var OpenAI    = require('openai');
var express   = require('express');
var http      = require('http');
var ioMod     = require('socket.io');

// Config
var OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
var OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
var WAIT_MINUTES   = Math.max(0.1, parseFloat(process.env.WAIT_MINUTES || '5'));
var WAIT_MS        = Math.round(WAIT_MINUTES * 60 * 1000);
var PORT           = parseInt(process.env.PORT || '3000', 10);
var AUTH_DIR       = process.env.WA_AUTH_DIR || path.resolve('./wwebjs_auth');
var KEEPALIVE_MS   = 18000;

var AI_PROMPT = process.env.AI_PROMPT ||
  'Eres Jose Miguel y respondes a tus contactos de WhatsApp en su lugar mientras no esta disponible. ' +
  'Habla en primera persona como si fueras el. Tono profesional, calido, empatico y resolutivo. ' +
  'Lenguaje pulcro y ejecutivo sin tecnicismos innecesarios. Suena humano, fluido y organico. ' +
  'NUNCA digas que eres una IA, asistente virtual o bot. Si te preguntan directamente, admite que ' +
  'eres una respuesta automatica con naturalidad y vuelve enseguida al tema. No uses frases como ' +
  '"Como modelo de lenguaje" ni saludos robóticos. Detecta el idioma del usuario y responde en el ' +
  'mismo idioma exacto. Prioriza la brevedad: si dos frases bien construidas resuelven el mensaje, ' +
  'no uses cuatro. Ante preguntas sobre precios, horarios o servicios especificos, NO inventes ' +
  'datos. Responde algo como "Permitame revisar y le respondo en un momento" o "Estoy revisando ' +
  'eso, le confirmo enseguida". NUNCA digas que un asesor le atendera porque TU ERES el. ' +
  'Manten cortesia incluso ante usuarios frustrados. No reveles que estas reemplazando temporalmente a Jose Miguel. ' +
  'IMAGENES Y STICKERS: Cuando recibas una imagen o sticker, analizalo y responde de forma natural ' +
  'sobre lo que ves. NUNCA digas "no puedo ver imagenes" porque SI puedes verlas. Si es un sticker ' +
  'gracioso responde con humor o un emoji. Si es una imagen de un producto, lugar, comida, documento, ' +
  'etc, comenta sobre lo que ves de forma natural y breve. Si es un screenshot o algo que necesita ' +
  'accion, responde acorde. Manten siempre la naturalidad — actua como una persona que recibio la ' +
  'imagen en su WhatsApp normal.';

console.log('[boot] v6.0 | Auth:', AUTH_DIR, '| Wait:', WAIT_MINUTES+'min | Model:', OPENAI_MODEL);
if (!OPENAI_API_KEY) console.warn('[boot] WARNING: OPENAI_API_KEY not set');

var openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
var app    = express();
var server = http.createServer(app);
var io     = new ioMod.Server(server, { cors: { origin: '*' } });
app.use(express.json());

// ─── PIN PROTECTION (optional, set DASH_PIN env var to enable) ───
var DASH_PIN = process.env.DASH_PIN || '';
// Tokens stored in memory only — they get lost on container restart,
// which means you'll need to re-enter the PIN once after each redeploy.
// We do NOT persist them inside AUTH_DIR because that directory is owned
// by Chromium and our extra files were confusing Puppeteer's session loader.
var validTokens = new Set();
function saveTokens() { /* memory-only, no-op */ }
function makeToken() { return Date.now().toString(36) + Math.random().toString(36).slice(2,12); }
function parseCookies(s) {
  var out = {};
  (s || '').split(/;\s*/).forEach(function(c) {
    var i = c.indexOf('='); if (i > 0) out[c.slice(0, i)] = c.slice(i + 1);
  });
  return out;
}
function checkAuth(req) {
  if (!DASH_PIN) return true;
  var tok = parseCookies(req.headers.cookie || '')['wabot-token'];
  return tok && validTokens.has(tok);
}
if (DASH_PIN) console.log('[auth] PIN protection ENABLED');
else console.log('[auth] PIN protection DISABLED (set DASH_PIN env var to enable)');

app.get('/auth/needed', function(_, res) { res.json({ needed: !!DASH_PIN }); });
app.post('/auth/login', function(req, res) {
  if (!DASH_PIN) return res.json({ ok: true });
  var pin = ((req.body || {}).pin || '').toString();
  if (pin !== DASH_PIN) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
  var token = makeToken();
  validTokens.add(token);
  if (validTokens.size > 50) validTokens.delete(validTokens.values().next().value);
  saveTokens();
  res.setHeader('Set-Cookie', 'wabot-token=' + token + '; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax');
  res.json({ ok: true });
});

// Auth gate — IMPORTANT: /api/status is whitelisted for Railway's healthcheck
app.use(function(req, res, next) {
  if (req.path === '/login.html' || req.path === '/favicon.ico' ||
      req.path === '/api/status' ||
      req.path.indexOf('/auth/') === 0 ||
      req.path.indexOf('/socket.io') === 0) return next();
  if (!checkAuth(req)) {
    if (req.path === '/' || req.path === '/index.html') {
      return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
});

io.use(function(socket, next) {
  if (!DASH_PIN) return next();
  var tok = parseCookies(socket.handshake.headers.cookie || '')['wabot-token'];
  if (tok && validTokens.has(tok)) return next();
  next(new Error('unauthorized'));
});

app.use(express.static(path.join(__dirname, 'public')));

// State
// ─── CONTEXT MODES ───────────────────────────────────────────────────────────
// The bot can be in one of these "context modes" at a time (mutually exclusive):
//   'none'    → normal behavior, no extra context layer
//   'busy'    → tells contacts you're a bit busy, will reply soon
//   'driving' → tells contacts you're doing an activity (default: driving),
//               the activity text is customizable (e.g. "en una reunion",
//               "en el gimnasio", "manejando").
// Only ONE mode can be active. Activating one deactivates the others.
var activeMode = 'none';               // 'none' | 'busy' | 'driving'
var drivingActivity = 'manejando';     // customizable activity label for driving mode

// BUSY_PROMPT — additive layer appended to AI_PROMPT when busy mode is on.
var BUSY_PROMPT = process.env.BUSY_PROMPT ||
  'NOTA IMPORTANTE DE CONTEXTO: En este momento estas un poco ocupado. ' +
  'Responde el mensaje del usuario normalmente y con todo el contexto (analiza lo que ' +
  'escribe, comenta las imagenes que envie, manten tu personalidad), PERO ademas menciona ' +
  'de forma natural y amable que ahorita estas un poco ocupado y que le atenderas/respondes ' +
  'con calma en un momento. Integra esto de manera organica, no como una frase pegada al ' +
  'final. Por ejemplo, puedes reconocer su mensaje, dar una respuesta breve util si aplica, ' +
  'y cerrar diciendo que estas algo ocupado pero que enseguida le das la atencion completa. ' +
  'Varia la redaccion cada vez para que suene humano y no repetitivo. Manten la brevedad.';

// ACTIVITY_PROMPT — additive layer for the activity mode. Works for ANY activity
// (driving, gym, meeting, eating, etc.), not just driving. The {ACTIVITY} token
// is replaced with whatever activity label the user sets (default "manejando").
// Env var is ACTIVITY_PROMPT; DRIVING_PROMPT is still accepted as a fallback
// for backwards compatibility with older setups.
var ACTIVITY_PROMPT_TEMPLATE = process.env.ACTIVITY_PROMPT || process.env.DRIVING_PROMPT ||
  'NOTA IMPORTANTE DE CONTEXTO: En este momento estas {ACTIVITY} y no puedes ' +
  'responder con toda tu atencion ni por mucho tiempo. Responde el mensaje del ' +
  'usuario de forma breve y util con el contexto que tengas (analiza lo que escribe, ' +
  'comenta imagenes si las envia, manten tu personalidad), PERO menciona de forma ' +
  'natural y amable que ahorita estas {ACTIVITY} y que le respondes mejor/con calma ' +
  'en un rato cuando termines. Integra esto de manera organica, no como frase pegada ' +
  'al final. Se especialmente breve porque estas {ACTIVITY}. Varia la redaccion cada ' +
  'vez para que suene humano y natural. NUNCA digas que eres una IA o bot.';

// Build the active context layer to append to AI_PROMPT based on current mode.
function getModeContextLayer() {
  if (activeMode === 'busy') return BUSY_PROMPT;
  if (activeMode === 'driving') {
    return ACTIVITY_PROMPT_TEMPLATE.split('{ACTIVITY}').join(drivingActivity || 'ocupado en una actividad');
  }
  return null;
}

// Blocked chat IDs — bot ignores messages from these
// Persistent data lives in a "data" subfolder INSIDE the Railway volume (AUTH_DIR
// is the mounted volume, e.g. /app/wwebjs_auth). We use a SEPARATE subfolder so
// our files never mix with the WhatsApp session files (that confused Puppeteer
// before). This folder survives deploys and restarts because it's on the volume.
var DATA_DIR = path.join(AUTH_DIR, 'bot-data');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) { console.warn('[data] Could not create data dir:', e.message); }

var BLOCKED_FILE = path.join(DATA_DIR, 'blocked.json');
// Legacy path (old versions saved here, in the ephemeral /app dir). If it exists
// and the new volume file doesn't, we migrate it once so you don't lose data.
var LEGACY_BLOCKED_FILE = path.join(__dirname, 'blocked.json');
// blockedChats: chatId -> { name, blockedAt }
var blockedChats = new Map();
try {
  // Prefer the volume file. If it's missing but a legacy file exists, migrate.
  var loadFrom = null;
  if (fs.existsSync(BLOCKED_FILE)) loadFrom = BLOCKED_FILE;
  else if (fs.existsSync(LEGACY_BLOCKED_FILE)) {
    loadFrom = LEGACY_BLOCKED_FILE;
    console.log('[block] Migrating blocked list from legacy path to volume');
  }
  if (loadFrom) {
    var raw = JSON.parse(fs.readFileSync(loadFrom, 'utf8'));
    if (Array.isArray(raw)) {
      raw.forEach(function(entry) {
        if (typeof entry === 'string') blockedChats.set(entry, { name: entry, blockedAt: Date.now() });
        else if (entry && entry.chatId) blockedChats.set(entry.chatId, { name: entry.name || entry.chatId, blockedAt: entry.blockedAt || Date.now() });
      });
    }
    console.log('[block] Loaded', blockedChats.size, 'blocked chats');
    // If we loaded from the legacy path, immediately write to the volume so the
    // data is safe on the persistent disk going forward.
    if (loadFrom === LEGACY_BLOCKED_FILE && blockedChats.size > 0) {
      try {
        var migArr = [];
        blockedChats.forEach(function(v, k) { migArr.push({ chatId: k, name: v.name, blockedAt: v.blockedAt }); });
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify(migArr));
        console.log('[block] Migrated', migArr.length, 'blocked chats to volume');
      } catch(e) { console.warn('[block] Migration save failed:', e.message); }
    }
  }
} catch(e) { console.warn('[block] Could not load:', e.message); }
function saveBlocked() {
  try {
    var arr = [];
    blockedChats.forEach(function(v, k) { arr.push({ chatId: k, name: v.name, blockedAt: v.blockedAt }); });
    fs.writeFileSync(BLOCKED_FILE, JSON.stringify(arr));
  } catch(e) { console.warn('[block] Could not save:', e.message); }
}

var botStatus    = 'starting';
var currentQR    = null;
var lastQRRaw    = null;
var whoName      = '';
var keepAliveInt = null;
// Tracks the last time we saw ANY WhatsApp event (incoming msg, status update,
// presence, etc). A healthy WhatsApp Web fires these constantly. If this goes
// quiet for too long, the session is probably a zombie (alive but deaf).
var lastWaActivity = Date.now();

// ── ANTI-BAN: human-like behavior + rate limiting ──
// Tracks timestamps of recent AI sends to enforce a max-per-minute cap.
var recentSends = [];
var MAX_SENDS_PER_MIN = parseInt(process.env.MAX_SENDS_PER_MIN || '8', 10);
var lastGlobalSendTs = 0;
// Minimum gap between ANY two outgoing AI messages (ms). Prevents machine-gun replies.
var MIN_GAP_MS = parseInt(process.env.MIN_GAP_MS || '4000', 10);
function canSendNow() {
  var now = Date.now();
  // Drop sends older than 60s
  recentSends = recentSends.filter(function(t) { return now - t < 60000; });
  if (recentSends.length >= MAX_SENDS_PER_MIN) return false;
  if (now - lastGlobalSendTs < MIN_GAP_MS) return false;
  return true;
}
function recordSend() {
  var now = Date.now();
  recentSends.push(now);
  lastGlobalSendTs = now;
}
// Random delay helper — makes timing look human, not robotic
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
var waClient     = null;
var initializing = false;
var sessionReady = false;

var stats  = { replied: 0, skipped: 0, errors: 0 };
var events = [];
// chatId -> { name, lastMsg, history[], timerId, timerEnd, lastMsgTs }
var chats  = new Map();

// Persist events + stats to the volume so the message feed survives restarts
// and deploys. We save at most once every few seconds (debounced) to avoid
// hammering the disk on every single event.
var EVENTS_FILE = path.join(DATA_DIR, 'events.json');
try {
  if (fs.existsSync(EVENTS_FILE)) {
    var savedData = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    if (savedData && Array.isArray(savedData.events)) events = savedData.events.slice(0, 200);
    if (savedData && savedData.stats) stats = savedData.stats;
    console.log('[events] Restored', events.length, 'events and stats from volume');
  }
} catch(e) { console.warn('[events] Could not load:', e.message); }

var saveTimer = null;
function persistEvents() {
  // Debounce: wait 3s after the last change, then write once.
  if (saveTimer) return;
  saveTimer = setTimeout(function() {
    saveTimer = null;
    try {
      fs.writeFileSync(EVENTS_FILE, JSON.stringify({ events: events.slice(0, 200), stats: stats }));
    } catch(e) { console.warn('[events] Could not save:', e.message); }
  }, 3000);
}

function pushEvent(type, chatId, text) {
  var name = (chats.get(chatId) || {}).name || (chatId ? chatId.split('@')[0] : 'Sistema');
  var ev = { id: Date.now()+Math.random(), type:type, chatId:chatId, name:name, text:String(text||'').slice(0,2000), ts:Date.now() };
  events.unshift(ev);
  if (events.length > 200) events.pop();
  io.emit('ev', ev);
  persistEvents();
}

function getState() {
  var now = Date.now(), pending = [];
  chats.forEach(function(d, id) {
    if (d.timerId && d.timerEnd)
      pending.push({ chatId:id, name:d.name, lastMsg:d.lastMsg||'', timerEnd:d.timerEnd, remaining:Math.max(0,d.timerEnd-now) });
  });
  return { botStatus:botStatus, stats:stats, pending:pending, qr:currentQR, who:whoName, waitMs:WAIT_MS, waitMin:WAIT_MINUTES, model:OPENAI_MODEL, blockedCount: blockedChats.size, activeMode: activeMode, drivingActivity: drivingActivity };
}

setInterval(function() { io.emit('state', getState()); }, 500);

function startKA() {
  // PASSIVE ZOMBIE DETECTOR — no Puppeteer probing.
  //
  // We NEVER call getState/page.evaluate (those throw "detached Frame" even on
  // healthy sessions and cause reconnect loops). Instead we watch lastWaActivity,
  // which is updated on EVERY WhatsApp event — including status@broadcast (other
  // people's stories) and presence updates, which arrive CONSTANTLY on a healthy
  // connection (typically several per minute).
  //
  // If we see ZERO events of ANY kind for SILENCE_LIMIT, the WebSocket is almost
  // certainly dead (zombie session). We recover by rebuilding the client — which
  // does NOT poke the old session, it just creates a fresh one.
  if (keepAliveInt) { clearInterval(keepAliveInt); keepAliveInt = null; }

  // 6 minutes of TOTAL silence. A healthy WhatsApp Web is never this quiet —
  // status broadcasts and presence updates flow constantly. This high threshold
  // avoids false positives while still recovering dead sessions automatically.
  var SILENCE_LIMIT = 6 * 60 * 1000;

  keepAliveInt = setInterval(function() {
    if (!waClient || !sessionReady) return;
    var silentFor = Date.now() - lastWaActivity;
    if (silentFor < SILENCE_LIMIT) return;

    // Total silence for 6+ min — almost certainly a zombie. Rebuild WITHOUT
    // calling getState (which would throw). Just destroy + re-init.
    console.error('[ka] ZOMBIE: no events for ' + Math.round(silentFor/1000) + 's — rebuilding client');
    pushEvent('system', null, 'Sesion sin actividad prolongada — reconectando...');
    sessionReady = false;
    if (keepAliveInt) { clearInterval(keepAliveInt); keepAliveInt = null; }
    cancelAllTimers();
    // Reset the clock so the new session gets a fresh window
    lastWaActivity = Date.now();
    var old = waClient;
    waClient = null;
    initializing = false;
    // destroy() is best-effort; even if it throws (detached frame), we continue
    Promise.resolve().then(function() {
      try { if (old) return old.destroy(); } catch(_){}
    }).catch(function(){}).then(function() {
      setTimeout(initClient, 4000);
    });
  }, 60000); // check every 60s

  console.log('[ka] passive zombie detector enabled (rebuilds after ' + (SILENCE_LIMIT/60000) + 'min total silence, no probing)');
}
function stopKA() { if (keepAliveInt) { clearInterval(keepAliveInt); keepAliveInt = null; } }

function cancelAllTimers() {
  chats.forEach(function(d) {
    if (d.timerId) { clearTimeout(d.timerId); d.timerId = null; d.timerEnd = null; }
  });
}

var PUPPETEER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas', '--disable-gpu', '--no-first-run',
  '--no-zygote', '--single-process',
  '--ignore-profile-directory-lock',
  '--disable-features=LockProfileCookieDatabase',
  '--disable-background-networking', '--disable-extensions', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
];

function buildClient() {
  cleanLocks(AUTH_DIR);
  var c = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: PUPPETEER_ARGS,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      // Default is 30s. When 3-4 images arrive at once each calls downloadMedia
      // and Puppeteer can serialize them, timing out. Bump to 90s to absorb bursts.
      protocolTimeout: 90000,
    }
  });

  c.on('qr', function(raw) {
    if (raw === lastQRRaw) return;
    lastQRRaw = raw; botStatus = 'qr'; sessionReady = false;
    qrTerm.generate(raw, { small: true });
    QRCode.toDataURL(raw).then(function(url) {
      currentQR = url;
      pushEvent('system', null, 'QR listo — escanea desde WhatsApp');
      io.emit('state', getState());
    }).catch(function(){});
  });

  // Watchdog: if Authenticated fires but Ready doesn't within 60s, the session
  // is stuck (common Puppeteer/WhatsApp issue). Force a clean reconnect.
  var readyWatchdog = null;
  c.on('authenticated', function() {
    console.log('[wa] Authenticated — waiting for ready event...');
    if (readyWatchdog) clearTimeout(readyWatchdog);
    // Give it 120s to reach ready. Some cold starts on Railway are slow.
    // If it never gets there, the auth data is likely corrupted — reconnect
    // with a longer delay so we don't hammer in a tight loop.
    readyWatchdog = setTimeout(function() {
      if (!sessionReady) {
        console.error('[wa] STUCK: Authenticated but no Ready after 120s — reconnecting');
        pushEvent('system', null, 'Sesion estancada — reintentando...');
        sessionReady = false;
        initializing = false;
        try { if (c) c.destroy(); } catch(_){}
        setTimeout(initClient, 8000);
      }
    }, 120000);
  });

  c.on('ready', function() {
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    if (sessionReady) { console.log('[wa] Ready event ignored (already ready)'); return; }
    initializing = false; sessionReady = true;
    botStatus = 'ready'; currentQR = null; lastQRRaw = null;
    lastWaActivity = Date.now(); // reset activity clock on fresh connect
    try { whoName = c.info && (c.info.pushname || (c.info.wid && c.info.wid.user) || ''); } catch(e){ whoName=''; }
    console.log('[wa] Ready | User:', whoName);
    pushEvent('system', null, 'Conectado' + (whoName ? ' — ' + whoName : ''));
    startKA();
    io.emit('state', getState());
  });

  c.on('disconnected', function(reason) {
    sessionReady = false; botStatus = 'disconnected'; currentQR = null; lastQRRaw = null;
    stopKA(); cancelAllTimers(); initializing = false;
    var msg = reason === 'LOGOUT'
      ? 'Desvinculado desde el celular — reconectando...'
      : 'Desconectado (' + reason + ') — reconectando...';
    console.log('[wa]', msg);
    pushEvent('system', null, msg);
    io.emit('state', getState());
    setTimeout(initClient, 6000);
  });

  c.on('auth_failure', function() {
    initializing = false; sessionReady = false; botStatus = 'disconnected';
    currentQR = null; lastQRRaw = null; stopKA();
    pushEvent('system', null, 'Sesion expirada — escanea el QR de nuevo');
    io.emit('state', getState());
    setTimeout(initClient, 5000);
  });

  // Incoming message from someone else.
  // CRITICAL: WhatsApp delivers all contacts' status/story updates through
  // status@broadcast in bursts of 50–100+ messages. We must drop them at the
  // listener level (before any logging or async work) so they don't saturate
  // the event loop and block real incoming messages.
  c.on('message', function(msg) {
    lastWaActivity = Date.now(); // any event = session is alive
    if (msg.from === 'status@broadcast') return; // stories, not messages
    if (msg.fromMe) return;
    // Reject channels, broadcasts, and groups — bot only responds to 1-on-1 chats.
    // WhatsApp uses these suffixes:
    //   @newsletter  → channels you follow
    //   @broadcast   → broadcast lists
    //   @g.us        → group chats
    if (msg.from && (msg.from.indexOf('@newsletter') !== -1 ||
                     msg.from.indexOf('@broadcast') !== -1 ||
                     msg.from.indexOf('@g.us') !== -1)) {
      console.log('[wa-raw-msg] ignored channel/group:', msg.from);
      return;
    }
    // e2e_notification = encryption notification generated when someone deletes
    // the chat or reinstalls WhatsApp. Not a real message — ignore.
    if (msg.type === 'e2e_notification' || msg.type === 'notification_template' || msg.type === 'gp2') {
      console.log('[wa-raw-msg] ignored type:', msg.type, 'from:', msg.from);
      return;
    }
    console.log('[wa-raw-msg] from:', msg.from, '| type:', msg.type);
    handleMsg(msg).catch(function(e){ console.error('[msg] handler error:', e.message); });
  });

  // Outgoing message from owner (manual reply) — cancel pending AI timer
  c.on('message_create', function(msg) {
    lastWaActivity = Date.now();
    if (!msg.fromMe) return;
    var d = chats.get(msg.to);
    if (!d) return;
    // CRITICAL: distinguish AI-sent vs human-sent outgoing messages.
    // d.aiSendingNow is set TRUE just before we call waClient.sendMessage from
    // the AI flow, and cleared after. If this event arrived while aiSendingNow
    // is true, this message came from US (the bot), NOT the human owner.
    var sentByAI = !!d.aiSendingNow;
    console.log('[wa-raw-create] to:', msg.to, '| type:', msg.type, '| sentBy:', sentByAI ? 'AI' : 'HUMAN', '| body:', String(msg.body||'').slice(0,40));

    d.lastSentBy = sentByAI ? 'ai' : 'human';
    d.lastSentTs = Date.now();

    if (sentByAI) {
      // Our own AI message — do NOT cancel timers or change skip state
      return;
    }

    // OWNER (you) replied manually
    if (d.timerId) {
      clearTimeout(d.timerId); d.timerId = null; d.timerEnd = null;
      pushEvent('human_reply', msg.to, msg.body);
      console.log('[timer] cancelled — owner replied manually to', msg.to);
    }
    // No legacy flag needed — lastSentBy='human' + lastSentTs is enough.
    // If a new message arrives AFTER this, the skip check will see it and
    // let the AI respond.
  });

  // Track ALL activity to detect zombie sessions. These events fire frequently
  // on a healthy connection even when nobody messages you (presence, acks,
  // state changes, battery, etc). Complete silence = likely zombie.
  ['message_ack','change_state','presence_update','message_revoke_everyone',
   'media_uploaded','contact_changed','group_update'].forEach(function(evt) {
    try { c.on(evt, function() { lastWaActivity = Date.now(); }); } catch(_){}
  });
  c.on('change_state', function(state) {
    console.log('[wa] state changed:', state);
    lastWaActivity = Date.now();
  });

  return c;
}

function initClient() {
  if (initializing) { console.log('[wa] already initializing, skipping'); return; }
  initializing = true; sessionReady = false; botStatus = 'starting';
  if (waClient) { try { waClient.destroy(); } catch(e){} waClient = null; }
  waClient = buildClient();
  waClient.initialize().catch(function(e) {
    console.error('[wa] init error:', e.message);
    initializing = false; botStatus = 'disconnected';
    pushEvent('system', null, 'Error al iniciar: ' + e.message);
    io.emit('state', getState());
    setTimeout(initClient, 12000);
  });
}

// ─── AUDIO TRANSCRIPTION ──────────────────────────────────────────────────────
// Transcribes a WhatsApp audio/voice note using OpenAI Whisper API.
// Returns transcribed text or null on failure.
async function transcribeAudio(message) {
  if (!openai) return null;
  try {
    console.log('[whisper] Queueing audio download...');
    var media = await serializeMediaDownload(function() {
      console.log('[whisper] Downloading audio media...');
      return message.downloadMedia();
    });
    if (!media || !media.data) {
      console.warn('[whisper] No media data');
      return null;
    }
    // media.data is base64. Decode to Buffer and write to temp file.
    var buf = Buffer.from(media.data, 'base64');
    // Determine extension from mimetype
    var ext = 'ogg';
    if (media.mimetype) {
      if (media.mimetype.indexOf('mp4') !== -1) ext = 'mp4';
      else if (media.mimetype.indexOf('mpeg') !== -1) ext = 'mp3';
      else if (media.mimetype.indexOf('webm') !== -1) ext = 'webm';
      else if (media.mimetype.indexOf('wav') !== -1) ext = 'wav';
    }
    var tmpPath = path.join('/tmp', 'audio_' + Date.now() + '.' + ext);
    fs.writeFileSync(tmpPath, buf);
    console.log('[whisper] Calling Whisper API (' + Math.round(buf.length/1024) + 'KB ' + ext + ')...');
    var transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
    });
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch(_){}
    var text = (transcript && transcript.text) ? String(transcript.text).trim() : '';
    if (!text) {
      console.warn('[whisper] Empty transcription');
      return null;
    }
    console.log('[whisper] Transcribed:', text.slice(0, 80));
    return text;
  } catch(e) {
    console.error('[whisper] Failed:', e.message);
    return null;
  }
}

// ─── MEDIA DOWNLOAD MUTEX ─────────────────────────────────────────────────────
// Puppeteer can't handle many parallel downloadMedia() calls — when 3-4 images
// arrive at once the browser saturates and times out. This serializes downloads
// so only one runs at a time. Each new download waits for the previous to finish.
var mediaQueue = Promise.resolve();
function serializeMediaDownload(work) {
  var next = mediaQueue.then(work, work);
  // Don't let one failure poison the queue — always resolve
  mediaQueue = next.catch(function(){});
  return next;
}

// ─── IMAGE/STICKER DOWNLOAD ──────────────────────────────────────────────────
// Downloads an image or sticker and returns a data URL (base64) for the vision API.
// Returns null on failure — the message will be handled as text-only fallback.
async function downloadImageAsDataURL(message) {
  try {
    console.log('[vision] Queueing image download...');
    var media = await serializeMediaDownload(function() {
      console.log('[vision] Downloading image media...');
      return message.downloadMedia();
    });
    if (!media || !media.data) {
      console.warn('[vision] No media data');
      return null;
    }
    // Build data URL — vision API accepts: data:<mimetype>;base64,<data>
    var mime = media.mimetype || 'image/jpeg';
    // GPT-4o vision supports png, jpeg, gif, webp
    // Stickers are usually webp, photos are jpeg, gifs are gif
    var dataUrl = 'data:' + mime + ';base64,' + media.data;
    var sizeKB = Math.round((media.data.length * 3 / 4) / 1024);
    console.log('[vision] Got image:', mime, '(' + sizeKB + 'KB)');
    // Sanity check: data URL above ~20MB is too big for the API
    if (sizeKB > 18000) {
      console.warn('[vision] Image too large (' + sizeKB + 'KB), skipping');
      return null;
    }
    return dataUrl;
  } catch(e) {
    console.error('[vision] Failed:', e.message);
    return null;
  }
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
async function handleMsg(message) {
  var chatId = message.from;
  if (message.fromMe || !chatId) return;
  if (chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast') || chatId === 'status@broadcast') return;
  // Check block list — silently ignore blocked chats (no event, no log spam)
  if (blockedChats.has(chatId)) {
    console.log('[block] Ignored message from blocked chat:', chatId);
    return;
  }

  var name = chatId.split('@')[0];
  try { var ct = await message.getContact(); name = ct.pushname || ct.name || name; } catch(e){}

  // Determine message text — handle any message type defensively
  var msgType = message.type || 'chat';

  // 'album' is a wrapper meta-message WhatsApp sends when someone shares
  // multiple images at once. The individual images arrive as separate 'image'
  // events. Skip the wrapper — no need to process it.
  if (msgType === 'album') {
    console.log('[msg] Skipping album wrapper (individual images come separately)');
    return;
  }
  var hasText = message.body && String(message.body).trim().length > 0;
  var msgText;
  if (hasText) {
    msgText = String(message.body).trim();
  } else if (msgType === 'sticker')                   { msgText = '[Sticker]'; }
  else if (msgType === 'image')                       { msgText = '[Imagen]'; }
  else if (msgType === 'video')                       { msgText = '[Video]'; }
  else if (msgType === 'audio' || msgType === 'ptt')  {
    // Try to transcribe the audio with Whisper
    console.log('[msg] Audio message — attempting transcription');
    var transcribed = await transcribeAudio(message);
    if (transcribed) {
      msgText = transcribed;
      hasText = true; // treat as text from here on
    } else {
      msgText = '[Nota de voz]';
    }
  }
  else if (msgType === 'document')                    { msgText = '[Documento]'; }
  else if (msgType === 'location')                    { msgText = '[Ubicacion]'; }
  else                                                { msgText = '[Mensaje]'; }

  // ── VISION: Download image/sticker so AI can analyze it ──
  // gpt-4o and gpt-4o-mini are multimodal — they accept image_url in messages.
  // We store the data URL in `imageDataUrl` which gets attached to history below.
  var imageDataUrl = null;
  if ((msgType === 'image' || msgType === 'sticker') && message.hasMedia) {
    imageDataUrl = await downloadImageAsDataURL(message);
    if (imageDataUrl) {
      // Customize the descriptor based on what came with the image
      if (msgType === 'sticker') {
        msgText = message.body && message.body.trim() ? String(message.body).trim() : '[Sticker enviado]';
      } else {
        msgText = message.body && message.body.trim() ? String(message.body).trim() : '[Imagen enviada]';
      }
    }
  }

  if (!chats.has(chatId)) chats.set(chatId, { name:name, history:[], timerId:null, timerEnd:null, lastMsgTs:0 });
  var d = chats.get(chatId);
  d.name    = name;
  d.lastMsg = msgText;
  d.lastMsgTs = message.timestamp;

  // Add to history — if there's an image, use vision-format content array
  if (imageDataUrl) {
    // Multimodal content: text caption + image. GPT-4o-mini will see both.
    d.history.push({
      role: 'user',
      content: [
        { type: 'text', text: msgText },
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } }
      ]
    });
    if (d.history.length > 20) d.history.shift();
  } else if (msgText !== '[Sticker]' && msgText !== '[Nota de voz]') {
    // Regular text message (or transcribed audio)
    d.history.push({ role: 'user', content: msgText });
    if (d.history.length > 20) d.history.shift();
  }

  console.log('[msg] FROM:', name, '| TYPE:', msgType, '| TEXT:', msgText.slice(0, 100));
  pushEvent('incoming', chatId, msgText);

  // Do NOT reset the timer if already running — messages accumulate in history.
  if (d.timerId) {
    console.log('[timer] already running for', name, '— message added to history (NOT resetting timer)');
    return;
  }

  // Dont start timer for media-only messages with no text (stickers, untranscribed audio)
  // — the AI cant respond meaningfully to these alone.
  // EXCEPTION: if we successfully downloaded an image/sticker, the AI CAN see it.
  if ((msgText === '[Sticker]' || msgText === '[Nota de voz]') && !imageDataUrl) {
    console.log('[timer] skipping media-only message for', name);
    return;
  }
  // (Transcribed audio, downloaded images and stickers get through)

  d.timerEnd = Date.now() + WAIT_MS;
  console.log('[timer] STARTED for', name, '— fires at', new Date(d.timerEnd).toLocaleTimeString());

  d.timerId = setTimeout(async function() {
    d.timerId = null; d.timerEnd = null;

    var chatData  = chats.get(chatId);
    // Use the LAST 10 messages of the conversation history for context.
    // This gives the AI enough context (typically 5 user msgs + 5 AI replies)
    // without paying for ancient context that's no longer relevant.
    var fullHistory = chatData ? chatData.history.slice() : [];
    var history = fullHistory.slice(-10);
    var lastMsgTs = chatData ? chatData.lastMsgTs : 0;

    console.log('[timer] FIRED for', name, '| using', history.length, 'of', fullHistory.length, 'msgs as context | lastMsgTs:', lastMsgTs);

    // SKIP LOGIC: only skip if the human's LAST reply was AFTER the LATEST incoming.
    // If a new message arrived AFTER the human reply, the AI should respond to it
    // (the human didn't address it yet).
    //
    // Timestamps explained:
    //   d.lastMsgTs (seconds, from WhatsApp)        — when the LAST incoming msg arrived
    //   d.lastSentTs (millis, our clock)            — when WE last sent something out
    //   d.lastSentBy ('ai' | 'human')               — who sent the last outgoing msg
    //
    // We convert lastMsgTs to millis for fair comparison.
    var chatData2 = chats.get(chatId);
    var lastIncomingMs = chatData2 ? ((chatData2.lastMsgTs || 0) * 1000) : 0;
    var lastSentBy = chatData2 ? chatData2.lastSentBy : null;
    var lastSentTs = chatData2 ? (chatData2.lastSentTs || 0) : 0;

    // Skip only when: human replied AND that reply came AFTER the latest incoming msg
    var humanRepliedAfterLast = (lastSentBy === 'human' && lastSentTs > lastIncomingMs);
    if (humanRepliedAfterLast) {
      console.log('[timer] human replied AFTER last incoming — SKIP AI');
      pushEvent('skipped', chatId, 'Respondido manualmente — IA omitida');
      stats.skipped++;
      return;
    }
    console.log('[timer] proceeding | lastSentBy=' + (lastSentBy || 'none') +
                ' | lastIncomingMs=' + lastIncomingMs +
                ' | lastSentTs=' + lastSentTs);

    if (!openai) {
      console.error('[ai] No OPENAI_API_KEY configured');
      pushEvent('error', chatId, 'OPENAI_API_KEY no configurado — revisa las variables de entorno');
      stats.errors++;
      return;
    }

    // Build the system prompt. If a context mode (busy/driving) is active, we
    // APPEND its context layer to the normal prompt so the AI keeps full context
    // + personality but also weaves in the current situation.
    var activePrompt = AI_PROMPT;
    var modeLayer = getModeContextLayer();
    if (modeLayer) {
      activePrompt = AI_PROMPT + '\n\n' + modeLayer;
    }
    // Full history context in all modes.
    var msgsForAI = [{ role: 'system', content: activePrompt }].concat(history);

    var modeLabel = (activeMode === 'driving')
      ? ('DRIVING MODE (' + drivingActivity + ')')
      : (activeMode === 'busy' ? 'BUSY MODE' : 'normal');
    console.log('[ai] Calling', OPENAI_MODEL, 'for', name, '|', modeLabel, '| msgs:', msgsForAI.length - 1);
    var reply;
    try {
      var response = await openai.chat.completions.create({
        model:      OPENAI_MODEL,
        max_tokens: 400,
        messages:   msgsForAI
      });
      reply = ((response.choices[0] || {}).message || {}).content || '';
      reply = reply.trim();
      if (!reply) throw new Error('OpenAI returned empty response');
    } catch(err) {
      stats.errors++;
      console.error('[ai] OpenAI error for', name, ':', err.message);
      pushEvent('error', chatId, 'Error IA (OpenAI): ' + err.message);
      return;
    }

    // ── ANTI-BAN: rate limit check ──
    // If we've sent too many messages recently, wait until it's safe.
    var rateWaitGuard = 0;
    while (!canSendNow() && rateWaitGuard < 20) {
      rateWaitGuard++;
      console.log('[antiban] rate limit — waiting 5s before sending to', name);
      await sleep(5000);
    }

    // ── ANTI-BAN: human-like typing simulation ──
    // Real people take a moment to read + type. We:
    //  1. Wait a short "reading" pause
    //  2. Show the "typing..." indicator in the chat
    //  3. Wait a "typing" duration proportional to the reply length
    // This makes the bot look human and avoids instant robotic replies.
    var dForSend = chats.get(chatId);
    if (dForSend) dForSend.aiSendingNow = true;

    // Reading pause: 1.5–4s (pure timer, no Puppeteer calls — always safe)
    await sleep(randInt(1500, 4000));
    // Optional typing indicator. getChatById can throw "detached Frame", so we
    // make it fully best-effort and NEVER let it affect the send. We don't even
    // await its failure — fire and forget.
    try {
      var chatRef = await Promise.race([
        waClient.getChatById(chatId),
        new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('typing timeout')); }, 4000); })
      ]);
      if (chatRef && chatRef.sendStateTyping) {
        chatRef.sendStateTyping().catch(function(){}); // fire and forget
      }
    } catch(typingErr) {
      console.warn('[antiban] typing indicator skipped:', typingErr.message);
    }
    // Typing duration: ~50ms per char, 2–9s (pure timer, always safe)
    var typingMs = Math.min(9000, Math.max(2000, reply.length * 50));
    await sleep(typingMs);

    var sent = false;
    for (var attempt = 1; attempt <= 3 && !sent; attempt++) {
      try {
        if (!waClient || !sessionReady) {
          console.warn('[send] session not ready, waiting...');
          await new Promise(function(r) { setTimeout(r, 2000); });
        }
        await waClient.sendMessage(chatId, reply);
        sent = true;
        recordSend(); // count this send for rate limiting
      } catch(sendErr) {
        var smsg = String(sendErr.message || sendErr);
        console.warn('[send] attempt ' + attempt + ' failed:', smsg);
        // Retry on ANY transient Puppeteer/WhatsApp error. List of known ones:
        // - "detached Frame"  → browser frame got recycled
        // - "Session closed"  → DevTools connection dropped
        // - "Target closed"   → tab/page closed
        // - "Protocol error"  → general Chrome DevTools protocol issue
        // - "timed out"       → operation took too long, browser was busy
        // - "callFunctionOn"  → specific Puppeteer eval timeout
        // - "Evaluation"      → JS eval inside the page failed
        var isTransient = (
          smsg.indexOf('detached Frame') !== -1 ||
          smsg.indexOf('Session closed') !== -1 ||
          smsg.indexOf('Target closed') !== -1 ||
          smsg.indexOf('Protocol error') !== -1 ||
          smsg.indexOf('timed out') !== -1 ||
          smsg.indexOf('timeout') !== -1 ||
          smsg.indexOf('callFunctionOn') !== -1 ||
          smsg.indexOf('Evaluation') !== -1
        );
        if (isTransient && attempt < 3) {
          // Exponential backoff: 3s, 6s, 9s — gives browser time to settle
          var waitMs = 3000 * attempt;
          console.warn('[send] transient error, retrying in ' + waitMs + 'ms...');
          await new Promise(function(r) { setTimeout(r, waitMs); });
        } else {
          break;
        }
      }
    }
    // Clear AI sending flag after a small delay to ensure message_create has fired
    setTimeout(function() {
      var dd = chats.get(chatId);
      if (dd) dd.aiSendingNow = false;
    }, 2000);

    if (!sent) {
      stats.errors++;
      console.error('[ai] Could not send to', name, 'after 3 attempts');
      pushEvent('error', chatId, 'No se pudo enviar — sesion WhatsApp inestable');
      return;
    }

    var current = chats.get(chatId);
    if (current) {
      current.history.push({ role: 'assistant', content: reply });
      if (current.history.length > 20) current.history.shift();
      // Explicitly mark this chat as AI-sent so any subsequent timer check
      // knows that incoming messages after this should still get AI responses
      current.lastSentBy = 'ai';
      current.lastSentTs = Date.now();
    }

    stats.replied++;
    console.log('[ai] REPLIED to', name, ':', reply.slice(0, 100));
    pushEvent('ai_reply', chatId, reply);
  }, WAIT_MS);
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/status', function(_, res) { res.json(getState()); });

// ─── CONTEXT MODE API ───────────────────────────────────────────────────────
// Set the active context mode. Body: { mode: 'none'|'busy'|'driving', activity?: string }
// Modes are mutually exclusive — setting one clears the others automatically.
app.post('/api/mode', function(req, res) {
  var mode = (req.body || {}).mode;
  var activity = (req.body || {}).activity;
  if (['none', 'busy', 'driving'].indexOf(mode) === -1) {
    return res.status(400).json({ ok: false, error: 'Modo invalido' });
  }
  activeMode = mode;
  // Update the driving activity label if provided (only relevant for driving mode)
  if (mode === 'driving' && activity && String(activity).trim()) {
    drivingActivity = String(activity).trim().slice(0, 60);
  }
  var label;
  if (mode === 'busy') label = 'Modo ocupado ACTIVADO';
  else if (mode === 'driving') label = 'Modo actividad ACTIVADO (' + drivingActivity + ')';
  else label = 'Modos desactivados — respuestas normales';
  console.log('[mode]', mode.toUpperCase(), mode === 'driving' ? ('| activity: ' + drivingActivity) : '');
  pushEvent('system', null, label);
  io.emit('state', getState());
  res.json({ ok: true, activeMode: activeMode, drivingActivity: drivingActivity });
});

// Backwards-compatible busy endpoint (maps to the mode system)
app.post('/api/busy', function(req, res) {
  var on = (req.body || {}).on;
  activeMode = on ? 'busy' : 'none';
  pushEvent('system', null, on ? 'Modo ocupado ACTIVADO' : 'Modo ocupado desactivado');
  io.emit('state', getState());
  res.json({ ok: true, busyMode: activeMode === 'busy', activeMode: activeMode });
});
app.get('/api/events', function(_, res) { res.json(events.slice(0, 100)); });

// Clear server-side event history (called when user clicks Clear button)
app.post('/api/clear-feed', function(_, res) {
  events.length = 0;
  var ts = Date.now();
  console.log('[feed] Server-side event history cleared at', ts);
  persistEvents(); // save the now-empty feed so it stays cleared after restart
  io.emit('feed-cleared', { ts: ts });
  res.json({ ok: true, ts: ts });
});

// ─── DATA EXPORT / BACKUP ────────────────────────────────────────────────────
// Download all persistent data (blocked list + events + stats) as a single JSON
// backup file. Use this before major changes as an extra safety net beyond the
// automatic volume persistence.
app.get('/api/export', function(_, res) {
  var blocked = [];
  blockedChats.forEach(function(v, k) { blocked.push({ chatId: k, name: v.name, blockedAt: v.blockedAt }); });
  var backup = {
    exportedAt: new Date().toISOString(),
    version: 'wa-bot-backup-v1',
    blocked: blocked,
    events: events.slice(0, 200),
    stats: stats
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="wa-bot-backup-' + Date.now() + '.json"');
  res.send(JSON.stringify(backup, null, 2));
});

// Restore data from an uploaded backup file (the JSON produced by /api/export).
// Body: the parsed backup object. Merges blocked list and restores events/stats.
app.post('/api/import', function(req, res) {
  var backup = req.body || {};
  var imported = { blocked: 0, events: 0 };
  try {
    if (Array.isArray(backup.blocked)) {
      backup.blocked.forEach(function(b) {
        if (b && b.chatId) {
          blockedChats.set(b.chatId, { name: b.name || b.chatId, blockedAt: b.blockedAt || Date.now() });
          imported.blocked++;
        }
      });
      saveBlocked();
    }
    if (Array.isArray(backup.events)) {
      events = backup.events.slice(0, 200);
      imported.events = events.length;
    }
    if (backup.stats && typeof backup.stats === 'object') {
      stats = { replied: backup.stats.replied||0, skipped: backup.stats.skipped||0, errors: backup.stats.errors||0 };
    }
    persistEvents();
    io.emit('state', getState());
    console.log('[import] Restored', imported.blocked, 'blocked +', imported.events, 'events');
    res.json({ ok: true, imported: imported });
  } catch(e) {
    console.error('[import] Failed:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Cancel pending AI response for a specific chat
app.post('/api/cancel', function(req, res) {
  var chatId = (req.body || {}).chatId;
  if (!chatId) return res.status(400).json({ ok: false, error: 'chatId requerido' });
  var d = chats.get(chatId);
  if (!d) return res.json({ ok: false, error: 'Chat no encontrado' });
  if (d.timerId) {
    clearTimeout(d.timerId);
    d.timerId = null;
    d.timerEnd = null;
    // Mark as human-replied so AI won't fire — use the same timestamp system
    d.lastSentBy = 'human';
    d.lastSentTs = Date.now();
    pushEvent('skipped', chatId, 'Cancelado por el usuario desde el dashboard');
    stats.skipped++;
    console.log('[cancel] AI response cancelled for', d.name);
    io.emit('state', getState());
    return res.json({ ok: true });
  }
  res.json({ ok: false, error: 'No hay respuesta pendiente' });
});

// ─── BLOCK LIST API ─────────────────────────────────────────────
app.get('/api/blocked', function(_, res) {
  var list = [];
  blockedChats.forEach(function(v, k) { list.push({ chatId: k, name: v.name, blockedAt: v.blockedAt }); });
  list.sort(function(a, b) { return (b.blockedAt||0) - (a.blockedAt||0); });
  res.json({ blocked: list });
});

app.post('/api/block', function(req, res) {
  var chatId = (req.body || {}).chatId;
  var name   = (req.body || {}).name || (chats.get(chatId) ? chats.get(chatId).name : null) || (chatId ? chatId.split('@')[0] : '');
  if (!chatId) return res.status(400).json({ ok: false, error: 'chatId requerido' });
  blockedChats.set(chatId, { name: name, blockedAt: Date.now() });
  saveBlocked();
  // Also cancel any pending timer for this chat
  var d = chats.get(chatId);
  if (d && d.timerId) {
    clearTimeout(d.timerId); d.timerId = null; d.timerEnd = null;
    d.lastSentBy = 'human';
    d.lastSentTs = Date.now();
  }
  pushEvent('system', chatId, 'Numero bloqueado: ' + name);
  console.log('[block] Blocked:', chatId, '|', name);
  io.emit('state', getState());
  res.json({ ok: true });
});

app.post('/api/unblock', function(req, res) {
  var chatId = (req.body || {}).chatId;
  if (!chatId) return res.status(400).json({ ok: false, error: 'chatId requerido' });
  var entry = blockedChats.get(chatId);
  blockedChats.delete(chatId);
  saveBlocked();
  pushEvent('system', chatId, 'Numero desbloqueado: ' + (entry ? entry.name : chatId));
  console.log('[block] Unblocked:', chatId);
  io.emit('state', getState());
  res.json({ ok: true });
});

var logoutInProgress = false;
app.post('/api/logout', async function(_, res) {
  if (logoutInProgress) {
    console.log('[logout] Already in progress — ignoring duplicate request');
    return res.json({ ok: false, error: 'Logout ya en proceso' });
  }
  logoutInProgress = true;
  res.json({ ok: true });
  pushEvent('system', null, 'Cerrando sesion en WhatsApp...');
  console.log('[logout] Starting logout sequence');

  // CRITICAL: logout() while session is still alive — this unlinks the phone.
  // If browser frame is detached, logout will fail but we continue anyway.
  if (waClient && sessionReady) {
    try {
      console.log('[logout] Calling waClient.logout() to unlink phone...');
      await Promise.race([
        waClient.logout(),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('logout timeout')); }, 8000); })
      ]);
      console.log('[logout] Successfully unlinked from phone');
    } catch(e) {
      console.warn('[logout] logout() failed:', e.message);
    }
  } else {
    console.warn('[logout] Skipping logout() — session not ready');
  }

  sessionReady = false;
  try {
    if (waClient) {
      try { await waClient.destroy(); } catch(e){ console.warn('[logout] destroy err:', e.message); }
      waClient = null;
    }
    // Delete auth data — skip files that are still locked by the volume
    var authPath = path.resolve(AUTH_DIR);
    if (fs.existsSync(authPath)) {
      try {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('[logout] Auth data deleted');
      } catch(rmErr) {
        // EBUSY on Railway volume — delete individual session files instead
        console.warn('[logout] rmSync failed (' + rmErr.code + '), cleaning files individually');
        var lockNames = ['Default/Cookies','Default/Storage','session/Default'];
        lockNames.forEach(function(rel) {
          var p = path.join(authPath, rel);
          try { fs.rmSync(p, { recursive:true, force:true }); } catch(_){}
        });
        // At minimum, clear the lock files so Chromium starts fresh
        var locks = ['SingletonLock','SingletonCookie','SingletonSocket'];
        function rmLocks(dir, d) {
          if (d > 3) return;
          try { fs.readdirSync(dir, {withFileTypes:true}).forEach(function(e) {
            var fp = path.join(dir, e.name);
            if (e.isDirectory()) rmLocks(fp, d+1);
            else if (locks.indexOf(e.name) !== -1) { try { fs.unlinkSync(fp); } catch(_){} }
          }); } catch(_){}
        }
        rmLocks(authPath, 0);
        console.log('[logout] Partial cleanup done');
      }
    }
  } catch(e) { console.error('[logout] error:', e.message); }
  botStatus = 'disconnected'; currentQR = null; lastQRRaw = null;
  stopKA(); cancelAllTimers(); initializing = false;
  pushEvent('system', null, 'Sesion cerrada — generando nuevo QR...');
  io.emit('state', getState());
  setTimeout(function() {
    logoutInProgress = false;
    initClient();
  }, 2000);
});

// SVG Favicon — WhatsApp style green gradient icon
app.get('/favicon.ico', function(_, res) {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    '<defs>',
    '<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">',
    '<stop offset="0%" stop-color="#25D366"/>',
    '<stop offset="100%" stop-color="#128C7E"/>',
    '</linearGradient>',
    '</defs>',
    '<rect width="32" height="32" rx="8" fill="url(#g)"/>',
    '<path fill="white" d="M16 5a11 11 0 0 0-9.26 16.9L5 27l5.26-1.7A11 11 0 1 0 16 5z"/>',
    '<path fill="#25D366" d="M21.5 18.8c-.28-.14-1.64-.8-1.89-.9-.26-.1-.44-.14-.63.14-.18.28-.72.9-.88 1.08-.16.18-.32.2-.6.07-.28-.14-1.18-.44-2.24-1.38-.83-.73-1.39-1.64-1.55-1.91-.16-.28-.02-.43.12-.57.12-.12.28-.32.42-.48.14-.16.18-.28.28-.46.1-.18.05-.34-.02-.48-.07-.14-.63-1.52-.86-2.08-.23-.54-.46-.47-.63-.48h-.54c-.18 0-.48.07-.74.34-.25.28-.96.94-.96 2.29s.98 2.66 1.12 2.84c.14.18 1.93 2.96 4.68 4.15.65.28 1.16.45 1.56.58.65.21 1.24.18 1.71.11.52-.08 1.64-.67 1.87-1.32.23-.65.23-1.2.16-1.32-.07-.11-.25-.18-.53-.32z"/>',
    '</svg>'
  ].join(''));
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, function() {
  console.log('[server] Dashboard: http://localhost:' + PORT);
});

initClient();
