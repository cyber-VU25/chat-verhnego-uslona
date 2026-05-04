const $ = (id) => document.getElementById(id);

let socket = null;
let me = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function renderMessage(m) {
  const el = document.createElement('div');
  const isMe = me && m.phone === me.phone;
  el.className = `msg ${isMe ? 'me' : ''} ${m.system ? 'system' : ''}`;
  el.dataset.messageId = m.id;
  const author = m.system ? 'Система' : (m.name || m.phone || 'Участник');
  el.innerHTML = `
    <div class="meta"><strong></strong><span>${formatTime(m.created_at)}</span></div>
    <div class="text"></div>
  `;
  el.querySelector('strong').textContent = author;
  el.querySelector('.text').textContent = m.text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

async function showChat(user) {
  me = user;
  $('auth').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('hello').textContent = `${user.name || 'Участник'} • ${user.phone}`;

  const data = await api('/api/messages');
  $('messages').innerHTML = '';
  data.messages.forEach(renderMessage);

  socket = io({ withCredentials: true });
  socket.on('message', renderMessage);
  socket.on('messageDeleted', ({ id }) => {
  const el = document.querySelector(`[data-message-id="${id}"]`);
  if (el) el.remove();
});
  socket.on('auth-error', () => location.reload());
}

async function boot() {
  try {
    const config = await api('/api/config');
    $('siteName').textContent = config.siteName;
    document.title = config.siteName;
  } catch {}

  try {
    const { user } = await api('/api/me');
    if (user) await showChat(user);
  } catch {}
}

$('sendCode').addEventListener('click', async () => {
  $('authMsg').textContent = '';
  $('sendCode').disabled = true;
  try {
    const phone = $('phone').value;
    const data = await api('/api/request-code', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    $('codeBox').classList.remove('hidden');
    $('authMsg').textContent = data.message || 'Код отправлен.';
  } catch (e) {
    $('authMsg').textContent = e.message;
  } finally {
    $('sendCode').disabled = false;
  }
});

$('verifyCode').addEventListener('click', async () => {
  $('authMsg').textContent = '';
  $('verifyCode').disabled = true;
  try {
    const data = await api('/api/verify-code', {
      method: 'POST',
      body: JSON.stringify({
        name: $('name').value,
        phone: $('phone').value,
        code: $('code').value
      })
    });
    await showChat(data.user);
  } catch (e) {
    $('authMsg').textContent = e.message;
  } finally {
    $('verifyCode').disabled = false;
  }
});

$('messageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('messageInput').value.trim();
  if (!text || !socket) return;
  socket.emit('message', text);
  $('messageInput').value = '';
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

boot();
