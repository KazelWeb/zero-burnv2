const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const multer = require('multer');
const dotenv = require('dotenv');
const FormData = require('form-data');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const API_BASE = process.env.API_BASE || 'https://zero-burn.isshiai.com';
const API_KEY = process.env.API_KEY;
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-2.5-flash';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image-preview';

if (!API_KEY) {
  console.warn('[warn] No API_KEY set in .env — requests to the upstream API will fail.');
}

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required. Set it in environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function ensureDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      photo_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      otp_code VARCHAR(6),
      otp_expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chats JSONB NOT NULL DEFAULT '[]',
      sources JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function loadUserData(userId) {
  const result = await pool.query('SELECT chats, sources FROM user_data WHERE user_id = $1', [userId]);
  if (!result.rows[0]) return { chats: [], sources: [] };
  
  let loadedChats = result.rows[0].chats || [];
  let loadedSources = result.rows[0].sources || [];
  
  if (typeof loadedChats === 'string') {
    try { loadedChats = JSON.parse(loadedChats); } catch(e) { loadedChats = []; }
  }
  if (typeof loadedSources === 'string') {
    try { loadedSources = JSON.parse(loadedSources); } catch(e) { loadedSources = []; }
  }

  return {
    chats: loadedChats,
    sources: loadedSources
  };
}

async function saveUserData(userId, data) {
  await pool.query(
    `INSERT INTO user_data (user_id, chats, sources, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET chats = EXCLUDED.chats, sources = EXCLUDED.sources, updated_at = NOW()`,
    [userId, JSON.stringify(data.chats || []), JSON.stringify(data.sources || [])]
  );
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find(p => p.type === 'text');
    return textPart ? textPart.text : '';
  }
  return '';
}

function normalizeForCompare(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      'SELECT id, email, display_name AS "displayName" FROM users WHERE id = $1',
      [id]
    );
    done(null, result.rows[0] || false);
  } catch (err) {
    done(err);
  }
});

passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, async (email, password, done) => {
  try {
    const result = await pool.query(
      'SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash" FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return done(null, false, { message: 'Invalid email or password.' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return done(null, false, { message: 'Invalid email or password.' });
    delete user.passwordHash;
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

app.set('trust proxy', 1);
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));
app.use(passport.initialize());
app.use(passport.session());

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.post('/auth/register', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const lowerEmail = email.toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [lowerEmail]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, created_at, last_login_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, email, display_name AS "displayName"`,
      [lowerEmail, passwordHash, displayName || lowerEmail]
    );

    req.login(result.rows[0], err => {
      if (err) return res.status(500).json({ error: 'Failed to log in after registration.' });
      res.json({ success: true, user: { email: result.rows[0].email, displayName: result.rows[0].displayName } });
    });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/auth/login', (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(401).json({ error: info.message || 'Invalid credentials' });

    req.login(user, err => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      res.json({ authenticated: true, user: { email: user.email, displayName: user.displayName } });
    });
  })(req, res, next);
});

app.post('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.json({ success: true });
  });
});

app.get('/api/user', (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({ authenticated: false });
  }
  const { email, displayName } = req.user;
  res.json({
    authenticated: true,
    user: {
      email,
      displayName
    }
  });
});

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const data = await loadUserData(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user data' });
  }
});

app.post('/api/data', requireAuth, async (req, res) => {
  const { chats, sources } = req.body;
  if (!Array.isArray(chats) || !Array.isArray(sources)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    await saveUserData(req.user.id, { chats, sources });
    res.json({ success: true });
  } catch (err) {
    console.error('[api/data] save error:', err);
    res.status(500).json({ error: 'Failed to save user data' });
  }
});

// ---- Streaming text + multimodal chat ----
app.post('/api/chat', async (req, res) => {
  const { messages, temperature, system, model } = req.body;

  const fullMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  try {
    const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: model || TEXT_MODEL,
        temperature: temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        messages: fullMessages
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: errText });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    upstream.body.on('data', (chunk) => res.write(chunk));
    upstream.body.on('end', () => res.end());
    upstream.body.on('error', () => res.end());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- AI-generated chat title ----
app.post('/api/generate-title', async (req, res) => {
  const { messages } = req.body;

  const titleMessages = [
    {
      role: 'system',
      content: 'You generate short chat titles. Read the conversation and respond with ONLY a concise 3-6 word title that summarizes the TOPIC of the conversation. Always paraphrase in your own words — never repeat or copy the user\'s message verbatim, even if it is already short. Do not include question marks, quotation marks, or trailing punctuation. Use Title Case. Example: if the user asks "How to make a Roblox game?", a good title is "Building A Roblox Game" — not "How To Make A Roblox Game".'
    },
    ...(messages || []).slice(0, 6)
  ];

  const firstUserText = extractMessageText((messages || [])[0] && (messages || [])[0].content);

  function fallbackTitleFrom(text) {
    const cleaned = (text || '')
      .replace(/[?!.]+$/g, '')
      .replace(/^(how to|what is|what's|why does|why is|can you|please|how do i|how can i)\s+/i, '')
      .trim();
    const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return 'New Chat';
    return words
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  try {
    const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        temperature: 0.3,
        stream: false,
        messages: titleMessages
      })
    });

    if (!upstream.ok) {
      console.warn('[generate-title] upstream returned', upstream.status);
      return res.status(200).json({ title: fallbackTitleFrom(firstUserText) });
    }

    const data = await upstream.json();
    let title = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content.trim().replace(/^["']|["']$/g, '')
      : '';

    // Strip any stray trailing punctuation the model might still include
    title = title.replace(/[?!.]+$/g, '').trim();

    // Safety net: if the model just echoed the user's message verbatim (or gave nothing), rename it ourselves
    if (!title || (firstUserText && normalizeForCompare(title) === normalizeForCompare(firstUserText))) {
      title = fallbackTitleFrom(firstUserText);
    }

    if (!title) title = 'New Chat';

    res.status(200).json({ title });
  } catch (err) {
    console.warn('[generate-title] failed, using fallback:', err.message);
    res.status(200).json({ title: fallbackTitleFrom(firstUserText) });
  }
});

// ---- Text-to-image generation ----
app.post('/api/generate-image', async (req, res) => {
  const { prompt, size } = req.body;
  try {
    const r = await fetch(`${API_BASE}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        n: 1,
        size: size || '1024x1024'
      })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Image editing (multipart upload of 1-4 images) ----
app.post('/api/edit-image', upload.array('images', 4), async (req, res) => {
  try {
    const form = new FormData();
    form.append('model', IMAGE_MODEL);
    form.append('prompt', req.body.prompt || '');
    form.append('n', '1');
    form.append('size', req.body.size || '1024x1024');

    // Use file.buffer instead of fs.createReadStream
    for (const file of req.files) {
      form.append('image', file.buffer, file.originalname);
    }

    const r = await fetch(`${API_BASE}/v1/images/edits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    const data = await r.json();
    res.status(r.status).json(data);

    // We removed the fs.unlink() loop because memory storage clears automatically.
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


(async () => {
  try {
    await ensureDatabase();
    // Only listen on a port if we are NOT in Vercel (local development)
    if (process.env.NODE_ENV !== 'production') {
      const PORT = process.env.PORT || 3000;
      app.listen(PORT, () => {
        console.log(`Zero-Burn chat running at http://localhost:${PORT}`);
      });
    }
  } catch (err) {
    console.error('[fatal] Failed to initialize database:', err);
    process.exit(1);
  }
})();

// VERCEL REQUIRES THIS EXPORT
module.exports = app;
