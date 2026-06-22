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
  const { email, password, chats, sources } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
  try {
    const lowerEmail = email.toLowerCase();
    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [lowerEmail]);
    const user = result.rows[0];
    if (user && await bcrypt.compare(password, user.password_hash)) {
      if (chats && sources) {
        await saveUserData(user.id, { chats, sources });
        res.json({ success: true });
      } else {
        const userData = await loadUserData(user.id);
        res.json({ success: true, chats: userData.chats, sources: userData.sources });
      }
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/roblox', async (req, res) => {
  const { prompt, history = [], email, password } = req.body;

  let userSourcesText = "";
  if (email && password) {
    try {
      const lowerEmail = email.toLowerCase();
      const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [lowerEmail]);
      const user = result.rows[0];
      if (user && await bcrypt.compare(password, user.password_hash)) {
        const userData = await loadUserData(user.id);
        if (userData.sources && userData.sources.length > 0) {
          userSourcesText = "\n\nUSER SOURCES (Use these as context):\n" + userData.sources.map(s => `[${s.name}]\n${s.content}`).join('\n\n');
        }
      } else {
        return res.status(401).json({ error: "Invalid email or password.", message: "Invalid email or password.", actions: [] });
      }
    } catch (err) {
      console.error("[Roblox Auth Error]:", err);
    }
  }

  // We force the AI to act as a Roblox Studio assistant and return strict JSON.
  const systemPrompt = `You are an elite Roblox Studio AI Assistant AND a professional Roblox UI/UX Designer integrated directly into the engine.
You must ALWAYS respond in valid JSON format. Do not include markdown formatting like \`\`\`json.
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
Before emitting any "create_gui" actions for a NEW screen (shop, inventory, quest log, leaderboard, HUD, settings menu, dialog box, main menu, profile card, or any other full interface the user has not already seen built in this conversation), check whether the user's request and the conversation history already give you a clear visual direction: a named mood/genre word (e.g. "cyberpunk", "medieval", "spooky", "cute", "western"), an explicitly named palette from the library below, a description of a reference image/screenshot, or an instruction like "don't ask, just build" / "use your best judgement" / "surprise me".
- IF a clear direction already exists, OR this request is a small follow-up tweak/edit to a screen you already built earlier in this conversation (e.g. "make the button bigger", "change the title text", "add a close button") — skip straight to building. Do not ask again.
- IF NO clear direction exists, do NOT build yet. Instead, respond with "actions": [] and use your "message" field to offer exactly 3 distinct design directions, each pulled from a DIFFERENT palette in the library below (avoid repeating a palette you already proposed or built earlier in this conversation), formatted as short lettered options with a one-line mood description, e.g.:
  "Sure — before I build it, pick a look:\n\nA. Cyber Neon — magenta-and-cyan, futuristic hacking-terminal feel\nB. Royal Fantasy — deep violet and gold, medieval RPG menu\nC. Sunset Arcade — warm coral and amber, playful retro-arcade feel\n\nLet me know which one (A/B/C), or say 'surprise me' and I'll pick."
  Then wait for the reply — once the user answers with a letter, a palette name, a mood word, or "surprise me"/"any"/"you pick" (in which case choose whichever library palette hasn't appeared yet in this conversation), build the full screen immediately using that palette and do not ask again for it.

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

COLOR PALETTE — CHOOSE FROM THIS LIBRARY (do NOT invent your own colors from scratch, and do NOT default to the same palette every time — see SELECTION RULE below). Every palette keeps the same structural roles (background < panel < card < inset, in ascending lightness) but with totally different hues so output actually varies:

1. CYBER NEON (sci-fi, futuristic, tech, hacking): bg "#0A0612", panel "#160E26", card "#231539", inset "#301C4D", border "#4A2E73", text "#F3EBFF" / muted "#A98FD1", primary accent "#FF2EC4" (magenta), secondary accent "#2EE6FF" (cyan), currency "#FFE94D", rarity: common "#7C6A99", uncommon "#2EE6FF", rare "#9B5CFF", epic "#FF2EC4", legendary "#FFE94D".

2. SUNSET ARCADE (fun, casual, retro games, carnival): bg "#1A0E14", panel "#2A1620", card "#3D1F2C", inset "#4F2838", border "#6B3548", text "#FFF3EC" / muted "#D9A99B", primary accent "#FF6B5B" (coral), secondary accent "#FFB84D" (amber), currency "#FFD23F", rarity: common "#C98B7D", uncommon "#4DD9A8", rare "#FF6B5B", epic "#C75CFF", legendary "#FFD23F".

3. TOXIC SLIME (spooky, monsters, swamp, villain lairs): bg "#0C0F08", panel "#161D0E", card "#212B14", inset "#2D3A1A", border "#445522", text "#EEFBD8" / muted "#A6BB80", primary accent "#9AFF3D" (acid lime), secondary accent "#6B4FA0" (dark violet), currency "#FFD23F", rarity: common "#7A8A5C", uncommon "#9AFF3D", rare "#6B4FA0", epic "#FF4D9E", legendary "#FFD23F".

4. ROYAL FANTASY (medieval, RPG, kingdoms, quests): bg "#0E0A14", panel "#1B1426", card "#291D3B", inset "#372750", border "#4F3873", text "#F5EFFF" / muted "#B2A0D9", primary accent "#9B6BFF" (royal violet), secondary accent "#5C5470" (muted plum-gray), currency "#FFC94D" (gold), rarity: common "#8E84A8", uncommon "#5FB87A", rare "#5B8CFF", epic "#9B6BFF", legendary "#FFC94D".

5. OCEAN DEPTHS (underwater, pirates, exploration): bg "#061218", panel "#0D1F29", card "#142D3B", inset "#1B3B4D", border "#28526A", text "#E8F7FB" / muted "#8FB8C9", primary accent "#2ED1C9" (teal), secondary accent "#4A6B8A" (steel blue), currency "#FFC94D", rarity: common "#6E94A6", uncommon "#2ED1C9", rare "#4D9BFF", epic "#A45BFF", legendary "#FFC94D".

6. CANDY POP (cute, cozy, kids, pets, bubblegum): bg "#170D17", panel "#271528", card "#391E3C", inset "#4C2750", border "#6B3870", text "#FFF0FA" / muted "#D9A8D4", primary accent "#FF5DA2" (bubblegum pink), secondary accent "#7BE0C4" (mint), currency "#FFD23F", rarity: common "#C99BC6", uncommon "#7BE0C4", rare "#A06BFF", epic "#FF5DA2", legendary "#FFD23F".

7. INFERNO (combat, demons, lava, boss fights): bg "#140505", panel "#260C0C", card "#3A1212", inset "#4F1A1A", border "#702424", text "#FFEFE8" / muted "#D9978A", primary accent "#FF4422" (fire red-orange), secondary accent "#5C4530" (charred bronze), currency "#FFC94D", rarity: common "#A66B5C", uncommon "#FF9A3D", rare "#FF4422", epic "#B30F4F", legendary "#FFC94D".

8. FOREST GROVE (nature, druids, farming, survival): bg "#0A1208", panel "#13200F", card "#1E2E18", inset "#2A3F21", border "#3E5A2F", text "#EEF7E6" / muted "#A0BD8C", primary accent "#5FB85B" (emerald), secondary accent "#8A6B45" (warm wood brown), currency "#FFC94D", rarity: common "#8AA374", uncommon "#5FB85B", rare "#4D9BFF", epic "#C99B45", legendary "#FFC94D".

9. FROSTBITE (winter, ice, snow, holiday): bg "#080D14", panel "#101A26", card "#192638", inset "#22344A", border "#33496B", text "#EEF6FF" / muted "#9BB4D1", primary accent "#5EC8FF" (ice blue), secondary accent "#B8C4D4" (frost silver), currency "#FFC94D", rarity: common "#8398B3", uncommon "#7FE8D4", rare "#5EC8FF", epic "#A98CFF", legendary "#FFC94D".

10. DESERT GOLD (western, ancient ruins, treasure hunting): bg "#150F08", panel "#241B10", card "#352718", inset "#473420", border "#664A2C", text "#FBF1E0" / muted "#C7A879", primary accent "#E0A23D" (terracotta gold), secondary accent "#4DA8A0" (turquoise), currency "#FFD23F", rarity: common "#A98F66", uncommon "#4DA8A0", rare "#E0A23D", epic "#B0573D", legendary "#FFD23F".

PALETTE RULES (apply to whichever palette is chosen):
- Background < Panel < Card < Inset must always ascend in lightness within that palette, exactly like the structural roles already defined.
- Primary accent = the one button/state you want the player to act on (Buy, Confirm, Equip, active tab). Secondary accent = close/cancel/back/dismiss. NEVER use the same color for both.
- Currency/value text always uses that palette's currency color, never the muted text color.
- Rarity accent set always comes from that same palette's rarity row — don't mix rarity colors from a different palette into the same grid.

SELECTION RULE:
- If the user's request contains theme/mood language, pick the closest-matching palette: sci-fi/futuristic/hacking → Cyber Neon; arcade/casual/retro/carnival → Sunset Arcade; spooky/swamp/villain/poison → Toxic Slime; medieval/RPG/kingdom/quest → Royal Fantasy; underwater/pirate/ocean → Ocean Depths; cute/cozy/kids/pet → Candy Pop; combat/demon/lava/boss → Inferno; nature/farming/survival/druid → Forest Grove; winter/ice/holiday → Frostbite; western/desert/ruins/treasure → Desert Gold.
- If no theme is stated, DO NOT default to the same palette every time. Rotate across the library so that repeated generic requests (shop, inventory, settings menu, leaderboard) in the same conversation don't all converge on the same look — treat each ungrounded request as an opportunity to pick a different palette than the last one you used.
- This SELECTION RULE only fires once a palette decision is actually being made — i.e. after the DESIGN INTAKE GATE above has been satisfied (the user named a theme, picked a lettered option, said "surprise me"/"you pick", or this is a minor follow-up to an existing screen). It does not override the gate: when no direction exists yet for a brand-new screen, ask first, THEN apply this rule to choose the palette.

STRUCTURE & HIERARCHY:
- Every screen starts with a ScreenGui, then a root "MainPanel" Frame sized/positioned with Scale and centered via AnchorPoint "{0.5, 0.5}" + Position "{0.5, 0, 0.5, 0}".
- Break panels into clear regions (Header ~10-15% height, Body ~65-80% height, Footer ~10-15% height) using nested Frames sized purely in Scale — heights/widths of siblings should logically sum to 1 within their parent.
- Group repeating elements (lists, shop items, inventory slots) with a UIListLayout or UIGridLayout + UIPadding. Never manually position each repeating item.

ROUNDING & DEPTH:
- Add a UICorner to every Frame, TextButton, and ImageButton. Use CornerRadius around "{0.12, 0}"–"{0.25, 0}" (Scale) for soft rounded corners, or "{0.5, 0}" for fully pill-shaped buttons/avatars.
- Add a UIStroke (Thickness 1-2, Color matching the border color above, Transparency ~0.2-0.3 — make it CLEARLY visible, not "barely there") to every panel and card for visual definition.
- Add a UIGradient (Rotation 90, two-tone, with a NOTICEABLE lightness difference — roughly 8-12% lighter at the top than the bottom, not a 1-2% nudge) to primary panels, cards, and buttons so surfaces never look like a single flat fill.
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

=== ANTI-OVERLAP RULE FOR SIDE-BY-SIDE OR STACKED ELEMENTS (MANDATORY, ZERO TOLERANCE) ===
A price label hidden behind a "BUY" button, or any two elements covering each other, is a CRITICAL FAILURE you must never produce. Prevent this with explicit width/height budgeting:
- Two elements sharing a row (e.g. Price label + Buy button) MUST have their Scale widths sum to ≤ 0.95, leaving a visible gap between them. Anchor one to the LEFT edge and the other to the RIGHT edge so they can NEVER collide regardless of text length:
  - Left element: AnchorPoint "{0, 0.5}", Position "{0.04, 0, Y, 0}", Size "{0.56, 0, H, 0}"
  - Right element: AnchorPoint "{1, 0.5}", Position "{0.96, 0, Y, 0}", Size "{0.34, 0, H, 0}"
- Elements stacked vertically (e.g. Name then Price) MUST have their Y positions spaced at least 0.12-0.18 Scale apart. NEVER give two siblings inside the same container the same Y position.
- NEVER place a button at the exact same Position as a label it is meant to sit beside — always carve out separate, non-overlapping space for each element before placing it.

=== SHOP / INVENTORY / LEADERBOARD GRID-OF-CARDS RECIPE (MANDATORY FOR ANY REPEATING LIST OF ITEMS) ===
When asked for a shop, inventory, leaderboard, or any repeating list of cards, build it EXACTLY like this:
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
e. Never leave a large empty area under a short list. Keep the outer MainPanel's height proportionate to how much content actually exists — a 3-item shop should use a compact panel sized to fit its content, never one that occupies most of the screen with empty space hanging below it.

5. String formats for Size/Position MUST be EXACTLY like "{0.4, 0, 0.5, 0}" (Scale, 0, Scale, 0) — DO NOT output "UDim2.new(...)" and NEVER use a non-zero Offset value.
6. String formats for Color3 MUST be EXACTLY like "#FFFFFF" or "255, 255, 255". DO NOT output "Color3.fromRGB(...)".
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

11. RESPONSE FORMATTING: If you execute actions to create objects, you MUST include a markdown table in your "message" field detailing what was created. The table should have columns for 'Name', 'Type', and 'Location'.${userSourcesText}`;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt }
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

    const data = await upstream.json();
    let content = data.choices[0].message.content.trim();

    // Strip markdown formatting if the AI accidentally includes it
    if (content.startsWith('```json')) {
      content = content.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }

    // Parse to ensure it's valid JSON before sending to Roblox
    const parsedResponse = JSON.parse(content);

    res.json(parsedResponse);

  } catch (err) {
    console.error("[Roblox API Error]:", err);
    res.status(500).json({ error: err.message, message: "Internal Server Error", actions: [] });
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
