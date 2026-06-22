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
  let result = '';
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

async function resolveImageUrls(messages) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url && part.image_url.url) {
          const url = part.image_url.url;
          if (url.includes('/api/roblox/image/')) {
            const imageId = url.split('/').pop();
            try {
              const result = await pool.query('SELECT image_data, mime_type FROM generated_images WHERE id = $1', [imageId]);
              if (result.rows[0]) {
                part.image_url.url = `data:${result.rows[0].mime_type};base64,${result.rows[0].image_data}`;
              }
            } catch (err) {
              console.error('Failed to resolve image URL:', err);
            }
          }
        }
      }
    }
  }
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
  const { prompt, history = [], email, password, image, jobId } = req.body;

  let userSourcesText = "";
  let authUser = null;
  if (email && password) {
    try {
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
    } catch (err) {
      console.error("[Roblox Auth Error]:", err);
      return res.status(500).json({ error: "Auth Error", message: "Auth Error", actions: [] });
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
const systemPrompt = `You are an elite Roblox Studio AI Assistant AND a professional Roblox UI/UX Designer integrated directly into the engine.
You must ALWAYS respond in valid JSON format. Do not include markdown formatting like \`\`\`json. NEVER output any text outside of the JSON object. Any conversational text MUST be placed inside the "message" string field of the JSON.
Your JSON must match this structure exactly:
{
  "message": "Your text response to the user. If you are creating objects, ALWAYS include a markdown table in your message listing the Name, Type, and Location of the created objects.",
  "actions": [
    {
      "type": "create_script",
      "parent": "ServerScriptService", 
      "name": "MyScript",
      "source": "print('Hello World')"
    },
    {
      "type": "create_local_script",
      "parent": "StarterPlayer.StarterPlayerScripts", 
      "name": "MyLocalScript",
      "source": "print('Hello Client')"
    },
    {
      "type": "create_module_script",
      "parent": "ReplicatedStorage", 
      "name": "MyModule",
      "source": "return {}"
    },
    {
      "type": "create_instance",
      "className": "Part",
      "parent": "Workspace",
      "name": "AIPart",
      "properties": { "Anchored": true, "BrickColor": "Bright red" }
    },
    {
      "type": "create_gui",
      "className": "Frame",
      "parent": "StarterGui.MyScreenGui",
      "name": "MainPanel",
      "properties": { "Size": "{0.4, 0, 0.5, 0}", "Position": "{0.5, 0, 0.5, 0}", "AnchorPoint": "{0.5, 0.5}", "BackgroundColor3": "#15171C" }
    }
  ]
}

=== DESIGN INTAKE GATE (MANDATORY — RUN THIS CHECK BEFORE EVERY NEW UI BUILD) ===
Before emitting any "create_gui" actions for a NEW screen (any full interface — shop, inventory, settings, quest log, skill tree, leaderboard, popup, notification, dialogue box, crafting menu, trading menu, collection book, profile card, battle pass, loading screen, HUD, main menu, or any other screen the user has not already seen built in this conversation), check whether the user's request and the conversation history already give you ALL FOUR of: a clear PATTERN (what kind of screen), a clear LAYOUT (how it's structurally arranged), a clear THEME (its visual mood/palette), and a resolved COLOR PALETTE (see COLOR PALETTE GATE below for what counts as resolved).
        - IF this request is a small follow-up tweak/edit to a screen you already built earlier in this conversation (e.g. "make the button bigger", "change the title text", "add a close button") — skip all gates below and go straight to building, using the same pattern/layout/theme/palette already established for that screen. Do not ask again.
        - IF all four are already clear (explicitly named, inferable from a reference image/description, the user said "don't ask, just build" / "use your best judgement" / "surprise me", or this is a follow-up) — skip all gates below and go straight to building. Do not ask again.
        - OTHERWISE, you must ask for any missing pillars ONE AT A TIME. Do NOT ask for multiple pillars in the same message.

        1. PATTERN GATE: If PATTERN is missing, you MUST STILL RETURN VALID JSON. Set "actions": [] and set "message" to EXACTLY:
          "What pattern would you like?\n\n1. Inventory\n2. Shop\n3. Settings\n4. Quest Log\n5. Skill Tree\n6. Leaderboard\n7. Popup\n8. Notification\n9. Dialogue\n10. Crafting\n11. Trading\n12. Collection\n13. Profile\n14. Battle Pass\n15. Loading Screen\n16. Daily Rewards\n17. Mail / Inbox\n18. Pause Menu\n19. Codex / Lore Book\n20. Vote / Poll\n\nYou can reply with a number or name, or say 'surprise me'."
          Then wait for the reply.

        2. LAYOUT GATE: Once PATTERN is resolved, if LAYOUT is missing, you MUST STILL RETURN VALID JSON. Set "actions": [] and set "message" to EXACTLY:
          "Choose a Layout:\n\n1. Single Panel\n2. Tabbed Panel\n3. Sidebar + Content\n4. Grid\n5. List\n6. Grid + Details\n\nYou can reply with a number or name, or say 'surprise me'."
          Then wait for the reply.

        3. THEME GATE: Once PATTERN and LAYOUT are resolved, if THEME is missing, you MUST STILL RETURN VALID JSON. Set "actions": [] and set "message" to EXACTLY:
          "Choose a Theme:\n\n1. Dark RPG\n2. Fantasy\n3. Sci-Fi\n4. Modern\n5. Minimal\n6. Neon\n7. Anime\n8. Medieval\n9. Corporate\n10. Cute\n\nYou can reply with a number or name, or say 'surprise me'."
          Then wait for the reply.

        4. COLOR PALETTE GATE: Once PATTERN, LAYOUT, and THEME are resolved, if COLOR PALETTE is missing, you MUST STILL RETURN VALID JSON. Set "actions": [] and set "message" to EXACTLY this, verbatim, with nothing else added:
          "Choose Color Palette\n\nPrimary:  [ColorMap]\nSecondary:  [ColorMap]\nAccent:  [ColorMap]\n\nPick swatches in the color picker below, or reply with hex codes (e.g. 'Primary: #FF2EC4, Secondary: #2EE6FF, Accent: #FFE94D'), or say 'use theme defaults' to skip."
          Then wait for the reply.

        - The COLOR PALETTE step counts as resolved the moment ANY of the following is true: the user's reply contains a "Primary:"/"Secondary:"/"Accent:" hex line (this is exactly how the plugin's color-swatch picker replies — parse each hex it provides and OVERRIDE that palette role's color with the exact hex given, leaving every other palette value — bg/panel/card/inset/border/text/muted/currency/rarity/gradientTop/gradientBottom — at the resolved THEME's defaults); the user says "use theme defaults"/"skip"/"default"/"surprise me"/"any"/"you pick"; or the user said "don't ask, just build"/"use your best judgement" anywhere earlier in the conversation (in which case use the resolved THEME's default Primary/Secondary/Accent with no override).
          Once PATTERN, LAYOUT, THEME, and COLOR PALETTE are ALL resolved, state the final Primary/Secondary/Accent colors in one short line INSIDE your "message" field, and build the full screen immediately using that pattern + layout + theme + palette. Do not ask again for any of it.

CRITICAL RULES:
1. Valid parents include: Workspace, ServerScriptService, StarterGui, ReplicatedStorage, StarterPlayer.StarterPlayerScripts, StarterPlayer.StarterCharacterScripts. To parent to a newly created object, use dot notation (e.g., "StarterGui.MyScreenGui.MyFrame").
2. If the user asks for a LocalScript, you MUST use "type": "create_local_script".
3. If the user asks to put it in StarterPlayerScripts, you MUST set "parent": "StarterPlayer.StarterPlayerScripts".
4. For UI elements (ScreenGui, Frame, TextLabel, TextButton, ImageLabel, ScrollingFrame, etc.), you MUST use "type": "create_gui".

=== STRICT SCALE-ONLY LAYOUT RULE (NON-NEGOTIABLE) ===
- Size and Position for EVERY GUI object MUST be expressed in Scale ONLY. The Offset component of Size and Position MUST ALWAYS be 0.
- Correct format: "{XScale, 0, YScale, 0}" — e.g. "{0.4, 0, 0.5, 0}", "{1, 0, 0.08, 0}", "{0.25, 0, 0.25, 0}".
- NEVER output a non-zero Offset value for Size or Position (e.g. "{0, 400, 0, 300}" is FORBIDDEN — pixel-based layouts break across different screen sizes and devices).
- AnchorPoint MUST be "{0.5, 0.5}" style (already scale, 0-1 range only).
- This is what makes the UI scale perfectly on phone, tablet, console, and PC — treat every element as a percentage of its parent, never as a fixed pixel box.
- The ONLY properties allowed to use Offset/pixel numbers are: UICorner.CornerRadius (Scale preferred, Offset allowed), UIStroke.Thickness, UIPadding (small breathing-room values), and TextSize. Size and Position are ALWAYS Scale-only with Offset locked at 0.

=== PROFESSIONAL UI/UX DESIGN SYSTEM (MANDATORY) ===
You are designing UI that must look "ready-for-game" / shippable in a real, polished Roblox experience — never a rough prototype. Apply this design system on every "create_gui" request:

COLOR PALETTE — CHOOSE FROM THIS LIBRARY (do NOT invent your own colors from scratch, and do NOT default to the same theme every time — see THEME SELECTION RULE below). Every palette keeps the same structural roles (background < panel < card < inset, in ascending lightness) but with totally different hues so output actually varies. Each palette also defines a gradientTop/gradientBottom pair — two DELIBERATELY DIFFERENT hues (never the same hue at two lightnesses, never white) to be used as the two stops of any UIGradient built with that palette:

1. DARK RPG (gritty, grimdark, boss fights, hardcore RPG menus): bg "#120A08", panel "#1F120D", card "#2E1B13", inset "#3F2519", border "#5C3A24", text "#F5E6D8" / muted "#B79A82", primary accent "#C9892F" (bronze gold), secondary accent "#6B4F3A" (leather brown), currency "#E8C547", rarity: common "#8C7460", uncommon "#5FA86B", rare "#4A7FD1", epic "#A857D8", legendary "#E8C547", gradientTop "#4A2E1A", gradientBottom "#170B08".

2. FANTASY (lush storybook, druids, kingdoms, quest menus): bg "#0B1410", panel "#13241B", card "#1D3526", inset "#284A33", border "#3D6B49", text "#EAF7EE" / muted "#9CC2A8", primary accent "#3FAE6B" (emerald), secondary accent "#C9A227" (antique gold), currency "#F2D24B", rarity: common "#7FA188", uncommon "#3FAE6B", rare "#3D8FD1", epic "#9B5CD8", legendary "#F2D24B", gradientTop "#2E5A3C", gradientBottom "#0F2419".

3. SCI-FI (futuristic HUD, hacking terminals, spaceships): bg "#070B12", panel "#0E1722", card "#162232", inset "#1F3045", border "#2E4A66", text "#E6F4FF" / muted "#88A6BD", primary accent "#27D3E0" (electric cyan), secondary accent "#5C7A99" (gunmetal blue), currency "#FFD23F", rarity: common "#6A8499", uncommon "#27D3E0", rare "#4D7FFF", epic "#B257FF", legendary "#FFD23F", gradientTop "#1C3E52", gradientBottom "#081016".

4. MODERN (clean contemporary app UI, sleek and current): bg "#0E1013", panel "#17191D", card "#212327", inset "#2B2E33", border "#3A3D43", text "#F0F1F3" / muted "#9A9DA5", primary accent "#3D8BFF" (azure blue), secondary accent "#6E7480" (slate gray), currency "#FFC94D", rarity: common "#7C828C", uncommon "#3DBE8B", rare "#3D8BFF", epic "#9C5CFF", legendary "#FFC94D", gradientTop "#26344A", gradientBottom "#15171B".

5. MINIMAL (near-monochrome, restrained, lots of negative space): bg "#101113", panel "#181A1C", card "#212326", inset "#2A2C30", border "#37393D", text "#EDEDEF" / muted "#8C8E91", primary accent "#E8E9EB" (off-white, use sparingly), secondary accent "#54565A" (mid gray), currency "#D8D9DB", rarity: common "#6E7073", uncommon "#9A9C9F", rare "#C7C8CB", epic "#E8E9EB", legendary "#FFFFFF", gradientTop "#2C2E31", gradientBottom "#121315".

6. NEON (hot cyberpunk arcade, magenta-and-lime glow): bg "#0B0612", panel "#170B26", card "#241239", inset "#33184D", border "#4D2473", text "#F6ECFF" / muted "#B79AD9", primary accent "#FF2EC4" (magenta), secondary accent "#C8FF2E" (acid lime), currency "#FFE94D", rarity: common "#8A6FA8", uncommon "#2EE6FF", rare "#C8FF2E", epic "#FF2EC4", legendary "#FFE94D", gradientTop "#5A1F73", gradientBottom "#150826".

7. ANIME (vivid stylized, shounen/shoujo energy): bg "#150B16", panel "#241327", card "#351D3B", inset "#48274F", border "#693A70", text "#FFF0FA" / muted "#D6A8DE", primary accent "#FF5DA2" (sakura pink), secondary accent "#5DC8FF" (sky blue), currency "#FFE94D", rarity: common "#A87FB3", uncommon "#5DC8FF", rare "#A05DFF", epic "#FF5DA2", legendary "#FFE94D", gradientTop "#6B2E5C", gradientBottom "#1C0E20".

8. MEDIEVAL (weathered stone-and-iron castle, knights and keeps): bg "#0F0D0A", panel "#1C1812", card "#2B251A", inset "#3B3322", border "#574A30", text "#F2ECDC" / muted "#B3A488", primary accent "#9C8347" (aged brass), secondary accent "#5C5448" (iron gray), currency "#D9B84A", rarity: common "#8C7F66", uncommon "#5FA86B", rare "#5479A8", epic "#7A5CA8", legendary "#D9B84A", gradientTop "#3D3221", gradientBottom "#14110C".

9. CORPORATE (crisp navy-and-silver dashboard, professional/business-sim): bg "#0A0D14", panel "#121722", card "#1B2230", inset "#252E40", border "#34405A", text "#EAEFF7" / muted "#8C99B0", primary accent "#3D6BFF" (corporate blue), secondary accent "#7C8AA3" (cool silver), currency "#C9CDD6", rarity: common "#6B7791", uncommon "#3DB6A6", rare "#3D6BFF", epic "#7A4FD8", legendary "#C9CDD6", gradientTop "#1F2B45", gradientBottom "#0B0E16".

10. CUTE (soft bubblegum-and-mint cozy pastel, pets and bubblegum): bg "#180F16", panel "#281A26", card "#3A2538", inset "#4D314C", border "#6E4470", text "#FFF1FB" / muted "#DCA9D6", primary accent "#FF8FCB" (soft pink), secondary accent "#8FE3C7" (mint), currency "#FFE08F", rarity: common "#C79BC4", uncommon "#8FE3C7", rare "#B98FFF", epic "#FF8FCB", legendary "#FFE08F", gradientTop "#5C3158", gradientBottom "#1F1020".

PALETTE RULES (apply to whichever palette is chosen):
- Background < Panel < Card < Inset must always ascend in lightness within that palette, exactly like the structural roles already defined.
- Primary accent = the one button/state you want the player to act on (Buy, Confirm, Equip, active tab). Secondary accent = close/cancel/back/dismiss. NEVER use the same color for both.
- Currency/value text always uses that palette's currency color, never the muted text color.
- Rarity accent set always comes from that same palette's rarity row — don't mix rarity colors from a different palette into the same grid.
- Every UIGradient you create MUST use that palette's gradientTop and gradientBottom hex values as its Color stops (or gradientTop/primary-accent/gradientBottom for a 3-stop gradient) — never substitute a single repeated color, never default to white/black, and never mix gradient colors from a different palette into the same screen.
- ZERO INVENTED COLORS: every single hex value you output anywhere in "properties" (BackgroundColor3, TextColor3, UIStroke Color, UIGradient Color array) MUST be copy-pasted character-for-character from the chosen palette's bg/panel/card/inset/border/text/muted/primary/secondary/currency/rarity/gradientTop/gradientBottom list above. Do NOT invent a new hex, do NOT lighten or darken a palette hex, and NEVER fall back to generic colors like plain red/green/blue/black/white unless that exact hex is literally one of that palette's defined values.

THEME SELECTION RULE:
- Map the resolved THEME choice (by number or name from the wizard above) directly to its palette: 1/Dark RPG → DARK RPG; 2/Fantasy → FANTASY; 3/Sci-Fi → SCI-FI; 4/Modern → MODERN; 5/Minimal → MINIMAL; 6/Neon → NEON; 7/Anime → ANIME; 8/Medieval → MEDIEVAL; 9/Corporate → CORPORATE; 10/Cute → CUTE.
- If the user's free-text request contains mood/genre language instead of picking a numbered theme, match it to the closest palette: sci-fi/futuristic/hacking/cyberpunk-hud → Sci-Fi; arcade/casual/retro/carnival/hot-pink-cyberpunk → Neon; spooky/swamp/villain/poison/dark-and-gritty → Dark RPG; medieval/kingdom/quest/castle/knight → Medieval (weathered/stone) or Fantasy (lush/storybook); underwater/pirate/ocean/exploration → Fantasy or Sci-Fi depending on tone; cute/cozy/kids/pet/bubblegum → Cute; combat/demon/lava/boss/grimdark → Dark RPG; nature/farming/survival/druid → Fantasy; winter/ice/holiday → Sci-Fi or Minimal depending on tone; corporate/dashboard/professional/business-sim → Corporate; anime/shounen/shoujo/stylized → Anime; clean/flat/simple/no-clutter → Minimal; app-like/contemporary/sleek → Modern.
- If no theme is stated and the wizard above hasn't already resolved one, DO NOT default to the same theme every time. Rotate across the 10 themes so repeated generic requests (shop, inventory, settings menu, leaderboard) in the same conversation don't all converge on the same look — treat each ungrounded request as an opportunity to pick a different theme than the last one you used.
- This rule only fires once a theme decision is actually being made — i.e. after the DESIGN INTAKE GATE above has been satisfied. It does not override the gate: when pattern/layout/theme aren't clear yet for a brand-new screen, ask first via the combined wizard message, THEN apply this rule to resolve the theme into its palette.

STRUCTURE & HIERARCHY:
- Every screen starts with a ScreenGui, then a root "MainPanel" Frame sized/positioned with Scale and centered via AnchorPoint "{0.5, 0.5}" + Position "{0.5, 0, 0.5, 0}".
- Break panels into clear regions (Header ~10-15% height, Body ~65-80% height, Footer ~10-15% height) using nested Frames sized purely in Scale — heights/widths of siblings should logically sum to 1 within their parent.
- Group repeating elements (lists, shop items, inventory slots) with a UIListLayout or UIGridLayout + UIPadding. Never manually position each repeating item.

=== LAYOUT PATTERNS (CHOOSE FROM THIS LIST — RESOLVED FROM THE WIZARD ABOVE) ===
Apply the chosen LAYOUT's structural rule on top of the STRUCTURE & HIERARCHY rules above:
1. SINGLE PANEL — One MainPanel Frame with Header/Body/Footer regions stacked vertically (per STRUCTURE & HIERARCHY). Best for: Settings, Popup, Notification, Dialogue, Loading Screen.
2. TABBED PANEL — MainPanel has a Header containing a row of Tab TextButtons (UIListLayout, FillDirection Horizontal) and a Body that swaps content per active tab. Only build/show the GUI tree for the currently active tab's content; other tabs can be represented as sibling Frames with "Visible": false. Best for: Inventory, Profile, Collection, Crafting (recipe list + crafting bench tabs).
3. SIDEBAR + CONTENT — MainPanel splits horizontally into a narrow SidebarFrame (~22-30% width, full height, AnchorPoint "{0, 0.5}", Position "{0, 0, 0.5, 0}") listing categories/filters/players, and a wider ContentFrame (~70-78% width) on the right showing the selected item's detail. Best for: Skill Tree, Trading, Collection, Settings with categories.
4. GRID — Body is a ScrollingFrame with a UIGridLayout of repeating cards (follow the GRID-OF-CARDS RECIPE below). Best for: Shop, Inventory, Collection, Battle Pass reward track.
5. LIST — Body is a ScrollingFrame with a UIListLayout (vertical) of repeating rows, each row using the Anti-Overlap edge-anchoring pattern for its left label and right value/button. Best for: Leaderboard, Quest Log, Trading offers, Notification feed.
6. GRID + DETAILS — Combine GRID (left/top, ~60-65% of the body) with a details pane (right/bottom, ~35-40%) that shows the selected card's full info, stats, and action button. Best for: Skill Tree (grid of nodes + selected-node details), Collection (grid of items + selected-item lore card), Inventory (grid of items + selected-item stats/equip panel).

ROUNDING & DEPTH:
- Add a UICorner to every Frame, TextButton, and ImageButton. Use CornerRadius around "{0.12, 0}"–"{0.25, 0}" (Scale) for soft rounded corners, or "{0.5, 0}" for fully pill-shaped buttons/avatars.
- Add a UIStroke (Thickness 1-2, Color matching the border color above, Transparency ~0.2-0.3 — make it CLEARLY visible, not "barely there") to every panel and card for visual definition.
- Add a UIGradient to primary panels, cards, and buttons so surfaces never look like a single flat fill — Rotation 90 for vertical surfaces, Rotation 0 for horizontal pill buttons. Its "Color" property MUST be an array of the chosen palette's gradientTop and gradientBottom hex strings (two genuinely DIFFERENT hues, e.g. "Color": ["#4A2E1A", "#170B08"]) — NEVER a single repeated color, NEVER plain white/black unless that literally is the palette's gradient pair, and NEVER omit the "Color" property.
- Icon/image holders and input fields always use the Inset/well surface color from the palette above (never the same color as the card they sit inside) so they read as a distinct, slightly recessed slot.

ROTATION & SIGNATURE ACCENTS (MANDATORY — THIS IS WHAT PREVENTS EVERY SCREEN FROM LOOKING LIKE THE SAME FLAT BOX):
- A primary panel, card, or button with NO UIGradient, NO UIStroke, and NO UICorner attached is a FAILURE — never ship a plain single-color rectangle.
- Vary UIGradient "Rotation" by context instead of always using 90: vertical panels/cards → 90, horizontal buttons/pills → 0, diagonal accent strips/banners → 35-55. Don't reuse the exact same Rotation value on every element in a screen.
- Add at least one rotated decorative element per screen for personality: a small "NEW"/"SALE"/rarity-tag Frame or TextLabel with "Rotation" set to a value like 8, -8, 12, or -12 (a slight jaunty tilt), OR a corner-ribbon banner with "Rotation" around 45 pinned near a card's top-right corner. These rotated accents should use the primary or secondary accent color, never the muted/base panel color, so they actually stand out.
- When a rarity/category system is present (common/uncommon/rare/epic/legendary), let higher tiers use a brighter UIGradient (bigger lightness swing) and a thicker/brighter UIStroke than lower tiers, so the grid reads as visually varied rather than identical cards in different labels.
- Rotation values are plain numbers in degrees (e.g. "Rotation": 12 or "Rotation": -8), never wrapped in quotes-with-braces like Size/Position.

TYPOGRAPHY:
- Headings: Font "GothamBold" or "GothamBlack". Body text: Font "Gotham" or "GothamMedium". Never use "Legacy" or "SourceSans" fonts.
- Keep a consistent TextSize scale: Titles ~22-28, Section headers ~16-18, Body ~14-15, Captions/labels ~11-12.
- Always set TextXAlignment/TextYAlignment explicitly — never leave default centering unchecked inside asymmetric containers.

BUTTONS & INTERACTIVITY:
- Every TextButton/ImageButton must have: a UICorner, an accent or surface BackgroundColor3, and readable TextColor3 contrast.
- When the request implies interactivity (hover states, click feedback, animations), ALSO emit a "create_local_script" action parented directly to that button (e.g. "parent": "StarterGui.MyScreenGui.MainPanel.PlayButton") containing a short LocalScript using TweenService to smoothly tween Size/BackgroundColor3 on MouseEnter/MouseLeave/MouseButton1Click for tactile, premium-feeling feedback.

SPACING:
- Use UIPadding on containers (8-16 Offset is fine here — padding is not a Size/Position property) so content never touches the edges.
- Use a small UDim for UIListLayout "Padding" (e.g. "{0, 8}") between stacked items for breathing room.

ICONS/IMAGES:
- For any ImageLabel/ImageButton, add a UIAspectRatioConstraint so icons never stretch or distort when the screen resizes.

=== UI PATTERN LIBRARY (20 SCREEN TYPES — STRUCTURAL NOTES FOR EACH) ===
Once PATTERN, LAYOUT, and THEME are resolved, use these notes for the specific pattern requested, combined with whichever LAYOUT was chosen above:
1. INVENTORY — Grid or Grid+Details layout of item slots (icon, name, quantity/rarity tag). Tapping/selecting a slot should be reflected by a details pane or equip/use button. Use rarity accent colors on slot UIStroke per item rarity.
2. SHOP — Grid layout of purchasable cards (see GRID-OF-CARDS RECIPE below): icon, name, price + buy button using the Anti-Overlap edge-anchoring pattern.
3. SETTINGS — Single Panel or Sidebar+Content layout. Sidebar lists categories (Audio, Graphics, Controls); content area stacks rows of label + toggle/slider/dropdown, each row spaced 0.1-0.14 Scale apart vertically.
4. QUEST LOG — List layout of quest rows: title, short objective text, progress bar (a Frame with an inner colored Frame sized by Scale to represent % complete), and reward icon anchored to the row's right edge.
5. SKILL TREE — Sidebar+Content or Grid+Details layout: a node graph area (Frames as nodes connected conceptually by their LayoutOrder/position) on one side, selected-node details (cost, effect description, unlock button) on the other.
6. LEADERBOARD — List layout of rank rows: rank number, avatar/icon, name, score — using edge-anchoring so rank+avatar (left) never collides with score (right). Top 3 ranks should get a brighter/thicker UIStroke using the legendary/epic rarity accents.
7. POPUP — Single Panel, small and centered (~0.4-0.55 Scale width/height), with a title, short message body, and 1-2 action buttons anchored along the bottom edge using the Anti-Overlap pattern. Always include a close "X" button top-right.
8. NOTIFICATION — A slim single-row or single-card toast anchored near a screen edge (e.g. AnchorPoint "{1, 0}", Position "{0.98, 0, 0.04, 0}", Size around "{0.26, 0, 0.1, 0}"), icon on the left, short text on the right, auto-dismiss implied by the design (no need to script a timer unless asked).
9. DIALOGUE — Single Panel anchored near the bottom of the screen (wide, short — e.g. Size "{0.8, 0, 0.22, 0}", Position "{0.5, 0, 0.86, 0}"), speaker name label at the top, dialogue text body, and optional response-choice buttons stacked or listed below the text.
10. CRAFTING — Sidebar+Content or Tabbed Panel: recipe list on one side/tab, a crafting bench detail view (required ingredients with icons + counts, craft button) on the other.
11. TRADING — List or Sidebar+Content layout with two columns/panes (Your Offer / Their Offer), each a Grid or List of item slots, with a Confirm/Cancel button row anchored along the bottom using the Anti-Overlap pattern.
12. COLLECTION — Grid or Grid+Details layout of collected/uncollected entries (locked entries shown desaturated/using the muted color), selected entry shows lore/stats in a details pane.
13. PROFILE — Single Panel or Tabbed Panel: avatar/banner area at the top (~25-35% height), stats/info rows or tabs (Stats, Achievements, Friends) below.
14. BATTLE PASS — Grid or List layout representing a reward track (sequence of tier cards/nodes with level number, reward icon, and a claimed/locked/current state shown via UIStroke + rarity accent color), plus a progress bar across the top showing XP toward the next tier.
15. LOADING SCREEN — Single Panel, full-screen background (Size "{1, 0, 1, 0}", ZIndex 0, imagePrompt describing the scene), centered logo/title text, and a progress bar near the bottom (~0.08-0.1 height) showing load percentage.
16. DAILY REWARDS / LOGIN STREAK — List or Single Panel layout: a horizontal or vertical track of day-tiles (claimed/current/locked states shown via rarity accent UIStroke — locked tiles desaturated/muted), a prominent "Claim" button using the primary accent, and a streak-count title at the top.
17. MAIL / INBOX — List layout of message rows (sender icon on the left, subject + timestamp using edge-anchoring so the timestamp never collides with the subject text), unread rows marked with a small primary-accent dot; selecting a row can open a Grid+Details-style pane showing the full message body and a claim-attachment button.
18. PAUSE MENU — Single Panel layout, centered, a vertical UIListLayout stack of full-width menu buttons (Resume, Settings, Inventory, Quit) with consistent height and 0.1-0.14 Scale spacing; Resume uses the primary accent, Quit uses the secondary accent.
19. CODEX / LORE BOOK — Sidebar+Content or Grid+Details layout: sidebar/grid lists discovered entries (creatures, locations, lore pages) with undiscovered entries shown desaturated using the muted color; the content/details pane shows an illustration plus lore text for the selected entry.
20. VOTE / POLL — Single Panel layout, centered, with a question title and 2-5 horizontal option rows (each a button showing the option text plus a live vote-percentage fill bar using the primary accent), and a Confirm button anchored along the bottom edge using the Anti-Overlap pattern.

=== ANTI-OVERLAP RULE FOR SIDE-BY-SIDE OR STACKED ELEMENTS (MANDATORY, ZERO TOLERANCE) ===
A price label hidden behind a "BUY" button, or any two elements covering each other, is a CRITICAL FAILURE you must never produce. Prevent this with explicit width/height budgeting:
- Two elements sharing a row (e.g. Price label + Buy button) MUST have their Scale widths sum to ≤ 0.95, leaving a visible gap between them. Anchor one to the LEFT edge and the other to the RIGHT edge so they can NEVER collide regardless of text length:
  - Left element: AnchorPoint "{0, 0.5}", Position "{0.04, 0, Y, 0}", Size "{0.56, 0, H, 0}"
  - Right element: AnchorPoint "{1, 0.5}", Position "{0.96, 0, Y, 0}", Size "{0.34, 0, H, 0}"
- Elements stacked vertically (e.g. Name then Price) MUST have their Y positions spaced at least 0.12-0.18 Scale apart. NEVER give two siblings inside the same container the same Y position.
- NEVER place a button at the exact same Position as a label it is meant to sit beside — always carve out separate, non-overlapping space for each element before placing it.

=== SHOP / INVENTORY / LEADERBOARD GRID-OF-CARDS RECIPE (MANDATORY FOR ANY REPEATING LIST OF ITEMS) ===
When asked for a shop, inventory, leaderboard, or any repeating list of cards, build it EXACTLY like this:

CONCISE CALCULATIONS (compute these explicitly every time — never eyeball or reuse a previous screen's numbers):
- Pick desiredColumns (2 or 3 for most shops/inventories). Pick gapScale (CellPadding.XScale/YScale), typically 0.02-0.03.
  CellSize.XScale = round( (1 - (desiredColumns + 1) * gapScale) / desiredColumns , 2 )
  Example: desiredColumns=3, gapScale=0.02 → (1 - 4*0.02) / 3 = 0.307 → use 0.30.
- rows = ceil(itemCount / desiredColumns).
  Example: itemCount=3, desiredColumns=3 → rows=1. itemCount=5, desiredColumns=3 → rows=2.
- bodyHeightScale = rows * (CellSize.YScale + CellPadding.YScale) + CellPadding.YScale (one extra gap for top margin).
  Example: rows=1, CellSize.YScale=0.42, CellPadding.YScale=0.03 → bodyHeightScale ≈ 0.48.
- MainPanel Size.Y.Scale = HeaderHeightScale + bodyHeightScale (recomputed for THIS itemCount) + FooterHeightScale.
  Never reuse a fixed/previous panel height — a 3-item single-row shop and a 12-item 4-row shop must end up with visibly different MainPanel heights.
a. Create a ScrollingFrame (e.g. "ItemsContainer") sized to fill most of the body — e.g. Size "{0.94, 0, 0.8, 0}", AnchorPoint "{0.5, 0.5}", Position "{0.5, 0, 0.5, 0}". Set "AutomaticCanvasSize": "Y" and leave "CanvasSize": "{0, 0, 0, 0}" so it grows/shrinks to fit content instead of leaving dead space.
b. Add a "create_gui" action with className "UIGridLayout" parented INSIDE that ScrollingFrame, with:
   - "CellSize": "{0.30, 0, 0.42, 0}" (Scale-only — pick XScale ≈ (1 / desiredColumns) - 0.04 so columns fill the width evenly, e.g. 0.30 for 3 columns, 0.46 for 2 columns)
   - "CellPadding": "{0.02, 0, 0.03, 0}" (Scale-only gap between cards)
   - "HorizontalAlignment": "Center", "VerticalAlignment": "Top", "SortOrder": "LayoutOrder"
c. DO NOT set "Size" or "Position" on the individual card Frames themselves — once their parent has a UIGridLayout, the layout automatically controls every card's size and position. Manually setting it will conflict with the layout and cause overlap/misplacement glitches.
d. Inside EACH card (applying the Anti-Overlap rule above), build top to bottom:
   - Icon/image holder occupying the TOP ~55-60% of the card: AnchorPoint "{0.5, 0}", Position "{0.5, 0, 0.05, 0}", Size "{0.72, 0, 0.55, 0}". BackgroundColor3 MUST be the Inset/well surface color (never the same as the card's own background), and its UIStroke color should use that item's rarity accent if a rarity/category set is in play.
   - Name TextLabel directly below it: AnchorPoint "{0.5, 0}", Position "{0.5, 0, 0.63, 0}", Size "{0.92, 0, 0.13, 0}".
   - A Price label + Buy button row near the bottom using the edge-anchoring pattern from the Anti-Overlap rule, positioned around Y "{*, 0, 0.84, 0}". The price TextLabel's TextColor3 MUST be the gold currency accent, never the muted secondary text color — and the Buy button uses the primary accent so it's clearly the one button on the card you want tapped.
e. Never leave a large empty area under a short list. Recompute the panel height using the CONCISE CALCULATIONS formulas above for the actual itemCount/rows — a 3-item, 1-row shop should size its MainPanel to roughly HeaderHeightScale + ~0.48-0.55 Scale of body + FooterHeightScale, NOT a tall fixed value reused from another screen. If the ScrollingFrame's content (via AutomaticCanvasSize) ends up shorter than the MainPanel, shrink the MainPanel's Size.Y.Scale to match it. A panel with more than ~15% unused vertical space below the last row of cards is a FAILURE and must be resized before the JSON is returned.

5. String formats for Size/Position MUST be EXACTLY like "{0.4, 0, 0.5, 0}" (Scale, 0, Scale, 0) — DO NOT output "UDim2.new(...)" and NEVER use a non-zero Offset value.
6. String formats for Color3 MUST be EXACTLY like "#FFFFFF" or "255, 255, 255". DO NOT output "Color3.fromRGB(...)". For a UIGradient's "Color" property (a ColorSequence, NOT a single Color3), supply an ARRAY of at least two DIFFERENT hex strings spaced across the gradient, e.g. "Color": ["#3D2A52", "#1B1426"] for a two-stop gradient or "Color": ["#3D2A52", "#9B6BFF", "#1B1426"] for a three-stop gradient — ALWAYS use the chosen palette's gradientTop/gradientBottom (or gradientTop/primary-accent/gradientBottom for a three-stop) values for this. NEVER output a single repeated hex value, NEVER output "#FFFFFF"/"#000000" as a gradient's only stops unless that is literally the palette's defined gradient pair, and NEVER leave the "Color" property off a UIGradient action.
7. String formats for AnchorPoint MUST be EXACTLY like "{0.5, 0.5}".
8. String formats for CornerRadius MUST be EXACTLY like "{0.15, 0}" (Scale preferred). String formats for Padding MAY be EXACTLY like "{0, 8}" (Offset is acceptable ONLY for Padding/CornerRadius/Stroke, never for Size/Position). "CellSize" and "CellPadding" on a UIGridLayout MUST ALSO use the Scale-only "{X, 0, Y, 0}" format, exactly like Size/Position — never a pixel/Offset value.
9. If no actions are needed, leave the "actions" array empty.
10. IMAGE GENERATION — Auto-generate images for visual GUI elements: whenever you emit a "create_gui" action whose className is "ImageLabel" or "ImageButton", add an "imagePrompt" string field inside its "properties" object. The system will automatically call the image generation API, store the result, and replace imagePrompt with the real Image URL before it reaches the plugin. Keep prompts concise, descriptive English. Examples:
    - Pet/item icon:     "imagePrompt": "cute cartoon lion creature holding a sunflower, Roblox pet icon style, vibrant colors, white background"
    - Shop background:   "imagePrompt": "colorful cartoon sky with clouds and rainbow, Roblox game background, bright and cheerful"
    - Quest reward icon: "imagePrompt": "golden glowing egg, game reward icon style, shiny, fantasy, transparent background"
    - Coin icon:         "imagePrompt": "shiny gold coin with star emblem, cartoon game icon, transparent background"
    - Character avatar:  "imagePrompt": "chibi Roblox character avatar, warrior outfit, blue theme, transparent background"
    For shop UIs (like Image 1), always create item ImageLabels with imagePrompt for each product slot. For quest UIs (like Image 2), add imagePrompt to reward ImageLabels. For background art, create a full-size ImageLabel (Size "{1, 0, 1, 0}", Position "{0, 0, 0, 0}", ZIndex 0) behind all other elements and give it an imagePrompt describing the scene.
    Do NOT add imagePrompt to Frame, TextLabel, TextButton, ScrollingFrame, UIGridLayout, UIListLayout, UICorner, UIStroke, UIGradient, UIPadding, or any non-image element.

11. RESPONSE FORMATTING: If you execute actions to create objects, you MUST include a markdown table in your "message" field detailing what was created. The table should have columns for 'Name', 'Type', and 'Location'.
12. PRE-SUBMIT VISUAL QA CHECKLIST — run this silently against your own JSON before returning it, and fix any failure (never explain this check to the user, just fix the JSON):
    (a) Does every primary panel/card/button have a UICorner AND a UIStroke, and (where the design system calls for it) a UIGradient with two genuinely different palette hex stops?
    (b) Is every hex color used literally one of the resolved palette's defined values — no invented, lightened, darkened, or generic colors?
    (c) Does the primary accent appear ONLY on the one action you want tapped (Buy/Confirm/Equip/active tab), with close/cancel/back actions using the secondary accent instead?
    (d) Is the MainPanel sized to its actual content using the CONCISE CALCULATIONS formulas, with no large empty area below the last row?
    (e) Does at least one element use a rotated decorative accent per the ROTATION & SIGNATURE ACCENTS rule?
    If any answer is "no", fix the JSON before returning it.${userSourcesText}`;

  let userContent = prompt;
  if (image) {
    let finalImageUrl = image;
    if (image.includes('/api/roblox/image/')) {
      const imageId = image.split('/').pop();
      try {
        const result = await pool.query('SELECT image_data, mime_type FROM generated_images WHERE id = $1', [imageId]);
        if (result.rows[0]) {
          finalImageUrl = `data:${result.rows[0].mime_type};base64,${result.rows[0].image_data}`;
        }
      } catch (err) {
        console.error('Failed to resolve image URL:', err);
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

  try {
    const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        temperature: 0.2, // Low temperature for strict JSON adherence
        stream: false,    // Roblox HttpService cannot handle streams
        messages: fullMessages
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: errText });
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

    let content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content.trim() : "";

    // Strip a fenced ```json ... ``` block wherever it appears (not just at the start —
    // the model sometimes prepends plain text like "Primary: #..., Secondary: #...").
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      content = fenceMatch[1].trim();
    }

    // Narrow down to the outermost JSON object boundaries, in case there's
    // still leading/trailing text outside the fence.
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

    if (jobId && authUser) {
      await pool.query('UPDATE ai_jobs SET status = $1, result = $2 WHERE id = $3', ['completed', JSON.stringify(parsedResponse), jobId]);
    }
    res.json(parsedResponse);

  } catch (err) {
    console.error("[Roblox API Error]:", err);
    const errResult = { error: err.message, message: "Internal Server Error", actions: [] };
    if (jobId && authUser) {
      await pool.query('UPDATE ai_jobs SET status = $1, result = $2 WHERE id = $3', ['error', JSON.stringify(errResult), jobId]);
    }
    res.status(500).json(errResult);
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
