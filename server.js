const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE (optional — app works without it) ──────────────
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function dbQuery(sql, params = []) {
  if (!pool) return { rows: [] };
  try { return await pool.query(sql, params); }
  catch (e) { console.error('DB error:', e.message); return { rows: [] }; }
}

async function initDB() {
  if (!pool) { console.log('No DATABASE_URL — running in-memory only'); return; }
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      code VARCHAR(6) UNIQUE NOT NULL,
      host_pin VARCHAR(6) NOT NULL,
      seed INTEGER NOT NULL,
      state VARCHAR(20) DEFAULT 'lobby',
      current_round INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      socket_id VARCHAR(100),
      total_score INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS round_scores (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      score INTEGER DEFAULT 0,
      UNIQUE(player_id, round_number)
    );
  `);
  console.log('Database ready');
}

// ── SEEDED RNG (mulberry32) ─────────────────────────────────
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── ROUND METADATA ──────────────────────────────────────────
const ROUNDS = [
  { n:1, name:'The Current Workplace',    seconds:60, tagline:'Clutter slows performance.',                                      mode:'click_order' },
  { n:2, name:'Sort',                     seconds:50, tagline:"We removed what wasn't needed — but is that enough?",            mode:'click_order' },
  { n:3, name:'Set in Order',             seconds:40, tagline:'Grouping improves flow — but standard placement drives speed.',   mode:'click_order' },
  { n:4, name:'Structured Layout',        seconds:30, tagline:"Now we're structured — but not yet standardized.",               mode:'click_order' },
  { n:5, name:'Standardized System',      seconds:20, tagline:'Standardization creates speed.',                                  mode:'click_order' },
  { n:6, name:'Identify Missing Numbers', seconds:60, tagline:'Without standards, errors hide in the noise.',                   mode:'find_missing' },
  { n:7, name:'Sort & Set in Order',      seconds:5,  tagline:'When systems are clear, problems become visible instantly.',      mode:'find_missing' },
];

// ── LAYOUT GENERATORS ───────────────────────────────────────
const FONTS  = ['Arial', 'Georgia', "'Courier New'", 'Impact', "'Times New Roman'", "'Trebuchet MS'"];
const GREENS = ['#1a9850', '#2d6a4f', '#40916c', '#52b788'];
const GREYS  = ['#6c757d', '#868e96', '#adb5bd'];

function scatterItems(rng, numbers, colorFn) {
  const placed = [];
  return numbers.map(num => {
    let x, y, tries = 0;
    do {
      x = rng() * 84 + 3;
      y = rng() * 84 + 3;
      tries++;
    } while (tries < 40 && placed.some(p => Math.abs(p.x - x) < 5.5 && Math.abs(p.y - y) < 7));
    placed.push({ x, y });
    return {
      value: num,
      x, y,
      fontSize:   Math.floor(rng() * 22) + 14,
      rotation:   Math.floor(rng() * 72) - 36,
      fontFamily: FONTS[Math.floor(rng() * FONTS.length)],
      bold:       rng() > 0.42,
      italic:     rng() > 0.68,
      color:      colorFn(num, rng),
    };
  });
}

// Round 1 — chaos with distractors
function genRound1(rng) {
  const real       = Array.from({ length: 49 }, (_, i) => i + 1);
  const distractors = shuffle(Array.from({ length: 37 }, (_, i) => i + 50), rng).slice(0, 22);
  const all         = shuffle([...real, ...distractors], rng);
  return {
    type: 'scatter',
    items: scatterItems(rng, all, (n) => n <= 49
      ? GREENS[Math.floor(rng() * GREENS.length)]
      : GREYS[Math.floor(rng() * GREYS.length)]),
  };
}

// Round 2 — scatter, no distractors
function genRound2(rng) {
  const nums = shuffle(Array.from({ length: 49 }, (_, i) => i + 1), rng);
  return {
    type: 'scatter',
    items: scatterItems(rng, nums, () => GREENS[Math.floor(rng() * GREENS.length)]),
  };
}

// Round 3 — 3 zones, scatter within each
function genRound3(rng) {
  const zones = [
    Array.from({ length: 16 }, (_, i) => i + 1),
    Array.from({ length: 17 }, (_, i) => i + 17),
    Array.from({ length: 16 }, (_, i) => i + 34),
  ];
  const items = [];
  zones.forEach((zone, zi) => {
    const shuffled = shuffle(zone, rng);
    const placed   = [];
    shuffled.forEach(num => {
      let lx, ly, tries = 0;
      do {
        lx = rng() * 27 + 2;
        ly = rng() * 84 + 3;
        tries++;
      } while (tries < 40 && placed.some(p => Math.abs(p.x - lx) < 5 && Math.abs(p.y - ly) < 8));
      placed.push({ x: lx, y: ly });
      items.push({
        value: num,
        zone: zi,
        x: zi * 33.33 + lx,
        y: ly,
        fontSize:   Math.floor(rng() * 18) + 14,
        rotation:   Math.floor(rng() * 52) - 26,
        fontFamily: FONTS[Math.floor(rng() * FONTS.length)],
        bold:       rng() > 0.42,
        italic:     rng() > 0.68,
        color:      GREENS[Math.floor(rng() * GREENS.length)],
      });
    });
  });
  return { type: 'zones', items };
}

// Round 4 — 9-col grid, sequential, varied style
function genRound4(rng) {
  const items = Array.from({ length: 49 }, (_, i) => ({
    value:      i + 1,
    col:        i % 9,
    row:        Math.floor(i / 9),
    fontSize:   Math.floor(rng() * 16) + 13,
    rotation:   Math.floor(rng() * 52) - 26,
    fontFamily: FONTS[Math.floor(rng() * FONTS.length)],
    bold:       rng() > 0.42,
    italic:     rng() > 0.65,
    color:      GREENS[Math.floor(rng() * GREENS.length)],
  }));
  return { type: 'grid', items };
}

// Round 5 — clean grid, uniform style
function genRound5() {
  const items = Array.from({ length: 49 }, (_, i) => ({
    value:  i + 1,
    col:    i % 9,
    row:    Math.floor(i / 9),
    color:  '#1a9850',
  }));
  return { type: 'grid_clean', items };
}

// Round 6 — chaos + find missing numbers
function genRound6(rng) {
  const missingCount = Math.floor(rng() * 4) + 5;
  const allReal      = Array.from({ length: 49 }, (_, i) => i + 1);
  const missing      = shuffle([...allReal], rng).slice(0, missingCount);
  const present      = allReal.filter(n => !missing.includes(n));
  const distractors  = shuffle(Array.from({ length: 37 }, (_, i) => i + 50), rng).slice(0, 22);
  const all          = shuffle([...present, ...distractors], rng);
  return {
    type:    'find_missing',
    subtype: 'scatter',
    missing,
    items:   scatterItems(rng, all, (n) => n <= 49
      ? GREENS[Math.floor(rng() * GREENS.length)]
      : GREYS[Math.floor(rng() * GREYS.length)]),
  };
}

// Round 7 — clean grid, 2 blanks
function genRound7(rng) {
  const allReal = Array.from({ length: 49 }, (_, i) => i + 1);
  const missing = shuffle([...allReal], rng).slice(0, 2);
  const items   = allReal.map((n, i) => ({
    value:   n,
    col:     i % 9,
    row:     Math.floor(i / 9),
    missing: missing.includes(n),
    color:   '#1a9850',
  }));
  return { type: 'find_missing', subtype: 'grid_clean', missing, items };
}

function generateLayout(roundNum, seed) {
  const rng = mkRng(seed * 100 + roundNum * 7);
  switch (roundNum) {
    case 1: return genRound1(rng);
    case 2: return genRound2(rng);
    case 3: return genRound3(rng);
    case 4: return genRound4(rng);
    case 5: return genRound5();
    case 6: return genRound6(rng);
    case 7: return genRound7(rng);
    default: return genRound1(rng);
  }
}

// ── IN-MEMORY SESSION STORE ─────────────────────────────────
const sessions = {};

function randomCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (sessions[c]);
  return c;
}

async function createSession(pin) {
  const code = randomCode();
  const seed = Math.floor(Math.random() * 999983);
  sessions[code] = {
    code, pin, seed,
    state: 'lobby',
    currentRound: 0,
    players: {},
    roundTimer: null,
    roundStartTime: null,
    dbId: null,
  };
  const r = await dbQuery(
    'INSERT INTO sessions (code, host_pin, seed) VALUES ($1,$2,$3) RETURNING id',
    [code, pin, seed]
  );
  if (r.rows[0]) sessions[code].dbId = r.rows[0].id;
  return sessions[code];
}

async function addPlayer(code, name, socketId) {
  const sess = sessions[code];
  if (!sess) return null;
  const pid = `p${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  sess.players[pid] = { id: pid, name, socketId, totalScore: 0, roundScores: {}, dbId: null };
  const r = await dbQuery(
    'INSERT INTO players (session_id, name, socket_id) VALUES ($1,$2,$3) RETURNING id',
    [sess.dbId, name, socketId]
  );
  if (r.rows[0]) sess.players[pid].dbId = r.rows[0].id;
  return sess.players[pid];
}

function getLeaderboard(sess) {
  return Object.values(sess.players)
    .map(p => ({ id: p.id, name: p.name, totalScore: p.totalScore, roundScores: p.roundScores }))
    .sort((a, b) => b.totalScore - a.totalScore);
}

// ── ROUND LIFECYCLE ─────────────────────────────────────────
const BRIEF_DURATION = 4000; // ms before round actually starts

function startRound(code, roundNum) {
  const sess = sessions[code];
  if (!sess) return;
  const cfg    = ROUNDS[roundNum - 1];
  const layout = generateLayout(roundNum, sess.seed);

  sess.currentRound = roundNum;
  sess.state        = 'briefing';

  io.to(`s_${code}`).emit('round_briefing', {
    round: roundNum, name: cfg.name, seconds: cfg.seconds,
    tagline: cfg.tagline, mode: cfg.mode, layout,
  });

  setTimeout(() => {
    if (!sessions[code]) return;
    sess.state          = 'playing';
    sess.roundStartTime = Date.now();
    io.to(`s_${code}`).emit('round_start', {
      round: roundNum, seconds: cfg.seconds, startTime: sess.roundStartTime,
    });
    if (sess.roundTimer) clearTimeout(sess.roundTimer);
    sess.roundTimer = setTimeout(() => endRound(code, roundNum), cfg.seconds * 1000);
  }, BRIEF_DURATION);
}

function endRound(code, roundNum) {
  const sess = sessions[code];
  if (!sess || sess.state === 'result' || sess.state === 'final') return;
  if (!roundNum || roundNum < 1 || roundNum > 7) return; // guard invalid round
  if (sess.roundTimer) { clearTimeout(sess.roundTimer); sess.roundTimer = null; }
  const isFinal = roundNum >= 7;
  sess.state    = isFinal ? 'final' : 'result';
  const cfg     = ROUNDS[roundNum - 1];
  io.to(`s_${code}`).emit('round_end', {
    round: roundNum, name: cfg.name, tagline: cfg.tagline, isFinal,
    leaderboard: getLeaderboard(sess),
  });
}

// ── SOCKET.IO ───────────────────────────────────────────────
io.on('connection', socket => {
  let myCode = null;
  let myPid  = null;

  // HOST: create game
  socket.on('host_create', async ({ pin }, cb) => {
    try {
      const sess = await createSession(pin);
      myCode = sess.code;
      socket.join(`s_${sess.code}`);
      socket.join(`host_${sess.code}`);
      cb({ ok: true, code: sess.code });
    } catch (e) { cb({ ok: false, error: e.message }); }
  });

  // HOST: rejoin
  socket.on('host_rejoin', ({ code, pin }, cb) => {
    const sess = sessions[code];
    if (!sess || sess.pin !== pin) return cb({ ok: false, error: 'Invalid code or PIN' });
    myCode = code;
    socket.join(`s_${code}`);
    socket.join(`host_${code}`);
    cb({ ok: true, state: sess.state, currentRound: sess.currentRound,
         players: Object.values(sess.players).map(p => ({ id: p.id, name: p.name, totalScore: p.totalScore })) });
  });

  // PLAYER: rejoin after reconnect
  socket.on('player_rejoin', ({ code, pid, name }, cb) => {
    const sess = sessions[code];
    if (!sess) return cb({ ok: false, error: 'Session not found.' });
    let player = sess.players[pid];
    // Fall back to name match if pid not found (e.g. server restarted)
    if (!player) player = Object.values(sess.players).find(p => p.name === name);
    if (!player) return cb({ ok: false, error: 'Player not found.' });
    myCode = code; myPid = player.id;
    player.socketId = socket.id;
    socket.join(`s_${code}`);
    cb({ ok: true, playerId: player.id, state: sess.state, currentRound: sess.currentRound });
  });

  // PLAYER: join
  socket.on('player_join', async ({ code, name }, cb) => {
    const sess = sessions[code];
    if (!sess)                    return cb({ ok: false, error: 'Game not found. Check your code.' });
    if (sess.state !== 'lobby')   return cb({ ok: false, error: 'Game already started — ask the host to create a new session.' });
    if (!name || !name.trim())    return cb({ ok: false, error: 'Enter your name.' });
    const player = await addPlayer(code, name.trim().slice(0, 30), socket.id);
    if (!player) return cb({ ok: false, error: 'Could not join.' });
    myCode = code; myPid = player.id;
    socket.join(`s_${code}`);
    io.to(`host_${code}`).emit('player_joined', {
      player: { id: player.id, name: player.name },
      count:  Object.keys(sess.players).length,
    });
    cb({ ok: true, playerId: player.id });
  });

  // HOST: start a round
  socket.on('host_start_round', ({ code, pin, round }, cb) => {
    const sess = sessions[code];
    if (!sess || sess.pin !== pin) return cb?.({ ok: false, error: 'Unauthorized' });
    if (round < 1 || round > 7)   return cb?.({ ok: false });
    if (sess.state === 'briefing' || sess.state === 'playing') {
      return cb?.({ ok: false, error: 'A round is already in progress.' });
    }
    startRound(code, round);
    cb?.({ ok: true });
  });

  // HOST: force end round
  socket.on('host_end_round', ({ code, pin }) => {
    const sess = sessions[code];
    if (sess && sess.pin === pin) endRound(code, sess.currentRound);
  });

  // HOST: reset session (back to lobby)
  socket.on('host_reset', ({ code, pin }, cb) => {
    const sess = sessions[code];
    if (!sess || sess.pin !== pin) return cb?.({ ok: false });
    if (sess.roundTimer) clearTimeout(sess.roundTimer);
    sess.state = 'lobby'; sess.currentRound = 0;
    Object.values(sess.players).forEach(p => { p.totalScore = 0; p.roundScores = {}; });
    io.to(`s_${code}`).emit('session_reset');
    cb?.({ ok: true });
  });

  // PLAYER: submit score for a round
  socket.on('submit_score', ({ code, round, score }) => {
    const sess = sessions[code];
    if (!sess || !myPid) return;
    const player = sess.players[myPid];
    if (!player || player.roundScores[round] !== undefined) return;
    player.roundScores[round] = score;
    player.totalScore = Object.values(player.roundScores).reduce((a, b) => a + b, 0);
    dbQuery(
      'INSERT INTO round_scores (player_id, session_id, round_number, score) VALUES ($1,$2,$3,$4) ON CONFLICT (player_id, round_number) DO UPDATE SET score=$4',
      [player.dbId, sess.dbId, round, score]
    );
    io.to(`s_${code}`).emit('leaderboard_update', { leaderboard: getLeaderboard(sess), round });
  });

  socket.on('disconnect', () => {
    if (myCode && myPid && sessions[myCode]) {
      const p = sessions[myCode].players[myPid];
      if (p) p.socketId = null;
    }
  });
});

// ── BOOT ────────────────────────────────────────────────────
async function start() {
  await initDB().catch(console.error);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => console.log(`Lean Ninja Challenge on port ${PORT}`));
}
start();
