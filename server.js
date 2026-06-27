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
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('[fatal] Unexpected error on idle Postgres client (this used to crash the whole process):', err);
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
    CREATE TABLE IF NOT EXISTS generated_images (
      id TEXT PRIMARY KEY,
      image_data TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE user_data ADD COLUMN IF NOT EXISTS pending_image TEXT;
    ALTER TABLE user_data ADD COLUMN IF NOT EXISTS expecting_paste BOOLEAN DEFAULT FALSE;
  `).catch(() => {});
}

async function loadUserData(userId) {
  const result = await pool.query('SELECT chats, sources, pending_image, expecting_paste FROM user_data WHERE user_id = $1', [userId]);
  if (!result.rows[0]) return { chats: [], sources: [], pendingImage: null, expectingPaste: false };
  
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
    sources: loadedSources,
    pendingImage: result.rows[0].pending_image || null,
    expectingPaste: result.rows[0].expecting_paste || false
  };
}

async function saveUserData(userId, data) {
  await pool.query(
    `INSERT INTO user_data (user_id, chats, sources, pending_image, expecting_paste, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET 
       chats = EXCLUDED.chats, 
       sources = EXCLUDED.sources, 
       pending_image = EXCLUDED.pending_image,
       expecting_paste = EXCLUDED.expecting_paste,
       updated_at = NOW()`,
    [userId, JSON.stringify(data.chats || []), JSON.stringify(data.sources || []), data.pendingImage || null, data.expectingPaste || false]
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

// Repairs JSON that has raw (unescaped) newlines/tabs/carriage-returns inside
// string literals — a common failure mode when the model embeds a markdown
// table or multi-line text inside the "message" field without escaping it.
// Only characters INSIDE a quoted string are touched; structural whitespace
// between JSON tokens (which JSON.parse already tolerates) is left as-is.
function sanitizeJsonNewlines(text) {
  if (typeof text !== 'string') return '';
  let result = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      result.push(ch);
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      result.push(ch);
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result.push(ch);
      continue;
    }
    if (inString) {
      if (ch === '\n') { result.push('\\n'); continue; }
      if (ch === '\r') { result.push('\\r'); continue; }
      if (ch === '\t') { result.push('\\t'); continue; }
    }
    result.push(ch);
  }
  return result.join('');
}

async function resolveImageUrls(messages) {
  if (!Array.isArray(messages)) return;
  const promises = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url && part.image_url.url) {
          const url = part.image_url.url;
          if (url.includes('/api/roblox/image/')) {
            const imageId = url.split('/').pop();
            promises.push((async () => {
              try {
                const result = await pool.query('SELECT image_data, mime_type FROM generated_images WHERE id = $1', [imageId]);
                if (result.rows[0]) {
                  part.image_url.url = `data:${result.rows[0].mime_type};base64,${result.rows[0].image_data}`;
                }
              } catch (err) {
                console.error('Failed to resolve image URL:', err);
              }
            })());
          }
        }
      }
    }
  }
  await Promise.all(promises);
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

const sessionStore = new pgSession({
  pool,
  tableName: 'session',
  createTableIfMissing: true
});

sessionStore.on('error', function(err) {
  console.error('Session store error:', err);
});

app.use(session({
  store: sessionStore,
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

const dbReadyPromise = ensureDatabase().catch(err => {
  console.error('[fatal] Failed to initialize database:', err);
  return Promise.reject(err);
});

app.use((req, res, next) => {
  dbReadyPromise.then(() => next()).catch(() => {
    res.status(503).json({ error: 'Database is not ready yet. Please try again in a moment.' });
  });
});

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
    console.error('[/auth/register] error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/auth/login', (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      console.error('[/auth/login] error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
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
  const { chats, sources, pendingImage, expectingPaste } = req.body;
  if (!Array.isArray(chats) || !Array.isArray(sources)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    await saveUserData(req.user.id, { chats, sources, pendingImage, expectingPaste });
    res.json({ success: true });
  } catch (err) {
    console.error('[api/data] save error:', err);
    res.status(500).json({ error: 'Failed to save user data' });
  }
});

app.post('/api/upload-image', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      'INSERT INTO generated_images (id, image_data, mime_type) VALUES ($1, $2, $3)',
      [imageId, req.file.buffer.toString('base64'), req.file.mimetype]
    );
    res.json({ imageUrl: BASE_URL + '/api/roblox/image/' + imageId });
  } catch (err) {
    console.error('[/api/upload-image] error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---- Streaming text + multimodal chat ----
app.post('/api/chat', async (req, res) => {
  const { messages, temperature, system, model } = req.body;

  await resolveImageUrls(messages);

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

  await resolveImageUrls(messages);

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

// ---- ROBLOX STUDIO ENDPOINTS ----

// Serve a persisted generated image by its unique ID
app.get('/api/roblox/image/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT image_data, mime_type FROM generated_images WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Image not found' });
    const buffer = Buffer.from(result.rows[0].image_data, 'base64');
    res.setHeader('Content-Type', result.rows[0].mime_type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('[/api/roblox/image] error:', err.message);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

// Generate a single GUI image — called by the Roblox plugin as one background task per element.
// Keeping this separate from /api/roblox means the main AI call never blocks on image generation.
app.post('/api/roblox/generate-gui-image', async (req, res) => {
  const { email, password, prompt } = req.body;
  if (!email || !password || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: email, password, prompt' });
  }
  // Authenticate
  try {
    const lowerEmail = email.toLowerCase();
    const userResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [lowerEmail]
    );
    const user = userResult.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Authentication error' });
  }
  // Generate + store
  try {
    const imgRes = await fetch(`${API_BASE}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        n: 1,
        size: '1024x1024'
      })
    });
    const imgData = await imgRes.json();
    if (!imgData.data || !imgData.data[0] || !imgData.data[0].b64_json) {
      return res.status(500).json({ error: 'Image generation failed or returned no data' });
    }
    const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      'INSERT INTO generated_images (id, image_data, mime_type) VALUES ($1, $2, $3)',
      [imageId, imgData.data[0].b64_json, 'image/png']
    );
    res.json({
      success: true,
      imageUrl: BASE_URL + '/api/roblox/image/' + imageId
    });
  } catch (err) {
    console.error('[/api/roblox/generate-gui-image] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/roblox/data', async (req, res) => {
  const { email, password, chats, sources, pendingImage, expectingPaste } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
  try {
    const lowerEmail = email.toLowerCase();
    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [lowerEmail]);
    const user = result.rows[0];
    if (user && await bcrypt.compare(password, user.password_hash)) {
      if (chats && sources) {
        await saveUserData(user.id, { chats, sources, pendingImage, expectingPaste });
        res.json({ success: true });
      } else {
        const userData = await loadUserData(user.id);
        res.json({ success: true, chats: userData.chats, sources: userData.sources, pendingImage: userData.pendingImage, expectingPaste: userData.expectingPaste });
      }
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/roblox', async (req, res) => {
  try {
    const { prompt, history = [], email, password, image, jobId, temperature, model } = req.body;

    let userSourcesText = "";
    let authUser = null;
    if (email && password) {
      const lowerEmail = email.toLowerCase();
      const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [lowerEmail]);
      const user = result.rows[0];
      if (user && await bcrypt.compare(password, user.password_hash)) {
        authUser = user;
        const userData = await loadUserData(user.id);
        if (userData.sources && userData.sources.length > 0) {
          userSourcesText = "\n\nUSER SOURCES (Use these as context):\n" + userData.sources.map(s => `[${s.name}]\n${s.content}`).join('\n\n');
        }
      } else {
        return res.status(401).json({ error: "Invalid email or password.", message: "Invalid email or password.", actions: [] });
      }
    }

    if (jobId && authUser) {
      const jobRes = await pool.query('SELECT status, result FROM ai_jobs WHERE id = $1 AND user_id = $2', [jobId, authUser.id]);
      if (jobRes.rows.length > 0) {
        const job = jobRes.rows[0];
        if (job.status === 'completed') {
          return res.json(job.result);
        } else if (job.status === 'error') {
          return res.status(500).json(job.result);
        } else {
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const check = await pool.query('SELECT status, result FROM ai_jobs WHERE id = $1', [jobId]);
            if (check.rows.length > 0) {
              if (check.rows[0].status === 'completed') return res.json(check.rows[0].result);
              if (check.rows[0].status === 'error') return res.status(500).json(check.rows[0].result);
            }
          }
          return res.status(202).json({ status: 'pending' });
        }
      }
      await pool.query('INSERT INTO ai_jobs (id, user_id, status) VALUES ($1, $2, $3)', [jobId, authUser.id, 'pending']);
    }

    // We force the AI to act as a Roblox Studio assistant and return strict JSON.
    const getSystemPrompt = require('./systemPrompt');
    const systemPrompt = getSystemPrompt(userSourcesText);

    let userContent = prompt;
    if (image) {
      let finalImageUrl = image;
      if (image.includes('/api/roblox/image/')) {
        const imageId = image.split('/').pop();
        const result = await pool.query('SELECT image_data, mime_type FROM generated_images WHERE id = $1', [imageId]);
        if (result.rows[0]) {
          finalImageUrl = `data:${result.rows[0].mime_type};base64,${result.rows[0].image_data}`;
        }
      }
      userContent = [
        { type: 'text', text: prompt || 'What is in this image?' },
        { type: 'image_url', image_url: { url: finalImageUrl } }
      ];
    }

    await resolveImageUrls(history);

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userContent }
    ];

    const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: model || TEXT_MODEL,
        temperature: temperature !== undefined ? Number(temperature) : 0.2, // Low temperature for strict JSON adherence
        stream: false,    // Roblox HttpService cannot handle streams
        messages: fullMessages
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      throw new Error(`Upstream API Error: ${upstream.status} - ${errText}`);
    }

    let data;
    const rawText = await upstream.text();
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      data = {
        choices: [{
          message: { content: rawText }
        }]
      };
    }

    let content = data?.choices?.[0]?.message?.content?.trim() || "";
    let reasoningContent = data?.choices?.[0]?.message?.reasoning_content?.trim() || "";

    let thinkingProcess = reasoningContent;
    const thinkStart = content.indexOf('<think>');
    if (thinkStart !== -1) {
      const thinkEnd = content.indexOf('</think>', thinkStart);
      const extracted = thinkEnd !== -1 ? content.substring(thinkStart + 7, thinkEnd).trim() : content.substring(thinkStart + 7).trim();
      thinkingProcess = thinkingProcess ? thinkingProcess + "\n\n" + extracted : extracted;
    }

    // Narrow down to the outermost JSON object boundaries, in case there's
    // still leading/trailing text outside the fence.
    // This safely ignores markdown fences like ```json and conversational filler.
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      content = content.substring(jsonStart, jsonEnd + 1);
    }

    // Parse to ensure it's valid JSON before sending to Roblox.
    // If the first attempt fails (most commonly because the model embedded a
    // markdown table / multi-line text in "message" with raw, unescaped
    // newlines), retry once with sanitized newlines before giving up — this
    // is what was previously causing actions to silently come back empty.
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(content);
      if (typeof parsedResponse !== 'object' || parsedResponse === null || Array.isArray(parsedResponse)) {
        parsedResponse = { message: String(content), actions: [] };
      }
    } catch (parseErr) {
      try {
        const repaired = sanitizeJsonNewlines(content);
        parsedResponse = JSON.parse(repaired);
        if (typeof parsedResponse !== 'object' || parsedResponse === null || Array.isArray(parsedResponse)) {
          parsedResponse = { message: String(content), actions: [] };
        }
        console.warn('[Roblox] JSON required newline repair to parse successfully.');
      } catch (repairErr) {
        console.error('[Roblox] JSON parse failed even after repair:', repairErr.message);
        parsedResponse = { message: content, actions: [] };
      }
    }

    if (!parsedResponse.actions || !Array.isArray(parsedResponse.actions)) {
      parsedResponse.actions = [];
    }

    if (thinkingProcess) {
      parsedResponse.thinking = thinkingProcess;
    }

    if (jobId && authUser) {
      try {
        await pool.query('UPDATE ai_jobs SET status = $1, result = $2 WHERE id = $3', ['completed', JSON.stringify(parsedResponse), jobId]);
      } catch (dbErr) {
        console.error('[DB Update Error]:', dbErr);
      }
    }
    res.json(parsedResponse);

  } catch (err) {
    console.error("[Roblox API Error]:", err);
    const errResult = { error: err.message, message: "Internal Server Error", actions: [] };
    if (req.body.jobId && req.body.email) {
      try {
        await pool.query('UPDATE ai_jobs SET status = $1, result = $2 WHERE id = $3', ['error', JSON.stringify(errResult), req.body.jobId]);
      } catch (dbErr) {
        console.error('[DB Update Error in catch]:', dbErr);
      }
    }
    if (!res.headersSent) {
      res.status(500).json(errResult);
    }
  }
});

(async () => {
  try {
    await dbReadyPromise;
    // Only listen on a port if we are NOT in Vercel (local development)
    if (process.env.NODE_ENV !== 'production') {
      const PORT = process.env.PORT || 3000;
      app.listen(PORT, () => {
        console.log(`Zero-Burn chat running at http://localhost:${PORT}`);
      });
    }
  } catch (err) {
    console.error('[fatal] Server failed to start because the database was not ready:', err);
  }
})();

// VERCEL REQUIRES THIS EXPORT
module.exports = app;
