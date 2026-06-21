// ---------- Sidebar + Sources: DOM refs ----------
const newChatBtn = document.getElementById('newChatBtn');
const chatSearch = document.getElementById('chatSearch');
const chatHistory = document.getElementById('chatHistory');

const archiveToggleBtn = document.getElementById('archiveToggleBtn');
const chatContextMenu = document.getElementById('chatContextMenu');
const ctxRenameBtn = document.getElementById('ctxRenameBtn');
const ctxArchiveBtn = document.getElementById('ctxArchiveBtn');
const ctxDeleteBtn = document.getElementById('ctxDeleteBtn');

const sourcesSidebarList = document.getElementById('sourcesSidebarList');
const addSourceSidebarBtn = document.getElementById('addSourceSidebarBtn');
const sourcesAddInline = document.getElementById('sourcesAddInline');
const sourceNameInline = document.getElementById('sourceNameInline');
const saveSourceInlineBtn = document.getElementById('saveSourceInlineBtn');

const sourcesPreview = document.getElementById('sourcesPreview');

const sourceEditorModal = document.getElementById('sourceEditorModal');
const sourceEditorTitleInput = document.getElementById('sourceEditorTitleInput');
const sourceEditorContent = document.getElementById('sourceEditorContent');
const closeSourceEditorModal = document.getElementById('closeSourceEditorModal');
const saveSourceEditorBtn = document.getElementById('saveSourceEditorBtn');
const deleteSourceEditorBtn = document.getElementById('deleteSourceEditorBtn');

let currentEditingSourceId = null;
let user = null;
let authInitialized = false;

const authBtn = document.getElementById('authBtn');
const registerBtn = document.getElementById('registerBtn');
const logoutBtn = document.getElementById('logoutBtn');
const authUserName = document.getElementById('authUserName');

// ---------- Chats: state ----------
let chats = JSON.parse(localStorage.getItem('zb_chats') || '[]');
let currentChatId = null;
let viewingArchived = false;
let contextMenuChatId = null;

function saveChats() {
  if (!user) return;
  localStorage.setItem('zb_chats', JSON.stringify(chats));
  scheduleRemoteSync();
}

function getCurrentChat() {
  return chats.find(c => c.id === currentChatId) || null;
}

function persistCurrentChat() {
  const chat = getCurrentChat();
  if (!chat) return;
  chat.messages = history;
  chat.updatedAt = Date.now();
  saveChats();
  renderChatHistory(chatSearch.value);
}

function introHtml() {
  return '';
}

function createNewChat() {
  const chat = {
    id: 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    title: 'New Chat',
    titleGenerated: false,
    archived: false,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  chats.unshift(chat);
  saveChats();
  currentChatId = chat.id;
  history = [];
  pendingImage = null;
  pendingSourceIds = [];
  renderSourcesPreview();
  chatLog.innerHTML = introHtml();
  renderChatHistory(chatSearch.value);
}

function loadChat(id) {
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  currentChatId = id;
  history = chat.messages.slice();
  pendingImage = null;
  pendingSourceIds = [];
  renderSourcesPreview();
  chatLog.innerHTML = introHtml();
  history.forEach(msg => {
    if (typeof msg.content === 'string') {
      addMessage(msg.role, msg.content);
    } else if (Array.isArray(msg.content)) {
      const textPart = msg.content.find(p => p.type === 'text');
      const imagePart = msg.content.find(p => p.type === 'image_url');
      addMessage(msg.role, textPart ? textPart.text : '', imagePart ? imagePart.image_url.url : null);
    }
  });
  renderChatHistory(chatSearch.value);
}

async function generateTitleForChat(chatId, messagesForTitle) {
  try {
    const res = await fetch('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messagesForTitle })
    });
    const data = await res.json();
    const chat = chats.find(c => c.id === chatId);
    if (chat && data.title) {
      chat.title = data.title.slice(0, 60);
      chat.titleGenerated = true;
      saveChats();
      renderChatHistory(chatSearch.value);
    } else if (chat) {
      applyFallbackTitle(chat, messagesForTitle);
    }
  } catch {
    // Don't leave the chat stuck as "New Chat" on a network/API failure.
    const chat = chats.find(c => c.id === chatId);
    if (chat) applyFallbackTitle(chat, messagesForTitle);
  }
}

function applyFallbackTitle(chat, messagesForTitle) {
  if (chat.titleGenerated) return;
  const firstUserMsg = (messagesForTitle || []).find(m => m.role === 'user');
  const raw = extractMessageTextClient(firstUserMsg && firstUserMsg.content);
  if (!raw) return;
  const cleaned = raw
    .replace(/[?!.]+$/g, '')
    .replace(/^(how to|what is|what's|why does|why is|can you|please|how do i|how can i)\s+/i, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6);
  const titleCased = words
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  chat.title = (titleCased || 'New Chat').slice(0, 60);
  chat.titleGenerated = true;
  saveChats();
  renderChatHistory(chatSearch.value);
}

function extractMessageTextClient(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find(p => p.type === 'text');
    return textPart ? textPart.text : '';
  }
  return '';
}

function renderChatHistory(filter) {
  const q = (filter || '').trim().toLowerCase();
  const filtered = chats.filter(c => !!c.archived === viewingArchived && c.title.toLowerCase().includes(q));
  chatHistory.innerHTML = '';
  if (!filtered.length) {
    chatHistory.innerHTML = `<div class="placeholder">${viewingArchived ? 'No archived chats' : 'No chats found'}</div>`;
    return;
  }
  filtered.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-history-item' + (chat.id === currentChatId ? ' active' : '');
    item.textContent = chat.title;
    item.title = chat.title;
    item.addEventListener('click', () => loadChat(chat.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e, chat.id);
    });
    chatHistory.appendChild(item);
  });
}

function openContextMenu(e, chatId) {
  contextMenuChatId = chatId;
  const chat = chats.find(c => c.id === chatId);
  ctxArchiveBtn.textContent = chat && chat.archived ? 'Unarchive Chat' : 'Archive Chat';
  chatContextMenu.hidden = false;
  chatContextMenu.style.left = e.pageX + 'px';
  chatContextMenu.style.top = e.pageY + 'px';
}

function closeContextMenu() {
  chatContextMenu.hidden = true;
  contextMenuChatId = null;
}

document.addEventListener('click', () => closeContextMenu());
document.addEventListener('scroll', () => closeContextMenu(), true);

ctxRenameBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!contextMenuChatId) return;
  const chat = chats.find(c => c.id === contextMenuChatId);
  if (chat) {
    const newTitle = prompt('Enter new chat name:', chat.title);
    if (newTitle !== null && newTitle.trim()) {
      chat.title = newTitle.trim();
      chat.titleGenerated = true;
      saveChats();
      renderChatHistory(chatSearch.value);
    }
  }
  closeContextMenu();
});

ctxArchiveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!contextMenuChatId) return;
  const chat = chats.find(c => c.id === contextMenuChatId);
  if (chat) {
    chat.archived = !chat.archived;
    saveChats();
    renderChatHistory(chatSearch.value);
  }
  closeContextMenu();
});

ctxDeleteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!contextMenuChatId) return;
  const deletingId = contextMenuChatId;
  chats = chats.filter(c => c.id !== deletingId);
  saveChats();
  if (deletingId === currentChatId) {
    const next = chats.find(c => !c.archived) || chats[0];
    if (next) {
      loadChat(next.id);
    } else {
      createNewChat();
    }
  }
  renderChatHistory(chatSearch.value);
  closeContextMenu();
});

archiveToggleBtn.addEventListener('click', () => {
  viewingArchived = !viewingArchived;
  archiveToggleBtn.textContent = viewingArchived ? '💬 Back to Chats' : '📦 Archived';
  archiveToggleBtn.classList.toggle('active', viewingArchived);
  chatSearch.value = '';
  renderChatHistory('');
});

newChatBtn.addEventListener('click', () => {
  if (!user) return alert('Please login to create a chat.');
  createNewChat();
});

chatSearch.addEventListener('input', () => {
  renderChatHistory(chatSearch.value);
});

// ---------- Sources: state ----------
let sources = JSON.parse(localStorage.getItem('zb_sources') || '[]');
let pendingSourceIds = [];

function saveSources() {
  if (!user) return;
  localStorage.setItem('zb_sources', JSON.stringify(sources));
  scheduleRemoteSync();
}

function setAuthState(userData) {
  user = userData;
  authUserName.textContent = user ? user.displayName || user.email : 'Guest';
  authBtn.hidden = !!user;
  registerBtn.hidden = !!user;
  logoutBtn.hidden = !user;

  const isLoggedIn = !!user;
  newChatBtn.disabled = !isLoggedIn;
  addSourceSidebarBtn.disabled = !isLoggedIn;
  chatInput.disabled = !isLoggedIn;
  chatInput.placeholder = isLoggedIn ? "Message the model..." : "Please login to chat...";
  sendBtn.disabled = !isLoggedIn;

  if (!isLoggedIn) {
    chats = [];
    sources = [];
    currentChatId = null;
    history = [];
    chatLog.innerHTML = '<div class="placeholder">Please login to view or create chats.</div>';
    renderChatHistory('');
    renderSourcesSidebarList();
  }
}

function loadLocalData() {
  chats = [];
  sources = [];
  localStorage.removeItem('zb_chats');
  localStorage.removeItem('zb_sources');
}

async function loadRemoteData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('Failed to load remote data');
    const data = await res.json();
    chats = Array.isArray(data.chats) ? data.chats : [];
    sources = Array.isArray(data.sources) ? data.sources : [];
    localStorage.setItem('zb_chats', JSON.stringify(chats));
    localStorage.setItem('zb_sources', JSON.stringify(sources));
  } catch (err) {
    console.warn('[auth] remote load failed:', err.message);
    loadLocalData();
  }
}

let remoteSyncTimer = null;

function scheduleRemoteSync() {
  if (!user) return;
  if (remoteSyncTimer) clearTimeout(remoteSyncTimer);
  remoteSyncTimer = setTimeout(syncRemoteData, 500);
}

async function syncRemoteData() {
  if (!user) return;
  try {
    await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chats, sources })
    });
    remoteSyncTimer = null;
  } catch (err) {
    console.warn('[auth] sync failed:', err.message);
  }
}

window.addEventListener('beforeunload', () => {
  if (user && remoteSyncTimer) {
    const blob = new Blob([JSON.stringify({ chats, sources })], { type: 'application/json' });
    navigator.sendBeacon('/api/data', blob);
  }
});

async function fetchAuthStatus() {
  try {
    const res = await fetch('/api/user');
    const data = await res.json();
    if (data.authenticated) {
      setAuthState(data.user);
      await loadRemoteData();
    } else {
      setAuthState(null);
      loadLocalData();
    }
  } catch (err) {
    console.warn('[auth] status check failed:', err.message);
    setAuthState(null);
    loadLocalData();
  } finally {
    authInitialized = true;
  }
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch (err) {
    console.warn('[auth] logout failed:', err.message);
  }
  setAuthState(null);
  loadLocalData();
  initializeApp();
}

const authPage = document.getElementById('authPage');
const loginBox = document.getElementById('loginBox');
const registerBox = document.getElementById('registerBox');

document.getElementById('showRegister').addEventListener('click', (e) => { e.preventDefault(); loginBox.hidden = true; registerBox.hidden = false; });
document.getElementById('showLogin').addEventListener('click', (e) => { e.preventDefault(); registerBox.hidden = true; loginBox.hidden = false; });
document.querySelectorAll('.close-auth').forEach(btn => btn.addEventListener('click', () => authPage.hidden = true));

authBtn.addEventListener('click', () => { authPage.hidden = false; loginBox.hidden = false; registerBox.hidden = true; });
authBtn.type = 'button';
registerBtn.addEventListener('click', () => { authPage.hidden = false; loginBox.hidden = true; registerBox.hidden = false; });
registerBtn.type = 'button';

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('registerEmail').value.trim();
  const displayName = document.getElementById('registerName').value.trim();
  const password = document.getElementById('registerPassword').value.trim();
  try {
    const res = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Registration failed');
      return;
    }
    setAuthState(data.user);
    await loadRemoteData();
    initializeApp();
    authPage.hidden = true;
  } catch (err) {
    alert('Authentication failed');
  }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Login failed');
      return;
    }
    setAuthState(data.user);
    await loadRemoteData();
    initializeApp();
    authPage.hidden = true;
  } catch (err) {
    alert('Authentication failed');
  }
});
logoutBtn.addEventListener('click', logout);
logoutBtn.type = 'button';

function renderSourcesSidebarList() {
  if (!sources.length) {
    sourcesSidebarList.innerHTML = '<div class="placeholder">No sources yet</div>';
    return;
  }
  sourcesSidebarList.innerHTML = '';
  sources.forEach(src => {
    const row = document.createElement('div');
    row.className = 'source-sidebar-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'source-sidebar-checkbox';
    checkbox.checked = pendingSourceIds.includes(src.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!pendingSourceIds.includes(src.id)) pendingSourceIds.push(src.id);
      } else {
        pendingSourceIds = pendingSourceIds.filter(id => id !== src.id);
      }
      renderSourcesPreview();
    });

    const name = document.createElement('span');
    name.className = 'source-sidebar-name';
    name.textContent = src.name;
    name.addEventListener('click', () => openSourceEditor(src.id));

    row.appendChild(checkbox);
    row.appendChild(name);
    sourcesSidebarList.appendChild(row);
  });
}

function openSourceEditor(id) {
  const src = sources.find(s => s.id === id);
  if (!src) return;
  currentEditingSourceId = id;
  sourceEditorTitleInput.value = src.name;
  sourceEditorContent.value = src.content;
  sourceEditorModal.hidden = false;
}

function closeSourceEditor() {
  sourceEditorModal.hidden = true;
  currentEditingSourceId = null;
}

function renderSourcesPreview() {
  if (!pendingSourceIds.length) {
    sourcesPreview.hidden = true;
    sourcesPreview.innerHTML = '';
    return;
  }
  sourcesPreview.hidden = false;
  sourcesPreview.innerHTML = '';
  pendingSourceIds.forEach(id => {
    const src = sources.find(s => s.id === id);
    if (!src) return;
    const chip = document.createElement('span');
    chip.className = 'source-chip';
    chip.textContent = src.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'source-chip-remove';
    remove.textContent = '×';
    remove.onclick = () => {
      pendingSourceIds = pendingSourceIds.filter(sid => sid !== id);
      renderSourcesPreview();
      renderSourcesSidebarList();
    };
    chip.appendChild(remove);
    sourcesPreview.appendChild(chip);
  });
}

function getSelectedSourcesText() {
  if (!pendingSourceIds.length) return '';
  const selected = sources.filter(s => pendingSourceIds.includes(s.id));
  if (!selected.length) return '';
  return selected.map(s => `[SOURCE: ${s.name}]\n${s.content}`).join('\n\n---\n\n');
}

addSourceSidebarBtn.addEventListener('click', () => {
  if (!user) return alert('Please login to add sources.');
  sourcesAddInline.hidden = !sourcesAddInline.hidden;
  if (!sourcesAddInline.hidden) sourceNameInline.focus();
});

saveSourceInlineBtn.addEventListener('click', () => {
  const name = sourceNameInline.value.trim();
  if (!name) {
    sourceNameInline.focus();
    return;
  }
  const newSource = {
    id: 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name,
    content: '',
    createdAt: Date.now()
  };
  sources.push(newSource);
  saveSources();
  sourceNameInline.value = '';
  sourcesAddInline.hidden = true;
  renderSourcesSidebarList();
  openSourceEditor(newSource.id);
});

sourceNameInline.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveSourceInlineBtn.click();
  }
});

closeSourceEditorModal.addEventListener('click', () => {
  closeSourceEditor();
});

saveSourceEditorBtn.addEventListener('click', () => {
  if (!currentEditingSourceId) return;
  const src = sources.find(s => s.id === currentEditingSourceId);
  if (src) {
    src.name = sourceEditorTitleInput.value.trim() || src.name;
    src.content = sourceEditorContent.value;
    saveSources();
    renderSourcesSidebarList();
    renderSourcesPreview();
  }
  closeSourceEditor();
});

deleteSourceEditorBtn.addEventListener('click', () => {
  if (!currentEditingSourceId) return;
  sources = sources.filter(s => s.id !== currentEditingSourceId);
  pendingSourceIds = pendingSourceIds.filter(id => id !== currentEditingSourceId);
  saveSources();
  renderSourcesSidebarList();
  renderSourcesPreview();
  closeSourceEditor();
});

// ---------- Tabs ----------
const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`view-${tab.dataset.tab}`).classList.add('active');
  });
});

// ---------- Status indicator ----------
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

function setStatus(state, label) {
  statusDot.classList.remove('busy', 'ok', 'error');
  if (state) statusDot.classList.add(state);
  statusText.textContent = label;
}

// ---------- Chat ----------
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachPreview = document.getElementById('attachPreview');
const chatModel = document.getElementById('chatModel');

let history = [];     // { role, content } sent to the API
let pendingImage = null; // { dataUrl, mime }

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { dataUrl: reader.result };
    attachPreview.hidden = false;
    attachPreview.innerHTML = '';
    const img = document.createElement('img');
    img.src = reader.result;
    const remove = document.createElement('button');
    remove.className = 'remove-attach';
    remove.textContent = 'remove';
    remove.type = 'button';
    remove.onclick = () => {
      pendingImage = null;
      attachPreview.hidden = true;
      fileInput.value = '';
    };
    attachPreview.appendChild(img);
    attachPreview.appendChild(remove);
  };
  reader.readAsDataURL(file);
});

function addMessage(role, text, imageDataUrl) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = role;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'msg-body';
  bodyEl.textContent = text || '';
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'attached';
    img.src = imageDataUrl;
    bodyEl.appendChild(img);
  }
  wrap.appendChild(roleEl);
  wrap.appendChild(bodyEl);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bodyEl;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text && !pendingImage && !pendingSourceIds.length) return;

  // Build the message we display + send
  const sourcesText = getSelectedSourcesText();
  const effectiveText = sourcesText
    ? `Use the following sources as context if relevant:\n\n${sourcesText}\n\n---\n\nUser message: ${text || 'Please review the attached sources.'}`
    : text;

  let contentForApi;
  if (pendingImage) {
    contentForApi = [
      { type: 'text', text: effectiveText || 'What is in this image?' },
      { type: 'image_url', image_url: { url: pendingImage.dataUrl } }
    ];
  } else {
    contentForApi = effectiveText;
  }

  const sourcesUsedLabel = sourcesText
    ? ` (used ${pendingSourceIds.length} source${pendingSourceIds.length > 1 ? 's' : ''})`
    : '';
  addMessage('user', (text || (sourcesText ? 'Please review the attached sources.' : '')) + sourcesUsedLabel, pendingImage ? pendingImage.dataUrl : null);
  history.push({ role: 'user', content: contentForApi });

  // Auto-rename the chat as soon as we have the first user message,
  // instead of waiting on the assistant's reply (which can fail/be slow).
  {
    const chatForTitle = getCurrentChat();
    if (chatForTitle && !chatForTitle.titleGenerated && history.length === 1) {
      persistCurrentChat();
      generateTitleForChat(chatForTitle.id, history.slice(0, 4));
    }
  }

  chatInput.value = '';
  pendingImage = null;
  pendingSourceIds = [];
  renderSourcesPreview();
  attachPreview.hidden = true;
  attachPreview.innerHTML = '';
  fileInput.value = '';
  sendBtn.disabled = true;
  setStatus('busy', 'streaming');

  const assistantBody = addMessage('assistant', '');
  assistantBody.innerHTML = '<span class="cursor"></span>';

  let fullText = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        system: 'You are a helpful assistant.',
        temperature: 0.7,
        model: chatModel.value
      })
    });

    if (!res.ok || !res.body) {
      const errText = await res.text();
      assistantBody.textContent = `[error] ${errText}`;
      setStatus('error', 'error');
      sendBtn.disabled = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete trailing line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && delta.content) {
            fullText += delta.content;
            assistantBody.innerHTML = '';
            assistantBody.appendChild(document.createTextNode(fullText));
            const cursor = document.createElement('span');
            cursor.className = 'cursor';
            assistantBody.appendChild(cursor);
            chatLog.scrollTop = chatLog.scrollHeight;
          }
          if (json.usage) {
            const note = document.createElement('div');
            note.className = 'token-note';
            note.textContent = `tokens used: ${json.usage.total_tokens}`;
            assistantBody.parentElement.appendChild(note);
          }
        } catch {
          // ignore malformed chunk
        }
      }
    }

    assistantBody.textContent = fullText;
    history.push({ role: 'assistant', content: fullText });
    setStatus('ok', 'idle');

    persistCurrentChat();
    const activeChat = getCurrentChat();
    if (activeChat && !activeChat.titleGenerated && history.length >= 2) {
      generateTitleForChat(activeChat.id, history.slice(0, 4));
    }
  } catch (err) {
    assistantBody.textContent = `[error] ${err.message}`;
    setStatus('error', 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

// ---------- Generate ----------
const genPrompt = document.getElementById('genPrompt');
const genSize = document.getElementById('genSize');
const genBtn = document.getElementById('genBtn');
const genResult = document.getElementById('genResult');
const genUsage = document.getElementById('genUsage');

genBtn.addEventListener('click', async () => {
  const prompt = genPrompt.value.trim();
  if (!prompt) return;
  genBtn.disabled = true;
  genResult.classList.add('loading');
  genResult.innerHTML = '<div class="placeholder">Generating...</div>';
  genUsage.textContent = '';
  genUsage.classList.remove('error');
  setStatus('busy', 'generating');

  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, size: genSize.value })
    });
    const data = await res.json();

    if (!res.ok || !data.data || !data.data[0]) {
      throw new Error(data.error ? JSON.stringify(data.error) : 'Unknown error');
    }

    const b64 = data.data[0].b64_json;
    genResult.innerHTML = '';
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${b64}`;
    genResult.appendChild(img);

    if (data.usage) {
      genUsage.textContent = `tokens used: ${data.usage.total_tokens}`;
    }
    setStatus('ok', 'idle');
  } catch (err) {
    genResult.innerHTML = '<div class="placeholder">Generation failed</div>';
    genUsage.textContent = err.message;
    genUsage.classList.add('error');
    setStatus('error', 'error');
  } finally {
    genBtn.disabled = false;
    genResult.classList.remove('loading');
  }
});

// ---------- Edit ----------
const editFiles = document.getElementById('editFiles');
const editThumbs = document.getElementById('editThumbs');
const editPrompt = document.getElementById('editPrompt');
const editSize = document.getElementById('editSize');
const editBtn = document.getElementById('editBtn');
const editResult = document.getElementById('editResult');
const editUsage = document.getElementById('editUsage');

editFiles.addEventListener('change', () => {
  editThumbs.innerHTML = '';
  [...editFiles.files].slice(0, 4).forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = document.createElement('img');
      img.src = reader.result;
      editThumbs.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
});

editBtn.addEventListener('click', async () => {
  const files = editFiles.files;
  const prompt = editPrompt.value.trim();
  if (!files.length || !prompt) return;

  editBtn.disabled = true;
  editResult.classList.add('loading');
  editResult.innerHTML = '<div class="placeholder">Editing...</div>';
  editUsage.textContent = '';
  editUsage.classList.remove('error');
  setStatus('busy', 'editing');

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('size', editSize.value);
  [...files].slice(0, 4).forEach(f => form.append('images', f));

  try {
    const res = await fetch('/api/edit-image', { method: 'POST', body: form });
    const data = await res.json();

    if (!res.ok || !data.data || !data.data[0]) {
      throw new Error(data.error ? JSON.stringify(data.error) : 'Unknown error');
    }

    const b64 = data.data[0].b64_json;
    editResult.innerHTML = '';
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${b64}`;
    editResult.appendChild(img);

    if (data.usage) {
      editUsage.textContent = `tokens used: ${data.usage.total_tokens}`;
    }
    setStatus('ok', 'idle');
  } catch (err) {
    editResult.innerHTML = '<div class="placeholder">Edit failed</div>';
    editUsage.textContent = err.message;
    editUsage.classList.add('error');
    setStatus('error', 'error');
  } finally {
    editBtn.disabled = false;
    editResult.classList.remove('loading');
  }
});

// ---------- Sources sidebar: initial render ----------
function initializeApp() {
  renderSourcesSidebarList();
  if (user) {
    if (chats.length) {
      loadChat(chats[0].id);
    } else {
      createNewChat();
    }
  } else {
    chatLog.innerHTML = '<div class="placeholder">Please login to view or create chats.</div>';
  }
  renderChatHistory('');
}

fetchAuthStatus().then(() => {
  initializeApp();
});
