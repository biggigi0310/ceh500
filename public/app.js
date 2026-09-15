const $ = (id) => document.getElementById(id);
let state = { settings: {}, rules: [], env: {} };
let editingId = null;

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    // 401 通常代表 session 過期,回登入畫面;但「登入」本身失敗時要讓使用者
    // 看到真正的原因(密碼錯誤、或伺服器還沒設好),不能一律蓋成「尚未登入」。
    if (response.status === 401 && pathname !== '/api/login') showLogin();
    throw new Error(data?.error ?? `請求失敗(${response.status})`);
  }
  return data;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
}

async function boot() {
  try {
    await refreshState();
    $('login').hidden = true;
    $('app').hidden = false;
  } catch {
    showLogin();
  }
}

async function refreshState() {
  state = await api('/api/state');
  $('master-switch').checked = state.settings.enabled;
  $('opt-public-reply').checked = state.settings.publicReplyEnabled;
  $('opt-skip-nested').checked = state.settings.skipNestedComments;
  $('opt-skip-own').checked = state.settings.skipOwnComments;
  $('dry-run-badge').hidden = !state.env.dryRun;
  renderRules();
}

function renderRules() {
  const container = $('rules-list');
  if (!state.rules.length) {
    container.innerHTML = '<div class="item"><p class="muted">還沒有任何設定。點上面「新增一則貼文設定」,貼上貼文 ID 和物件連結就可以開始了。</p></div>';
    return;
  }
  container.innerHTML = state.rules.map((rule) => `
    <div class="item">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(rule.name || '(未命名)')}
            <span class="badge ${rule.enabled ? 'ok' : 'err'}">${rule.enabled ? '啟用中' : '已停用'}</span>
          </div>
          <div class="meta">貼文 ID:${escapeHtml(rule.postId === '*' ? '* (所有貼文)' : rule.postId)}</div>
          ${rule.link ? `<div class="meta">連結:${escapeHtml(rule.link)}</div>` : ''}
          <div class="meta">觸發:${rule.keywordMode === 'any' ? `留言含「${escapeHtml(rule.keywords.join('、'))}」` : '所有留言'}</div>
        </div>
        <div class="item-actions">
          <button class="link" data-edit="${rule.id}">編輯</button>
          <button class="link danger" data-delete="${rule.id}">刪除</button>
        </div>
      </div>
      <pre>${escapeHtml(rule.dmTemplate)}</pre>
    </div>
  `).join('');
}

async function loadLogs() {
  const [logs, fresh] = await Promise.all([api('/api/logs?limit=100'), api('/api/state')]);
  $('stats').textContent = `已私訊 ${fresh.stats.sent} 筆 / 失敗 ${fresh.stats.failed} 筆`;
  const container = $('logs-list');
  if (!logs.length) {
    container.innerHTML = '<div class="item"><p class="muted">還沒有任何紀錄。</p></div>';
    return;
  }
  container.innerHTML = logs.map((log) => `
    <div class="item">
      <div class="item-head">
        <div class="item-title">
          ${escapeHtml(log.author || '(匿名)')}
          <span class="badge ${log.status === 'sent' ? 'ok' : 'err'}">${log.status === 'sent' ? '已私訊' : '失敗'}</span>
        </div>
        <div class="meta">${new Date(log.at).toLocaleString('zh-TW')}</div>
      </div>
      <div class="meta">留言:${escapeHtml(log.comment || '(無文字)')}</div>
      ${log.error ? `<div class="error">${escapeHtml(log.error)}</div>` : ''}
      ${log.publicReplyError ? `<div class="error">公開回覆失敗:${escapeHtml(log.publicReplyError)}</div>` : ''}
      <div class="meta">留言 ID:${escapeHtml(log.commentId)}</div>
    </div>
  `).join('');
}

function openRuleDialog(rule) {
  editingId = rule?.id ?? null;
  $('rule-dialog-title').textContent = rule ? '編輯貼文設定' : '新增貼文設定';
  $('f-name').value = rule?.name ?? '';
  $('f-postId').value = rule?.postId ?? '';
  $('f-link').value = rule?.link ?? '';
  $('f-dm').value = rule?.dmTemplate ?? '{{name}} 您好,謝謝您的留言 🙏\n這是您詢問的物件資料:\n{{link}}\n\n有任何問題都可以直接在這裡問我,我會盡快回覆您!';
  $('f-public').value = rule?.publicReplyTemplate ?? '{{name}} 您好,已私訊物件連結給您囉,麻煩查收訊息 📩';
  $('f-keywordMode').value = rule?.keywordMode ?? 'all_comments';
  $('f-keywords').value = (rule?.keywords ?? []).join(',');
  $('f-enabled').checked = rule ? rule.enabled : true;
  $('rule-error').hidden = true;
  $('preview').hidden = true;
  toggleKeywords();
  $('rule-dialog').showModal();
}

function toggleKeywords() {
  $('keywords-field').hidden = $('f-keywordMode').value !== 'any';
}

function formToRule() {
  return {
    name: $('f-name').value.trim(),
    postId: $('f-postId').value.trim(),
    link: $('f-link').value.trim(),
    dmTemplate: $('f-dm').value,
    publicReplyTemplate: $('f-public').value,
    keywordMode: $('f-keywordMode').value,
    keywords: $('f-keywords').value.split(/[,,\s]+/).map((k) => k.trim()).filter(Boolean),
    enabled: $('f-enabled').checked,
  };
}

async function saveRule() {
  const rule = formToRule();
  try {
    if (editingId) await api(`/api/rules/${editingId}`, { method: 'PUT', body: rule });
    else await api('/api/rules', { method: 'POST', body: rule });
    $('rule-dialog').close();
    await refreshState();
    toast('已儲存');
  } catch (err) {
    $('rule-error').textContent = err.message;
    $('rule-error').hidden = false;
  }
}

async function loadPosts() {
  const container = $('posts-list');
  container.innerHTML = '<p class="muted">載入中…</p>';
  try {
    const posts = await api('/api/posts');
    container.innerHTML = posts.map((post) => `
      <div class="item">
        <div class="item-head">
          <div>
            <div>${escapeHtml((post.message ?? '(沒有文字內容)').slice(0, 80))}</div>
            <div class="meta">${new Date(post.created_time).toLocaleString('zh-TW')} · ${escapeHtml(post.id)}</div>
          </div>
          <button class="link" data-use-post="${escapeHtml(post.id)}">用這篇</button>
        </div>
      </div>
    `).join('') || '<p class="muted">沒有找到貼文。</p>';
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function diagnose() {
  const container = $('diagnose-result');
  container.innerHTML = '<p class="muted">檢查中…</p>';
  try {
    const report = await api('/api/diagnose');
    const lines = [];
    if (report.page) lines.push(`<p>✅ 粉專:${escapeHtml(report.page.name)}(${escapeHtml(report.page.id)})</p>`);
    if (report.subscribedFields) lines.push(`<p>訂閱欄位:${escapeHtml(report.subscribedFields.join(', ') || '(無)')}</p>`);
    for (const error of report.errors) lines.push(`<p class="error">⚠️ ${escapeHtml(error)}</p>`);
    if (!report.errors.length) lines.push('<p>✅ 一切正常。</p>');
    container.innerHTML = lines.join('');
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// ── 事件綁定 ────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { password: $('password').value } });
    $('login-error').hidden = true;
    $('password').value = '';
    await boot();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    for (const name of ['rules', 'logs', 'status']) {
      $(`tab-${name}`).hidden = name !== tab.dataset.tab;
    }
    if (tab.dataset.tab === 'logs') loadLogs().catch((err) => toast(err.message));
  });
});

$('new-rule').addEventListener('click', () => openRuleDialog(null));
$('cancel-rule').addEventListener('click', () => $('rule-dialog').close());
$('save-rule').addEventListener('click', saveRule);
$('f-keywordMode').addEventListener('change', toggleKeywords);
$('refresh-logs').addEventListener('click', () => loadLogs().catch((err) => toast(err.message)));
$('load-posts').addEventListener('click', loadPosts);
$('run-diagnose').addEventListener('click', diagnose);

$('subscribe-page').addEventListener('click', async () => {
  try {
    const result = await api('/api/subscribe', { method: 'POST' });
    toast(`訂閱成功:${result.subscribedFields.join(', ')}`);
    await diagnose();
  } catch (err) {
    toast(err.message);
  }
});

$('preview-btn').addEventListener('click', async () => {
  const rule = formToRule();
  const result = await api('/api/preview', { method: 'POST', body: rule });
  $('preview').innerHTML = `<strong>私訊內容:</strong>\n${escapeHtml(result.dm)}\n\n<strong>留言下的公開回覆:</strong>\n${escapeHtml(result.publicReply || '(不回覆)')}`;
  $('preview').hidden = false;
});

$('rules-list').addEventListener('click', async (event) => {
  const editId = event.target.dataset.edit;
  const deleteId = event.target.dataset.delete;
  if (editId) openRuleDialog(state.rules.find((r) => r.id === editId));
  if (deleteId && confirm('確定要刪除這則設定嗎?')) {
    await api(`/api/rules/${deleteId}`, { method: 'DELETE' });
    await refreshState();
    toast('已刪除');
  }
});

$('posts-list').addEventListener('click', (event) => {
  const postId = event.target.dataset.usePost;
  if (!postId) return;
  openRuleDialog(null);
  $('f-postId').value = postId;
});

for (const [id, key] of [
  ['master-switch', 'enabled'],
  ['opt-public-reply', 'publicReplyEnabled'],
  ['opt-skip-nested', 'skipNestedComments'],
  ['opt-skip-own', 'skipOwnComments'],
]) {
  $(id).addEventListener('change', async (event) => {
    await api('/api/settings', { method: 'PUT', body: { [key]: event.target.checked } });
    toast('已更新設定');
  });
}

boot();
