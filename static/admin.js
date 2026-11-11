const API = '/api/admin';

const state = {
  meta: null,
  students: [],
  keyword: '',
  selected: new Set(),
  media: null,
  mediaStudentId: '',
  preview: { source: null, text: '', file: null },
  reportPreview: null,
  editing: null,
  themes: [],
  themeFonts: null,
  themeEditingId: '',
  themeDraft: null,
  previewStudentId: '',
};

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text); // 一律 textContent，避免 XSS
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// 复用中的 keep-alive 连接被服务端关闭时，请求会直接抛 TypeError（Failed to fetch），
// 且不会到达服务器日志；这类网络层失败自动重试一次
async function fetchWithRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      return await fetch(url, init);
    } catch {
      throw new Error('网络连接失败，请重试；若反复失败，请切换网络或换一个浏览器打开');
    }
  }
}

/* ---------- 统一对话框（替代原生 confirm / alert / prompt） ---------- */

let dialogResolve = null;
let dialogKind = 'confirm';

function showDialog(kind, message, options = {}) {
  const { title, confirmText = '确定', cancelText = '取消', danger = false, value = '' } = options;
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogKind = kind;

    $('#dialogTitle').textContent = title || (kind === 'confirm' ? '确认操作' : '提示');
    $('#dialogMessage').textContent = message;
    $('#dialogConfirm').textContent = confirmText;
    $('#dialogConfirm').className = danger ? 'danger' : 'primary';

    const cancel = $('#dialogCancel');
    cancel.textContent = cancelText;
    cancel.hidden = kind === 'alert'; // 纯提示只留一个按钮

    const input = $('#dialogInput');
    input.hidden = kind !== 'prompt';
    input.value = value;

    $('#dialogOverlay').hidden = false;
    if (kind === 'prompt') setTimeout(() => input.focus(), 30);
  });
}

function settleDialog(confirmed) {
  const resolve = dialogResolve;
  const kind = dialogKind;
  dialogResolve = null;
  $('#dialogOverlay').hidden = true;
  if (!resolve) return;
  if (kind === 'confirm') resolve(confirmed);
  else if (kind === 'prompt') resolve(confirmed ? $('#dialogInput').value : null);
  else resolve(undefined);
}

const confirmDialog = (message, options) => showDialog('confirm', message, options);
const alertDialog = (message, options) => showDialog('alert', message, options);
const promptDialog = (message, value) => showDialog('prompt', message, { value });

$('#dialogConfirm').addEventListener('click', () => settleDialog(true));
$('#dialogCancel').addEventListener('click', () => settleDialog(false));
$('#dialogOverlay').addEventListener('click', (event) => {
  if (event.target === $('#dialogOverlay')) settleDialog(false); // 点空白处等于取消
});
$('#dialogInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    settleDialog(true);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#dialogOverlay').hidden) settleDialog(false);
});

/* ---------- 轻提示：成功/信息类反馈，右下角自动消失（错误与确认仍走对话框） ---------- */

function toast(message, options = {}) {
  const { type = 'ok', duration = 4500, action = null } = options;
  const box = $('#toastBox');
  const node = el('div', `toast ${type}`);
  node.append(el('span', 'toast-text', message));

  const dismiss = () => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 220);
  };
  let timer = null;

  // 撤销按钮：跟在文字右侧同一行，别掉到下面去
  if (action) {
    const actionButton = el('button', 'toast-action', action.label);
    actionButton.type = 'button';
    actionButton.addEventListener('click', () => {
      clearTimeout(timer);
      dismiss();
      action.onClick();
    });
    node.append(actionButton);
  }

  // 关闭用小叉，整条提示本身不响应点击（避免误触把撤销按钮一起关掉）
  const closeButton = el('button', 'toast-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭提示');
  closeButton.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });
  node.append(closeButton);

  box.append(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));

  timer = setTimeout(dismiss, duration);
  return node;
}

// 带「撤销」按钮的轻提示参数：撤销窗口比普通提示长一些
function undoToast(undo) {
  if (!undo) return { duration: 6000 };
  return {
    duration: 10000,
    action: { label: '撤销', onClick: () => runUndo(undo.token) },
  };
}

async function runUndo(token) {
  try {
    const result = await request('/students/undo', { method: 'POST', body: { token } });
    toast(`已还原 ${result.restored} 位成员（${result.label}）`);
    await loadStudents();
    await loadMedia();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

async function request(path, options = {}) {
  const { method = 'GET', body, raw = false, headers = {} } = options;
  const response = await fetchWithRetry(`${API}${path}`, {
    method,
    credentials: 'include',
    headers: raw ? headers : (body ? { 'Content-Type': 'application/json' } : undefined),
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应（例如 nginx 的 413/502 页面）走下面的统一报错
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- 登录 ---------- */

function showLogin(message) {
  $('#panel').hidden = true;
  $('#loginScreen').hidden = false;
  $('#loginBtn').disabled = false;
  $('#loginBtn').textContent = '登录';
  $('#adminPassword').value = '';
  const box = $('#loginError');
  box.textContent = message || '';
  box.hidden = !message;
}

async function enterPanel() {
  $('#loginScreen').hidden = true;
  $('#panel').hidden = false;
  if (!state.meta) {
    state.meta = await request('/meta');
    $('#headerHint').textContent = (state.meta.headers || []).join('、');
    $('#batchKeys').textContent = (state.meta.pageKeys || []).join('、');
    const banner = $('#warnBanner');
    const themeReady = Boolean(state.meta.features && state.meta.features.theme && state.meta.extensions && state.meta.extensions.font);
    if (!state.meta.extensions) {
      // 典型场景：静态文件更新了但后端镜像没重建，字段对不上
      banner.textContent = '前后端版本不一致（/meta 缺少 extensions 字段），媒体区无法使用。请在项目目录执行 docker compose up -d --build 后刷新本页。';
      banner.hidden = false;
    } else if (!themeReady) {
      banner.textContent = '前后端版本不一致（/meta 缺少 theme/font 字段），外观与字体功能无法使用。请执行 docker compose up -d --build 后刷新本页。';
      banner.hidden = false;
    } else if (!state.meta.media.writable) {
      banner.textContent = '容器对静态资源目录没有写权限，上传会失败。请检查 docker-compose.yml 里 app 服务的 ./static 挂载是否已去掉 :ro，并执行 docker compose up -d。';
      banner.hidden = false;
    }
  }
  await loadStudents();
  await loadMedia();
  if (state.meta.features && state.meta.features.theme) {
    try {
      await loadThemes();
      await loadThemeFonts();
    } catch (error) {
      showError(error);
    }
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#adminPassword').value;
  if (!username || !password) return showLogin('请填写用户名和密码');

  $('#loginBtn').disabled = true;
  $('#loginBtn').textContent = '登录中…';
  try {
    await request('/login', { method: 'POST', body: { username, password } });
    const session = await request('/session');
    $('#whoami').textContent = `已登录：${session.username}`;
    await enterPanel();
  } catch (error) {
    showLogin(error.message);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await request('/logout', { method: 'POST' });
  } catch {
    // 退出失败也回到登录页
  }
  showLogin('已退出登录');
});

/* ---------- 标签页 ---------- */

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  if (name === 'theme' && state.meta && state.meta.features && state.meta.features.theme && state.themes.length === 0) {
    loadThemes().then(loadThemeFonts).catch(showError);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}

/* ---------- 成员列表 ---------- */

async function loadStudents() {
  const query = state.keyword ? `?q=${encodeURIComponent(state.keyword)}` : '';
  const data = await request(`/students${query}`);
  state.students = data.items;
  $('#studentCount').textContent = state.keyword
    ? `匹配 ${data.total} 人（显示 ${data.items.length} 人）`
    : `共 ${data.total} 人`;
  renderStudents();
  renderPreviewStudentSelect();
}

function renderStudents() {
  const list = $('#studentList');
  list.textContent = '';
  if (state.students.length === 0) {
    list.append(el('p', 'muted', '没有匹配的成员'));
    updateSelectionUi();
    return;
  }

  for (const item of state.students) {
    const card = el('div', 'row');

    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.studentId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.studentId);
      else state.selected.delete(item.studentId);
      updateSelectionUi();
    });

    const main = el('div', 'row-main');
    main.append(el('strong', null, `${item.name}（${item.studentId}）`));
    const facts = [
      item.department || '未填部门',
      `入会 ${item.joinDate || '未填'}（${item.joinDays ?? '-'} 天）`,
      `志愿 ${item.volunteerHours ?? '-'} 小时`,
      `活动 ${item.activityCount ?? '-'} 次`,
    ];
    main.append(el('span', 'muted', facts.join(' · ')));

    const tags = el('div', 'tags');
    if (item.bgDir) tags.append(el('span', 'tag', `专属图目录：${item.bgDir}`));
    if (item.bgMusic) tags.append(el('span', 'tag', `音乐：${item.bgMusic}`));
    if (item.theme) {
      const theme = themeById(item.theme);
      tags.append(el('span', 'tag', `主题：${theme ? theme.name : item.theme}`));
    }
    if (tags.childElementCount > 0) main.append(tags);

    const head = el('div', 'row-head');
    head.append(checkbox, main);
    card.append(head);

    const actions = el('div', 'row-actions');
    actions.append(button('编辑', 'ghost', () => openEditor(item)));
    actions.append(button('媒体', 'ghost', () => {
      selectTab('media');
      $('#mediaStudent').value = item.studentId;
      state.mediaStudentId = item.studentId;
      renderMedia();
    }));
    actions.append(button('预览', 'ghost', () => previewReport(item)));
    actions.append(button('删除', 'danger', () => removeStudent(item)));
    card.append(actions);
    list.append(card);
  }

  updateSelectionUi();
}

/* ---------- 勾选与批量操作 ---------- */

function updateSelectionUi() {
  const count = state.selected.size;
  $('#batchBar').hidden = count === 0;
  $('#batchCount').textContent = `已选 ${count} 人`;

  const visibleIds = state.students.map(item => item.studentId);
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => state.selected.has(id));
  const selectAll = $('#selectAll');
  selectAll.checked = allSelected;
  selectAll.indeterminate = !allSelected && visibleIds.some(id => state.selected.has(id));
}

function clearSelection() {
  state.selected.clear();
  renderStudents(); // 重新渲染即可同步每行的勾选状态
}

$('#selectAll').addEventListener('change', (event) => {
  for (const item of state.students) {
    if (event.target.checked) state.selected.add(item.studentId);
    else state.selected.delete(item.studentId);
  }
  renderStudents();
});

$('#batchClearBtn').addEventListener('click', clearSelection);

// 只导出勾选的成员：Post 一份 id 列表，拿回 xlsx 二进制再触发下载
$('#batchExportBtn').addEventListener('click', async () => {
  const ids = Array.from(state.selected);
  if (ids.length === 0) return;

  const button = $('#batchExportBtn');
  button.disabled = true;
  try {
    const response = await fetchWithRetry(`${API}/export/xlsx`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentIds: ids }),
    });

    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch {
        // 非 JSON（比如 nginx 的错误页）走下面的兜底文案
      }
      const error = new Error((data && data.error) || `导出失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = `学员名单-所选${ids.length}人.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${ids.length} 位成员`);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  } finally {
    button.disabled = false;
  }
});

function showBatchMessage(text) {
  const message = $('#batchMessage');
  message.textContent = text;
  message.hidden = false;
}

$('#batchEditBtn').addEventListener('click', () => {
  if (state.selected.size === 0) return;
  const message = $('#batchMessage');
  message.hidden = true;
  $('#batchSummary').textContent = `将修改已勾选的 ${state.selected.size} 位成员`;
  $('#batchValue').value = '';
  syncBatchValueInput();
  $('#batchOverlay').hidden = false;
});

$('#batchCancel').addEventListener('click', () => { $('#batchOverlay').hidden = true; });

// 入会日期给出示例格式，其它字段说明「留空=清空」
function syncBatchValueInput() {
  const isDate = $('#batchField').value === 'joinDate';
  $('#batchValue').placeholder = isDate ? '2024-09-01' : '留空表示清空该字段';
}

$('#batchField').addEventListener('change', syncBatchValueInput);

const BATCH_NUMERIC_FIELDS = new Set(['volunteerHours', 'activityCount']);

$('#batchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const ids = Array.from(state.selected);
  if (ids.length === 0) return showBatchMessage('没有勾选成员');

  const field = $('#batchField').value;
  const raw = $('#batchValue').value;
  let value = raw;
  if (BATCH_NUMERIC_FIELDS.has(field)) {
    value = raw.trim() === '' ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) return showBatchMessage('这个字段需要填数字');
  }

  const label = $('#batchField').selectedOptions[0].textContent;
  const shown = String(raw).trim() || '（清空）';
  if (!await confirmDialog(`确定把 ${ids.length} 位成员的「${label}」改成「${shown}」吗？（改错的话，10 秒内可在屏幕下方的提示里点「撤销」还原）`, { title: '批量修改' })) return;

  const submit = $('#batchForm button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await request('/students/batch', { method: 'POST', body: { studentIds: ids, set: { [field]: value } } });
    $('#batchOverlay').hidden = true;
    clearSelection();
    await loadStudents();
    await loadMedia();
    toast(`已更新 ${result.updated} 位成员`
      + (result.unchanged ? `，${result.unchanged} 位无变化` : '')
      + (result.skipped.length ? `，跳过 ${result.skipped.length} 位` : ''), undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showBatchMessage(error.message);
  } finally {
    submit.disabled = false;
  }
});

$('#batchResetBtn').addEventListener('click', async () => {
  const ids = Array.from(state.selected);
  if (ids.length === 0) return;
  if (!await confirmDialog(`确定把这 ${ids.length} 位成员的密码重置为「学号后六位」吗？他们在其他设备上的登录会被强制下线；如需保留原密码，10 秒内可在屏幕下方的提示里点「撤销」。`, { title: '重置密码' })) return;
  try {
    const result = await request('/students/batch', { method: 'POST', body: { studentIds: ids, resetPasswordToDefault: true } });
    clearSelection();
    await loadStudents();
    toast(`已重置 ${result.passwordReset} 位成员的密码`
      + (result.otherSessionsRemoved ? `，注销了 ${result.otherSessionsRemoved} 个登录会话` : ''), undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#batchDeleteBtn').addEventListener('click', async () => {
  const ids = Array.from(state.selected);
  if (ids.length === 0) return;
  if (!await confirmDialog(`确定删除这 ${ids.length} 位成员吗？他们将无法再登录；删除后 10 秒内，可在屏幕下方的提示里点「撤销」还原。`, { title: '批量删除', confirmText: '删除', danger: true })) return;
  try {
    const result = await request('/students/batch-delete', { method: 'POST', body: { studentIds: ids } });
    clearSelection();
    await loadStudents();
    await loadMedia();
    toast(`已删除 ${result.deleted} 位成员`
      + (result.sessionsRemoved ? `，注销 ${result.sessionsRemoved} 个登录会话` : '')
      + (result.skipped.length ? `，跳过 ${result.skipped.length} 位` : ''), undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

let searchTimer = null;
$('#searchInput').addEventListener('input', (event) => {
  state.keyword = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadStudents().catch(showError), 300);
});

$('#refreshBtn').addEventListener('click', () => {
  loadStudents().then(loadMedia).catch(showError);
});

function showError(error) {
  return alertDialog(error.message, { title: '操作失败' });
}

/* ---------- 新增 / 编辑 ---------- */

const EDITOR_FIELDS = {
  studentId: '#f_studentId',
  name: '#f_name',
  department: '#f_department',
  joinDate: '#f_joinDate',
  volunteerHours: '#f_volunteerHours',
  activityCount: '#f_activityCount',
  partner: '#f_partner',
  message: '#f_message',
  bgDir: '#f_bgDir',
  bgMusic: '#f_bgMusic',
  password: '#f_password',
};

function openEditor(item) {
  state.editing = item || null;
  $('#editorTitle').textContent = item ? `编辑：${item.name}（${item.studentId}）` : '新增成员';
  $('#f_studentId').readOnly = Boolean(item);
  $('#f_studentId').value = item ? item.studentId : '';
  $('#f_name').value = item ? item.name : '';
  $('#f_department').value = item ? item.department || '' : '';
  $('#f_joinDate').value = item ? item.joinDate || '' : '';
  $('#f_volunteerHours').value = item && item.volunteerHours !== null ? item.volunteerHours : '';
  $('#f_activityCount').value = item && item.activityCount !== null ? item.activityCount : '';
  $('#f_partner').value = item ? item.partner || '' : '';
  $('#f_message').value = item ? item.message || '' : '';
  $('#f_bgDir').value = item ? item.bgDir || '' : '';
  $('#f_bgMusic').value = item ? item.bgMusic || '' : '';
  $('#f_theme').value = item && item.theme ? item.theme : '';
  $('#f_password').value = '';
  $('#f_password').placeholder = item ? '留空 = 不修改密码' : '留空 = 用学号后六位';
  const message = $('#editorMessage');
  message.hidden = true;
  message.textContent = '';
  $('#editorOverlay').hidden = false;
}

function closeEditor() {
  $('#editorOverlay').hidden = true;
  state.editing = null;
}

$('#editorCancel').addEventListener('click', closeEditor);

function numberOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

$('#editorForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#editorMessage');
  const submit = $('#editorForm button[type="submit"]');
  message.hidden = true;

  const payload = {
    studentId: $('#f_studentId').value.trim(),
    name: $('#f_name').value.trim(),
    department: $('#f_department').value.trim(),
    joinDate: $('#f_joinDate').value.trim(),
    volunteerHours: numberOrNull($('#f_volunteerHours').value),
    activityCount: numberOrNull($('#f_activityCount').value),
    partner: $('#f_partner').value.trim(),
    message: $('#f_message').value,
    bgDir: $('#f_bgDir').value.trim(),
    bgMusic: $('#f_bgMusic').value.trim(),
    theme: $('#f_theme').value,
    password: $('#f_password').value,
  };

  if (!payload.studentId) return showEditorMessage('请填写学号');
  if (!payload.name) return showEditorMessage('请填写姓名');

  submit.disabled = true;
  try {
    if (state.editing) {
      // 编辑只提交改动过的字段，避免把没动过的字段一并覆盖
      const before = state.editing;
      const changed = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'studentId') continue;
        const original = before[key] === undefined || before[key] === null ? '' : String(before[key]);
        if (key === 'password' ? value : String(value) !== original) changed[key] = value;
      }
      delete changed.studentId;
      const result = await request(`/students/${encodeURIComponent(before.studentId)}`, { method: 'PUT', body: changed });
      closeEditor();
      await loadStudents();
      await loadMedia();
      if (result.changed.length === 0 && result.otherSessionsRemoved === 0) {
        toast('没有任何改动', { type: 'info' });
      } else {
        const extra = result.otherSessionsRemoved > 0 ? `，并让该学员 ${result.otherSessionsRemoved} 个设备下线` : '';
        toast(`已保存：${result.changed.join('、') || '无字段变化'}${extra}`, undoToast(result.undo));
      }
    } else {
      const result = await request('/students', { method: 'POST', body: payload });
      closeEditor();
      await loadStudents();
      await loadMedia();
      toast(result.usedDefaultPassword ? '已新增，初始密码为学号后六位' : '已新增');
    }
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showEditorMessage(error.message);
  } finally {
    submit.disabled = false;
  }
});

function showEditorMessage(text) {
  const message = $('#editorMessage');
  message.textContent = text;
  message.hidden = false;
}

$('#addStudentBtn').addEventListener('click', () => openEditor(null));

async function removeStudent(item) {
  if (!await confirmDialog(`确定删除「${item.name}（${item.studentId}）」吗？该学员将无法再登录；删除后 10 秒内，可在屏幕下方的提示里点「撤销」还原。`, { title: '删除成员', confirmText: '删除', danger: true })) return;
  try {
    const result = await request(`/students/${encodeURIComponent(item.studentId)}`, { method: 'DELETE' });
    await loadStudents();
    await loadMedia();
    toast(`已删除${result.sessionsRemoved > 0 ? `，并注销其 ${result.sessionsRemoved} 个登录会话` : ''}`, undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

async function previewReport(item) {
  try {
    const data = await request(`/students/${encodeURIComponent(item.studentId)}/report`);
    state.reportPreview = { studentId: item.studentId, themeId: data.themeId || '' };
    $('#reportTitle').textContent = `报告预览：${data.name}（${data.studentId}）`;
    const body = $('#reportBody');
    body.textContent = '';
    for (const [label, value] of [
      ['姓名', data.name],
      ['部门', data.department],
      ['入会日期', data.joinDate || '未填'],
      ['加入天数', data.joinDays === null || data.joinDays === undefined ? '—（未填入会日期）' : `${data.joinDays} 天（实时计算）`],
      ['志愿时长', data.volunteerHours],
      ['活动次数', data.activityCount],
      ['年度伙伴', data.partner],
      ['部长寄语', data.message],
      ['背景图目录', data.bgDir || '（未指定，用学号目录）'],
      ['背景音乐', data.bgMusic || '（未指定，找与学号同名）'],
      ['主题', data.themeId || '（默认主题）'],
    ]) {
      body.append(el('div', 'muted', `${label}：${value ?? '-'}`));
    }
    body.append(el('div', 'muted', '—— 实际会加载的资源 ——'));
    for (const key of state.meta.pageKeys) {
      const url = data.backgrounds[key];
      body.append(el('div', null, `${key}：${url || '未配置（用页面渐变）'}`));
    }
    body.append(el('div', null, `背景音乐：${data.music || '未配置'}`));
    body.append(el('div', null, `标题字体：${data.theme.fonts.display || '系统默认'}`));
    body.append(el('div', null, `正文字体：${data.theme.fonts.body || '系统默认'}`));
    $('#reportOverlay').hidden = false;
  } catch (error) {
    showError(error);
  }
}

$('#reportClose').addEventListener('click', () => { $('#reportOverlay').hidden = true; });

$('#realPreviewBtn').addEventListener('click', () => {
  const info = state.reportPreview;
  if (!info || !info.studentId) return;
  const themeQuery = info.themeId ? `&themeId=${encodeURIComponent(info.themeId)}` : '';
  window.open(
    `/index.html?preview=1&student=${encodeURIComponent(info.studentId)}${themeQuery}`,
    '_blank',
    'noopener'
  );
});

/* ---------- 批量媒体操作 ---------- */

// 学员的专属图目录：显式指定过就用它，否则用学号
function mediaDirOf(studentId) {
  const student = state.students.find(item => item.studentId === studentId);
  return (student && student.bgDir) || studentId;
}

function showMediaBatchMessage(text) {
  const message = $('#mediaBatchMessage');
  message.textContent = text;
  message.hidden = false;
}

const MEDIA_BATCH_ROWS = {
  music: ['#mediaBatchMusicRow'],
  dir: ['#mediaBatchDirRow'],
  upload: ['#mediaBatchUploadRow'],
  remove: ['#mediaBatchRemoveRow'],
};

function syncMediaBatchRows() {
  const action = $('#mediaBatchAction').value;
  for (const [key, selectors] of Object.entries(MEDIA_BATCH_ROWS)) {
    for (const selector of selectors) $(selector).hidden = key !== action;
  }
}

$('#mediaBatchAction').addEventListener('change', syncMediaBatchRows);

$('#batchMediaBtn').addEventListener('click', () => {
  const count = state.selected.size;
  if (count === 0) return;
  if (!state.media) return showError(new Error('媒体数据还没加载完，稍后再试'));

  $('#mediaBatchMessage').hidden = true;
  $('#mediaBatchProgress').textContent = '';
  $('#mediaBatchSummary').textContent = `将作用于已勾选的 ${count} 位成员`;

  // 音乐下拉：第一项是「清空」，其余是音乐库里的文件
  const musicSelect = $('#mediaBatchMusicFile');
  musicSelect.textContent = '';
  const clearOption = el('option', null, '（清空，回到与学号同名）');
  clearOption.value = '';
  musicSelect.append(clearOption);
  for (const track of state.media.music) {
    const option = el('option', null, `${track.name}（${Math.round(track.size / 1024)}KB）`);
    option.value = track.name;
    musicSelect.append(option);
  }

  for (const selectId of ['#mediaBatchSlotKey', '#mediaBatchRemoveKey']) {
    const select = $(selectId);
    select.textContent = '';
    for (const key of state.meta.pageKeys) {
      const option = el('option', null, key);
      option.value = key;
      select.append(option);
    }
  }

  $('#mediaBatchAction').value = 'music';
  $('#mediaBatchDirValue').value = '';
  $('#mediaBatchImage').value = '';
  syncMediaBatchRows();
  $('#mediaBatchOverlay').hidden = false;
});

$('#mediaBatchCancel').addEventListener('click', () => { $('#mediaBatchOverlay').hidden = true; });

$('#mediaBatchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const ids = Array.from(state.selected);
  if (ids.length === 0) return showMediaBatchMessage('没有勾选成员');

  const action = $('#mediaBatchAction').value;
  const progress = $('#mediaBatchProgress');
  const submit = $('#mediaBatchForm button[type="submit"]');
  $('#mediaBatchMessage').hidden = true;
  submit.disabled = true;

  try {
    // 指派音乐 / 设置图目录：复用成员批量接口，一次请求搞定
    if (action === 'music' || action === 'dir') {
      const set = action === 'music'
        ? { bgMusic: $('#mediaBatchMusicFile').value }
        : { bgDir: $('#mediaBatchDirValue').value.trim() };
      const result = await request('/students/batch', { method: 'POST', body: { studentIds: ids, set } });
      $('#mediaBatchOverlay').hidden = true;
      clearSelection();
      await loadStudents();
      await loadMedia();
      toast(`已更新 ${result.updated} 位成员`
        + (result.unchanged ? `，${result.unchanged} 位无变化` : '')
        + (result.skipped.length ? `，跳过 ${result.skipped.length} 位` : ''), undoToast(result.undo));
      return;
    }

    // 上传同一张图到每名学员各自的专属目录
    if (action === 'upload') {
      const file = $('#mediaBatchImage').files && $('#mediaBatchImage').files[0];
      if (!file) return showMediaBatchMessage('请选择要上传的图片');
      const extensions = state.meta.extensions.image;
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (!extensions.includes(ext)) return showMediaBatchMessage(`只支持 ${extensions.join(' / ')} 格式`);
      if (file.size > state.meta.limits.image) return showMediaBatchMessage(`图片不能超过 ${Math.round(state.meta.limits.image / 1024 / 1024)}MB`);

      const slot = $('#mediaBatchSlotKey').value;
      if (!await confirmDialog(`将把这张图写进 ${ids.length} 位学员各自的专属目录（同名直接覆盖），继续吗？`, { title: '批量上传专属图', confirmText: '上传' })) return;

      let done = 0;
      let failed = 0;
      for (const [index, studentId] of ids.entries()) {
        // 必须写进该学员实际读取的目录（显式指定过图目录时就不是学号目录）
        const dir = mediaDirOf(studentId);
        progress.textContent = `上传中 ${index + 1}/${ids.length}：${dir}`;
        try {
          await upload({ kind: 'image', dir, name: `${slot}${ext}`, file, overwrite: true });
          done += 1;
        } catch {
          failed += 1;
        }
      }
      progress.textContent = `完成：成功 ${done} 位${failed ? `，失败 ${failed} 位` : ''}`;
      await loadMedia();
      return;
    }

    // 删除这些学员在某槽位的专属图
    if (action === 'remove') {
      const slot = $('#mediaBatchRemoveKey').value;
      const targets = [];
      for (const studentId of ids) {
        const dir = mediaDirOf(studentId);
        const entry = state.media.images.dirs.find(item => item.dir === dir);
        const file = entry && entry.files.find(item => item.key === slot && item.supported);
        if (file) targets.push({ dir, name: file.name });
      }
      if (targets.length === 0) return showMediaBatchMessage('这些学员在该槽位都没有专属图，无需删除');
      if (!await confirmDialog(`将删除 ${targets.length} 位学员在「${slot}」的专属图（媒体文件删除后无法撤销），继续吗？`, { title: '删除专属图', confirmText: '删除', danger: true })) return;

      let done = 0;
      let failed = 0;
      for (const [index, target] of targets.entries()) {
        progress.textContent = `删除中 ${index + 1}/${targets.length}：${target.dir}/${target.name}`;
        try {
          await request(`/media?kind=image&dir=${encodeURIComponent(target.dir)}&name=${encodeURIComponent(target.name)}`, { method: 'DELETE' });
          done += 1;
        } catch {
          failed += 1;
        }
      }
      progress.textContent = `完成：删除 ${done} 个${failed ? `，失败 ${failed} 个` : ''}`;
      await loadMedia();
    }
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showMediaBatchMessage(error.message);
  } finally {
    submit.disabled = false;
  }
});

/* ---------- 媒体资源 ---------- */

async function loadMedia() {
  state.media = await request('/media');
  const select = $('#mediaStudent');
  const previous = state.mediaStudentId || select.value;
  select.textContent = '';
  for (const item of state.students) {
    const option = el('option', null, `${item.name}（${item.studentId}）`);
    option.value = item.studentId;
    select.append(option);
  }
  if (state.students.length === 0) {
    state.mediaStudentId = '';
  } else {
    const exists = state.students.some(item => item.studentId === previous);
    state.mediaStudentId = exists ? previous : state.students[0].studentId;
    select.value = state.mediaStudentId;
  }
  renderMedia();
}

function pickActive(files, key, extensions) {
  const candidates = files.filter(file => file.key === key && file.supported);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => extensions.indexOf(a.ext) - extensions.indexOf(b.ext))[0];
}

function renderMedia() {
  if (!state.media) return;
  if (!state.meta.extensions) {
    for (const selector of ['#ownSlots', '#sharedSlots', '#musicList']) {
      const box = $(selector);
      box.textContent = '';
      box.append(el('p', 'muted', '前后端版本不一致，媒体区无法渲染；请执行 docker compose up -d --build 后刷新本页'));
    }
    return;
  }
  const extensions = state.meta.extensions.image;
  const student = state.students.find(item => item.studentId === state.mediaStudentId) || null;
  const ownDir = student ? (student.bgDir || student.studentId) : '';
  const ownFiles = (state.media.images.dirs.find(entry => entry.dir === ownDir) || { files: [] }).files;

  $('#ownDirHint').textContent = student
    ? `当前学员：${student.name}（${student.studentId}）；专属目录：images/${ownDir}/${student.bgDir ? '（Excel/编辑里显式指定）' : '（默认用学号）'}`
    : '还没有成员';
  $('#ownDirPath').textContent = ownDir ? `images/${ownDir}/` : 'images/<学号>/';

  renderSlots($('#ownSlots'), state.meta.pageKeys, ownFiles, extensions, 'own', ownDir, student);
  renderSlots($('#sharedSlots'), state.meta.pageKeys, state.media.images.shared, extensions, 'shared', '', student);
  renderMusic(student);
}

function renderSlots(container, keys, files, extensions, scope, dir, student) {
  container.textContent = '';
  for (const key of keys) {
    const active = pickActive(files, key, extensions);
    const card = el('div', 'slot');
    const thumb = el('div', 'thumb');
    if (active) {
      thumb.style.backgroundImage = `url("${active.url}")`;
      thumb.textContent = '';
    } else {
      thumb.textContent = '未配置';
    }
    card.append(thumb);
    card.append(el('div', 'slot-name', key));
    card.append(el('div', `slot-state ${active ? 'on' : 'off'}`, active ? `${active.name}（${Math.round(active.size / 1024)}KB）` : '未配置'));

    // 落选的同基名文件（优先级更低，不会生效）
    const losers = files.filter(file => file.key === key && file.supported && (!active || file.name !== active.name));
    if (losers.length > 0) {
      card.append(el('div', 'slot-state off', `未生效：${losers.map(file => file.name).join('、')}`));
    }

    const actions = el('div', 'slot-actions');
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) uploadImage(file, dir, key, Boolean(active));
    });
    actions.append(input);
    actions.append(button(active ? '替换' : '上传', 'ghost', () => input.click()));
    if (active) {
      actions.append(button('删除', 'danger', () => deleteMedia('image', dir, active.name)));
    }
    card.append(actions);
    container.append(card);
  }
}

async function uploadImage(file, dir, key, overwrite) {
  const extensions = state.meta.extensions.image;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) {
    await alertDialog(`只支持 ${extensions.join(' / ')} 格式；iPhone 的 HEIC 请先转成 JPG 再传。`);
    return;
  }
  if (file.size > state.meta.limits.image) {
    await alertDialog(`图片不能超过 ${Math.round(state.meta.limits.image / 1024 / 1024)}MB`);
    return;
  }

  const name = `${key}${ext}`;
  try {
    const result = await upload({ kind: 'image', dir, name, file, overwrite });
    await loadMedia();
    if (result.shadows && result.shadows.length > 0) {
      toast(`已上传，但同名的 ${result.shadows.join('、')} 优先级更高，这张图不会生效。\n点这条提示可关闭，需要的话请把那个文件删掉。`, { type: 'warn', duration: 7000 });
    }
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    if (error.status === 409 && await confirmDialog('同名文件已存在，要覆盖吗？', { title: '覆盖文件', confirmText: '覆盖' })) {
      return uploadImage(file, dir, key, true);
    }
    showError(error);
  }
}

async function upload({ kind, dir, name, file, overwrite }) {
  const query = new URLSearchParams({ kind, dir: dir || '', name });
  if (overwrite) query.set('overwrite', '1');
  return request(`/media/upload?${query.toString()}`, {
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
}

async function deleteMedia(kind, dir, name) {
  if (!await confirmDialog(`确定删除 ${dir ? `${dir}/` : ''}${name} 吗？媒体文件删除后无法撤销。`, { title: '删除文件', confirmText: '删除', danger: true })) return;
  try {
    await request(`/media?kind=${kind}&dir=${encodeURIComponent(dir || '')}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadMedia();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

function renderMusic(student) {
  const box = $('#musicList');
  box.textContent = '';
  const tracks = state.media.music;

  if (student) {
    const current = tracks.find(track => track.usedBy.some(user => user.studentId === student.studentId));
    const line = el('div', 'row-main');
    line.append(el('strong', null, `当前学员使用：${current ? current.name : '未配置音乐'}`));
    if (!current) line.append(el('span', 'muted', '可以上传一首，或把文件名改成学号同名让它自动匹配'));
    const actions = el('div', 'row-actions');
    actions.append(button('恢复默认（找与学号同名）', 'ghost', () => assignMusic(student, null)));
    if (current) actions.append(button('为该学员取消音乐', 'danger', () => assignMusic(student, '', true)));
    const wrap = el('div', 'row');
    wrap.append(line, actions);
    box.append(wrap);
  }

  if (tracks.length === 0) {
    box.append(el('p', 'muted', '音乐库里还没有文件'));
    return;
  }

  for (const track of tracks) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('strong', null, track.name));
    main.append(el('span', 'muted', `${Math.round(track.size / 1024)}KB · 被 ${track.usedBy.length} 人使用${track.usedBy.length ? '：' + track.usedBy.map(user => user.name).join('、') : ''}`));
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = track.url;
    main.append(audio);
    row.append(main);

    const actions = el('div', 'row-actions');
    if (student) {
      actions.append(button(`设为 ${student.name} 的音乐`, 'ghost', () => assignMusic(student, track.name)));
    }
    actions.append(button('删除', 'danger', () => deleteMedia('music', '', track.name)));
    row.append(actions);
    box.append(row);
  }
}

async function assignMusic(student, name, disable = false) {
  try {
    const result = await request(`/students/${encodeURIComponent(student.studentId)}`, {
      method: 'PUT',
      body: { bgMusic: disable ? '' : name }, // 传空串 = 清掉显式指定，回到「找与学号同名」
    });
    await loadStudents();
    await loadMedia();
    toast(disable ? '已取消该学员的音乐' : (name ? `已把 ${name} 指定给 ${student.name}` : '已恢复默认规则'));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

$('#mediaStudent').addEventListener('change', (event) => {
  state.mediaStudentId = event.target.value;
  renderMedia();
});

$('#musicFile').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  $('#musicFileName').textContent = file ? file.name : '';
});

$('#uploadMusicBtn').addEventListener('click', async () => {
  const input = $('#musicFile');
  const file = input.files && input.files[0];
  if (!file) return await alertDialog('请先选择一个音频文件');

  const extensions = state.meta.extensions.music;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) return await alertDialog(`只支持 ${extensions.join(' / ')} 格式`);
  if (file.size > state.meta.limits.music) return await alertDialog(`音乐不能超过 ${Math.round(state.meta.limits.music / 1024 / 1024)}MB`);

  const student = state.students.find(item => item.studentId === state.mediaStudentId);
  const suggested = student ? `${student.studentId}${ext}` : file.name;
  const name = await promptDialog('保存为哪个文件名？（用学号命名可自动归属该学员）', suggested);
  if (!name) return;

  try {
    const result = await upload({ kind: 'music', dir: '', name: name.trim(), file, overwrite: false });
    input.value = '';
    $('#musicFileName').textContent = '';
    await loadMedia();
    toast(`已上传 ${result.file ? result.file.name : name}`);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    if (error.status === 409) {
      if (!await confirmDialog('同名文件已存在，要覆盖吗？', { title: '覆盖文件', confirmText: '覆盖' })) return;
      try {
        await upload({ kind: 'music', dir: '', name: name.trim(), file, overwrite: true });
        input.value = '';
        $('#musicFileName').textContent = '';
        await loadMedia();
        toast('已覆盖');
      } catch (err) {
        showError(err);
      }
      return;
    }
    showError(error);
  }
});

/* ---------- 批量上传（按文件名自动归属） ---------- */

let batchPlan = [];
let batchUploading = false;

function studentStmExists(studentId) {
  return state.students.some(item => item.studentId === studentId);
}

// 从文件名或文件夹结构推断这个文件该放哪儿
function parseMediaFile(file) {
  const keys = state.meta.pageKeys;
  const { image: imageExts, music: musicExts } = state.meta.extensions;

  // 目录上传时 webkitRelativePath 形如 "我选的文件夹/2021001/01-opening.jpg"，
  // 第一段是用户选中的文件夹本身，去掉它
  const segments = (file.webkitRelativePath || '').split('/').filter(Boolean);
  const parts = segments.length >= 3 ? segments.slice(1) : segments;
  const baseName = parts.length > 0 ? parts[parts.length - 1] : file.name;
  const ext = (baseName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const stem = ext ? baseName.slice(0, baseName.length - ext.length) : baseName;
  // 只有「确实是成员表里的学号」时才把目录当学号用，
  // 否则「我选的文件夹/04-activities.webp」这种会被误判
  const rawFolder = parts.length > 1 ? parts[0] : '';
  const folder = rawFolder && studentStmExists(rawFolder) ? rawFolder : '';

  // 1) 文件夹形式：<学号>/<槽位>.<扩展名>
  if (folder && keys.includes(stem) && imageExts.includes(ext)) {
    return { kind: 'image', dir: folder, name: `${stem}${ext}`, studentId: folder };
  }
  // 2) 共享图：<槽位>.<扩展名>
  if (!folder && keys.includes(stem) && imageExts.includes(ext)) {
    return { kind: 'image', dir: '', name: `${stem}${ext}` };
  }
  // 3) 学员专属图：<学号>-<槽位>.<扩展名> 或 <学号>_<槽位>.<扩展名>
  const matched = stem.match(/^(.+?)[-_](.+)$/);
  if (matched && keys.includes(matched[2]) && imageExts.includes(ext)) {
    return { kind: 'image', dir: matched[1], name: `${matched[2]}${ext}`, studentId: matched[1] };
  }
  // 4) 背景音乐：<学号>.<扩展名>
  if (!folder && musicExts.includes(ext) && /^[A-Za-z0-9_-]{1,32}$/.test(stem)) {
    return { kind: 'music', dir: '', name: `${stem}${ext}`, studentId: stem };
  }
  return { error: '文件名无法识别：图片要用「槽位名」或「学号-槽位名」，音乐要用「学号」命名' };
}

function addToBatchPlan(files) {
  for (const file of files) {
    const parsed = parseMediaFile(file);
    if (parsed.error) {
      batchPlan.push({ file, status: 'error', message: parsed.error });
      continue;
    }
    if (parsed.studentId && !studentStmExists(parsed.studentId)) {
      batchPlan.push({ file, ...parsed, status: 'error', message: `成员表里没有 ${parsed.studentId}，先添加成员再传` });
      continue;
    }
    const limit = parsed.kind === 'image' ? state.meta.limits.image : state.meta.limits.music;
    if (file.size > limit) {
      batchPlan.push({ file, ...parsed, status: 'error', message: `超过 ${Math.round(limit / 1024 / 1024)}MB 上限` });
      continue;
    }
    batchPlan.push({ file, ...parsed, status: 'ready', message: '' });
  }
  renderBatchPlan();
}

function describeTarget(item) {
  if (item.kind === 'music') return `${item.studentId} 的音乐 → music/${item.name}`;
  if (item.dir) return `${item.dir} 的专属图 → images/${item.dir}/${item.name}`;
  return `共享图 → images/${item.name}`;
}

const BATCH_STATUS = {
  ready: ['update', '待上传'],
  done: ['insert', '已上传'],
  skipped: ['unchanged', '已跳过'],
  error: ['error', '有问题'],
};

function renderBatchPlan() {
  const box = $('#batchPlan');
  box.textContent = '';
  const ready = batchPlan.filter(item => item.status === 'ready').length;
  $('#batchUploadBtn').disabled = batchUploading || ready === 0;
  $('#batchClearPlanBtn').disabled = batchUploading || batchPlan.length === 0;

  for (const item of batchPlan) {
    const row = el('div', 'preview-item');
    row.append(el('span', null, item.file.name));
    row.append(el('span', 'muted', item.kind ? describeTarget(item) : '—'));
    const [className, label] = BATCH_STATUS[item.status] || ['unchanged', item.status];
    row.append(el('span', `badge ${className}`, label));
    if (item.message) row.append(el('span', item.status === 'error' ? 'msg error' : 'muted', item.message));
    box.append(row);
  }
}

$('#batchFiles').addEventListener('change', (event) => {
  addToBatchPlan(Array.from(event.target.files || []));
  event.target.value = '';
});

$('#batchDir').addEventListener('change', (event) => {
  addToBatchPlan(Array.from(event.target.files || []));
  event.target.value = '';
});

$('#batchClearPlanBtn').addEventListener('click', () => {
  batchPlan = [];
  $('#batchProgress').textContent = '';
  renderBatchPlan();
});

$('#batchUploadBtn').addEventListener('click', async () => {
  const overwrite = $('#batchOverwrite').checked;
  const ready = batchPlan.filter(item => item.status === 'ready');
  if (ready.length === 0) return;
  if (!await confirmDialog(`将上传 ${ready.length} 个文件${overwrite ? '（同名文件直接覆盖）' : '（遇到同名文件会跳过）'}，继续吗？`, { title: '批量上传', confirmText: '开始上传' })) return;

  const progress = $('#batchProgress');
  batchUploading = true;
  renderBatchPlan();
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, item] of ready.entries()) {
    progress.textContent = `上传中 ${index + 1}/${ready.length}：${item.file.name}`;
    try {
      await upload({ kind: item.kind, dir: item.dir, name: item.name, file: item.file, overwrite });
      item.status = 'done';
      item.message = '';
      done += 1;
    } catch (error) {
      if (error.status === 409) {
        item.status = 'skipped';
        item.message = '同名文件已存在（想覆盖请勾选上方选项后重传）';
        skipped += 1;
      } else if (error.status === 401) {
        batchUploading = false;
        renderBatchPlan();
        return showLogin('登录已过期，请重新登录');
      } else {
        item.status = 'error';
        item.message = error.message;
        failed += 1;
      }
    }
    renderBatchPlan();
  }

  batchUploading = false;
  progress.textContent = `完成：成功 ${done} 个`
    + (skipped ? `，跳过 ${skipped} 个` : '')
    + (failed ? `，失败 ${failed} 个` : '');
  renderBatchPlan();
  await loadMedia();
});

/* ---------- 导入 / 导出 ---------- */

function renderPreview(data) {
  const box = $('#previewBox');
  box.textContent = '';
  const counts = data.counts;
  box.append(el('p', 'msg ok', `共 ${counts.total} 行：新增 ${counts.insert} · 更新 ${counts.update} · 无变化 ${counts.unchanged} · 错误 ${counts.error}`
    + `（${counts.defaultPassword} 人将使用初始密码，${counts.setPassword} 人会被重设密码）`));

  const items = el('div', 'preview-items');
  for (const item of data.items) {
    const row = el('div', 'preview-item');
    row.append(el('span', 'muted', `第 ${item.line} 行`));
    row.append(el('span', null, `${item.studentId || '—'} ${item.name || ''}`.trim()));
    row.append(el('span', `badge ${item.action}`, { insert: '新增', update: '更新', unchanged: '无变化', error: '错误' }[item.action] || item.action));
    if (item.changedFields && item.changedFields.length) row.append(el('span', 'muted', `改动：${item.changedFields.join('、')}`));
    if (item.passwordAction === 'set') row.append(el('span', 'muted', '重设密码'));
    if (item.passwordAction === 'default') row.append(el('span', 'muted', '初始密码'));
    if (item.error) row.append(el('span', 'msg error', item.error));
    items.append(row);
  }
  box.append(items);
  if (data.truncated) box.append(el('p', 'muted', '（只展示前 300 行）'));
  for (const error of data.parseErrors || []) {
    box.append(el('p', 'msg error', `第 ${error.line} 行解析失败：${error.message}`));
  }
  if (data.sheetName) box.append(el('p', 'muted', `工作表：${data.sheetName}`));
}

function hasChanges(data) {
  return data.counts.insert + data.counts.update > 0;
}

$('#previewTextBtn').addEventListener('click', async () => {
  const text = $('#importText').value;
  if (!text.trim()) return await alertDialog('请先粘贴内容');
  try {
    const data = await request('/import/text/preview', { method: 'POST', body: { text } });
    state.preview = { source: 'text', text, file: null };
    renderPreview(data);
    $('#commitTextBtn').disabled = !hasChanges(data);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#commitTextBtn').addEventListener('click', async () => {
  if (state.preview.source !== 'text') return;
  if ($('#importText').value !== state.preview.text) {
    return await alertDialog('内容在预览后又被改过，请重新预览再导入');
  }
  if (!await confirmDialog('确认按预览结果写入数据库吗？', { title: '确认导入', confirmText: '写入数据库' })) return;
  try {
    const result = await request('/import/text', { method: 'POST', body: { text: state.preview.text } });
    $('#commitTextBtn').disabled = true;
    await loadStudents();
    await loadMedia();
    toast(`导入完成：写入 ${result.imported} 条，无变化 ${result.unchanged} 条，跳过 ${result.skipped.length} 条`
      + (result.defaulted ? `，其中 ${result.defaulted} 人使用初始密码` : ''));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#excelFile').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  $('#excelFileName').textContent = file ? file.name : '';
  $('#commitExcelBtn').disabled = true; // 换了文件必须重新预览
});

$('#previewExcelBtn').addEventListener('click', async () => {
  const input = $('#excelFile');
  const file = input.files && input.files[0];
  if (!file) return await alertDialog('请先选择 .xlsx 文件');
  try {
    const data = await request('/import/xlsx/preview', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    state.preview = { source: 'xlsx', text: '', file };
    renderPreview(data);
    $('#commitExcelBtn').disabled = !hasChanges(data);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#commitExcelBtn').addEventListener('click', async () => {
  const file = state.preview.file;
  if (state.preview.source !== 'xlsx' || !file) return;
  if (!await confirmDialog('确认按预览结果写入数据库吗？', { title: '确认导入', confirmText: '写入数据库' })) return;
  try {
    const result = await request('/import/xlsx', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    $('#commitExcelBtn').disabled = true;
    await loadStudents();
    await loadMedia();
    toast(`导入完成：写入 ${result.imported} 条，无变化 ${result.unchanged} 条，跳过 ${result.skipped.length} 条`
      + (result.defaulted ? `，其中 ${result.defaulted} 人使用初始密码` : ''));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

/* ---------- 外观 / 主题 ---------- */

const FALLBACK_FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const DEFAULT_THEME_CONFIG = {
  base: { accent: '#7dd3fc', accent2: '#bcd6ff', scrim: 0.45, scrimColor: '#060a14' },
  fonts: { display: null, body: null },
  motion: { notes: true, record: true },
  pages: {},
};

const loadedPreviewFonts = new Set();

function defaultThemeConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_THEME_CONFIG));
}

function themeById(id) {
  return state.themes.find(theme => theme.id === id) || null;
}

function showThemeMessage(text) {
  const message = $('#themeMessage');
  message.textContent = text;
  message.hidden = false;
}

async function loadThemes() {
  const data = await request('/themes');
  state.themes = data.items || [];
  if (!state.themes.some(theme => theme.id === state.themeEditingId)) {
    const fallback = state.themes.find(theme => theme.isDefault) || state.themes[0];
    state.themeEditingId = fallback ? fallback.id : '';
  }
  renderThemeSelects();
  renderThemeEditor();
  if (state.students.length > 0) renderStudents(); // 主题名加载后刷新成员卡片上的标签
}

async function loadThemeFonts() {
  state.themeFonts = await request('/themes/fonts');
  renderFontOptions();
  renderFontStates();
}

function renderThemeSelects() {
  const current = {
    themeSelect: state.themeEditingId,
    themeAssignSelect: $('#themeAssignSelect').value,
    f_theme: $('#f_theme').value,
  };
  for (const [id, value] of Object.entries(current)) {
    const select = $(`#${id}`);
    select.textContent = '';
    if (id !== 'themeSelect') select.append(new Option('默认主题', ''));
    for (const theme of state.themes) {
      select.append(new Option(`${theme.name}${theme.isDefault ? '（默认）' : ''}`, theme.id));
    }
    if (value) select.value = value;
  }
  $('#themeSelect').value = state.themeEditingId;
}

function renderPreviewStudentSelect() {
  const select = $('#previewStudent');
  if (!select) return;
  const current = select.value || state.previewStudentId;
  select.textContent = '';
  for (const item of state.students) {
    select.append(new Option(`${item.name}（${item.studentId}）`, item.studentId));
  }
  if (current && [...select.options].some(option => option.value === current)) select.value = current;
  else if (select.options.length > 0) select.selectedIndex = 0;
  state.previewStudentId = select.value || '';
}

function setColorInputs(name, value) {
  if (!value) return;
  $(`#t_${name}`).value = value;
  $(`#t_${name}Hex`).value = value.toUpperCase();
}

function renderThemeEditor() {
  const theme = themeById(state.themeEditingId);
  const form = $('#themeForm');
  form.querySelectorAll('input, select, button, textarea').forEach((node) => { node.disabled = !theme; });
  if (!theme) {
    state.themeDraft = null;
    $('#themeMeta').textContent = '还没有主题，点「新建」创建一个';
    return;
  }

  state.themeDraft = JSON.parse(JSON.stringify(theme.config));
  const config = state.themeDraft;
  $('#t_name').value = theme.name;
  setColorInputs('accent', config.base.accent);
  setColorInputs('accent2', config.base.accent2);
  setColorInputs('scrimColor', config.base.scrimColor);
  $('#t_scrim').value = String(config.base.scrim);
  $('#t_scrimValue').textContent = Number(config.base.scrim).toFixed(2);
  $('#t_notes').checked = config.motion.notes !== false;
  $('#t_record').checked = config.motion.record !== false;

  const pageSelect = $('#t_page');
  const previousPage = pageSelect.value;
  pageSelect.textContent = '';
  for (const key of state.meta.pageKeys) pageSelect.append(new Option(key, key));
  if (previousPage && state.meta.pageKeys.includes(previousPage)) pageSelect.value = previousPage;
  renderPageFields();

  renderFontOptions();
  renderFontStates();
  renderPageOverrides();
  updateThemePreview();

  const usage = theme.isDefault ? '默认主题' : `使用 ${theme.usage} 人`;
  $('#themeMeta').textContent = `${theme.name} · ${usage}${theme.invalid ? ' · 配置损坏，已按默认值读取' : ''}`;
}

function setDraftColor(name, value) {
  if (!state.themeDraft || !/^#[0-9a-fA-F]{6}$/.test(value)) return;
  state.themeDraft.base[name] = value.toLowerCase();
  updateThemePreview();
}

for (const name of ['accent', 'accent2', 'scrimColor']) {
  $(`#t_${name}`).addEventListener('input', (event) => {
    $(`#t_${name}Hex`).value = event.target.value.toUpperCase();
    setDraftColor(name, event.target.value);
  });
  $(`#t_${name}Hex`).addEventListener('input', (event) => {
    const value = event.target.value.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
    $(`#t_${name}`).value = value;
    setDraftColor(name, value);
  });
}

$('#t_scrim').addEventListener('input', (event) => {
  if (!state.themeDraft) return;
  const value = Number(event.target.value);
  state.themeDraft.base.scrim = Math.round(value * 100) / 100;
  $('#t_scrimValue').textContent = value.toFixed(2);
  updateThemePreview();
});

$('#t_notes').addEventListener('change', (event) => {
  if (!state.themeDraft) return;
  state.themeDraft.motion.notes = event.target.checked;
  updateThemePreview();
});

$('#t_record').addEventListener('change', (event) => {
  if (!state.themeDraft) return;
  state.themeDraft.motion.record = event.target.checked;
  updateThemePreview();
});

function renderPageFields() {
  if (!state.themeDraft) return;
  const override = (state.themeDraft.pages || {})[$('#t_page').value] || {};
  $('#t_pageAccent').value = override.accent || '';
  $('#t_pageAccent2').value = override.accent2 || '';
  $('#t_pageScrimColor').value = override.scrimColor || '';
  $('#t_pageScrim').value = typeof override.scrim === 'number' ? String(override.scrim) : '';
}

$('#t_page').addEventListener('change', renderPageFields);

$('#t_pageSave').addEventListener('click', () => {
  if (!state.themeDraft) return;
  const key = $('#t_page').value;
  if (!key) return;
  const accent = $('#t_pageAccent').value.trim();
  const accent2 = $('#t_pageAccent2').value.trim();
  const scrimColor = $('#t_pageScrimColor').value.trim();
  const scrimRaw = $('#t_pageScrim').value.trim();
  for (const value of [accent, accent2, scrimColor]) {
    if (value && !/^#[0-9a-fA-F]{6}$/.test(value)) return showThemeMessage('页面颜色需为 #RRGGBB');
  }
  const override = {};
  if (accent) override.accent = accent.toLowerCase();
  if (accent2) override.accent2 = accent2.toLowerCase();
  if (scrimColor) override.scrimColor = scrimColor.toLowerCase();
  if (scrimRaw !== '') {
    const scrim = Number(scrimRaw);
    if (!Number.isFinite(scrim) || scrim < 0 || scrim > 0.9) return showThemeMessage('页面暗层强度需在 0–0.9 之间');
    override.scrim = Math.round(scrim * 100) / 100;
  }
  if (Object.keys(override).length === 0) delete state.themeDraft.pages[key];
  else state.themeDraft.pages[key] = override;
  $('#themeMessage').hidden = true;
  renderPageOverrides();
  updateThemePreview();
  toast(`已更新 ${key} 的页面覆盖，记得保存主题`, { type: 'info' });
});

$('#t_pageClear').addEventListener('click', () => {
  if (!state.themeDraft) return;
  const key = $('#t_page').value;
  if (!key) return;
  delete state.themeDraft.pages[key];
  renderPageFields();
  renderPageOverrides();
  updateThemePreview();
  toast(`已清除 ${key} 的页面覆盖`, { type: 'info' });
});

function renderPageOverrides() {
  const box = $('#t_pageList');
  box.textContent = '';
  if (!state.themeDraft) return;
  const pages = state.themeDraft.pages || {};
  const keys = Object.keys(pages);
  if (keys.length === 0) {
    box.append(el('p', 'muted', '还没有按页覆盖'));
    return;
  }
  for (const key of keys) {
    const override = pages[key];
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('strong', null, key));
    const parts = [];
    if (override.accent) parts.push(`主色 ${override.accent}`);
    if (override.accent2) parts.push(`强调色 ${override.accent2}`);
    if (typeof override.scrim === 'number') parts.push(`暗层 ${override.scrim}`);
    if (override.scrimColor) parts.push(`暗层颜色 ${override.scrimColor}`);
    main.append(el('span', 'muted', parts.join(' · ') || '（空覆盖）'));

    const actions = el('div', 'row-actions');
    actions.append(button('删除', 'danger', () => {
      delete state.themeDraft.pages[key];
      renderPageOverrides();
      updateThemePreview();
    }));
    row.append(main, actions);
    box.append(row);
  }
}

function fontUrlFor(choice, slot) {
  if (!choice) return null;
  if (choice === 'custom') {
    const custom = state.themeFonts && state.themeFonts.custom && state.themeFonts.custom[slot];
    return custom ? custom.url : null;
  }
  const presets = (state.themeFonts && state.themeFonts.presets) || [];
  const preset = presets.find(item => item.id === choice);
  return preset ? preset.url : null;
}

function renderFontOptions() {
  if (!state.themeDraft) return;
  const presets = (state.themeFonts && state.themeFonts.presets) || [];
  for (const slot of ['display', 'body']) {
    const select = $(slot === 'display' ? '#t_fontDisplay' : '#t_fontBody');
    const current = state.themeDraft.fonts[slot] || '';
    select.textContent = '';
    select.append(new Option('系统默认', ''));
    for (const preset of presets) select.append(new Option(preset.name, preset.id));
    const custom = state.themeFonts && state.themeFonts.custom && state.themeFonts.custom[slot];
    select.append(new Option(custom ? '自定义（已上传）' : '自定义（未上传）', 'custom'));
    select.value = current;
    if (select.value !== current) {
      // 预设文件可能被删除：回退系统默认
      select.value = '';
      state.themeDraft.fonts[slot] = null;
    }
  }
}

function renderFontStates() {
  for (const slot of ['display', 'body']) {
    const custom = state.themeFonts && state.themeFonts.custom && state.themeFonts.custom[slot];
    const stateNode = $(slot === 'display' ? '#t_fontDisplayState' : '#t_fontBodyState');
    const deleteBtn = $(slot === 'display' ? '#t_fontDisplayDelete' : '#t_fontBodyDelete');
    stateNode.textContent = custom ? `${custom.name} · ${Math.round(custom.size / 1024)} KB` : '尚未上传';
    deleteBtn.hidden = !custom;
  }
}

for (const slot of ['display', 'body']) {
  $(slot === 'display' ? '#t_fontDisplay' : '#t_fontBody').addEventListener('change', (event) => {
    if (!state.themeDraft) return;
    state.themeDraft.fonts[slot] = event.target.value || null;
    const custom = state.themeFonts && state.themeFonts.custom && state.themeFonts.custom[slot];
    if (event.target.value === 'custom' && !custom) {
      toast('这个槽位还没有上传自定义字体，保存后会回退系统字体', { type: 'warn' });
    }
    updateThemePreview();
  });
}

async function uploadSlotFont(slot, file) {
  if (!file) return;
  const extensions = (state.meta && state.meta.extensions && state.meta.extensions.font) || ['.woff2', '.woff'];
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) return alertDialog(`只支持 ${extensions.join(' / ')} 格式`);
  const limit = (state.meta && state.meta.limits && state.meta.limits.font) || 8 * 1024 * 1024;
  if (file.size > limit) return alertDialog(`字体不能超过 ${Math.round(limit / 1024 / 1024)}MB，建议先做子集化`);

  const name = `${slot}${ext}`;
  try {
    try {
      await upload({ kind: 'font', dir: '', name, file });
    } catch (error) {
      if (error.status !== 409) throw error;
      if (!await confirmDialog('该槽位已有字体，要覆盖吗？', { title: '覆盖字体', confirmText: '覆盖' })) return;
      await upload({ kind: 'font', dir: '', name, file, overwrite: true });
    }
    await loadThemeFonts();
    if (state.themeDraft) state.themeDraft.fonts[slot] = 'custom';
    renderFontOptions();
    renderFontStates();
    updateThemePreview();
    toast('字体已上传并选中，保存主题后生效');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

$('#t_fontDisplayFile').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  uploadSlotFont('display', file);
});

$('#t_fontBodyFile').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  uploadSlotFont('body', file);
});

async function deleteSlotFont(slot) {
  const custom = state.themeFonts && state.themeFonts.custom && state.themeFonts.custom[slot];
  if (!custom) return;
  const label = slot === 'display' ? '标题' : '正文';
  if (!await confirmDialog(`确定删除自定义${label}字体「${custom.name}」吗？所有使用「自定义」的主题都会回退到系统字体；媒体文件删除无法撤销。`, { title: '删除字体', confirmText: '删除', danger: true })) return;
  try {
    await request(`/media?kind=font&dir=&name=${encodeURIComponent(custom.name)}`, { method: 'DELETE' });
    await loadThemeFonts();
    if (state.themeDraft && state.themeDraft.fonts[slot] === 'custom') {
      state.themeDraft.fonts[slot] = null;
      renderFontOptions();
    }
    renderFontStates();
    updateThemePreview();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

$('#t_fontDisplayDelete').addEventListener('click', () => deleteSlotFont('display'));
$('#t_fontBodyDelete').addEventListener('click', () => deleteSlotFont('body'));

function hexToRgb(hex) {
  const matched = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!matched) return null;
  const value = parseInt(matched[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function updateThemePreview() {
  const stage = $('#themePreview');
  if (!state.themeDraft) return;
  const base = state.themeDraft.base;
  stage.style.setProperty('--accent', base.accent);
  stage.style.setProperty('--accent-2', base.accent2);
  stage.style.setProperty('--scrim-rgb', hexToRgb(base.scrimColor) || '6, 10, 20');
  stage.style.setProperty('--scrim-alpha', String(base.scrim));
  applyPreviewFont(stage, 'display', state.themeDraft.fonts.display);
  applyPreviewFont(stage, 'body', state.themeDraft.fonts.body);
}

async function applyPreviewFont(stage, slot, choice) {
  const variable = slot === 'display' ? '--preview-font-display' : '--preview-font-body';
  const family = slot === 'display' ? 'ThemePreviewDisplay' : 'ThemePreviewBody';
  const url = fontUrlFor(choice, slot);
  if (!url) {
    stage.style.setProperty(variable, FALLBACK_FONT);
    return;
  }
  try {
    const key = `${family}|${url}`;
    if (!loadedPreviewFonts.has(key)) {
      const face = new FontFace(family, `url("${url}")`);
      await face.load();
      document.fonts.add(face);
      loadedPreviewFonts.add(key);
    }
    stage.style.setProperty(variable, `"${family}", ${FALLBACK_FONT}`);
  } catch {
    stage.style.setProperty(variable, FALLBACK_FONT);
  }
}

async function saveTheme(openPreview) {
  if (!state.themeDraft || !state.themeEditingId) return;
  $('#themeMessage').hidden = true;
  const name = $('#t_name').value.trim();
  if (!name) return showThemeMessage('请填写主题名称');

  const submit = $('#themeForm button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await request(`/themes/${encodeURIComponent(state.themeEditingId)}`, {
      method: 'PUT',
      body: { name, config: state.themeDraft },
    });
    const usage = (themeById(state.themeEditingId) || {}).usage || 0;
    state.themes = state.themes.map(theme => theme.id === result.theme.id ? { ...result.theme, usage } : theme);
    renderThemeSelects();
    renderThemeEditor();
    toast('主题已保存');
    if (openPreview) openRealPreview();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showThemeMessage(error.message);
  } finally {
    submit.disabled = false;
  }
}

function openRealPreview() {
  const studentId = $('#previewStudent').value;
  if (!studentId) return alertDialog('请先选择预览学员');
  if (!state.themeEditingId) return alertDialog('请先保存主题');
  window.open(
    `/index.html?preview=1&student=${encodeURIComponent(studentId)}&themeId=${encodeURIComponent(state.themeEditingId)}`,
    '_blank',
    'noopener'
  );
}

$('#themeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveTheme(false);
});

$('#themeSavePreviewBtn').addEventListener('click', () => saveTheme(true));
$('#openRealPreviewBtn').addEventListener('click', () => saveTheme(true));

$('#themeSelect').addEventListener('change', (event) => {
  state.themeEditingId = event.target.value;
  renderThemeEditor();
});

$('#themeNewBtn').addEventListener('click', async () => {
  try {
    const result = await request('/themes', { method: 'POST', body: { name: '新主题', config: defaultThemeConfig() } });
    await loadThemes();
    state.themeEditingId = result.theme.id;
    renderThemeSelects();
    renderThemeEditor();
    toast('已新建主题，改完记得保存');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#themeDuplicateBtn').addEventListener('click', async () => {
  if (!state.themeEditingId) return;
  try {
    const result = await request(`/themes/${encodeURIComponent(state.themeEditingId)}/duplicate`, { method: 'POST', body: {} });
    await loadThemes();
    state.themeEditingId = result.theme.id;
    renderThemeSelects();
    renderThemeEditor();
    toast('已复制主题');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#themeDefaultBtn').addEventListener('click', async () => {
  const theme = themeById(state.themeEditingId);
  if (!theme) return;
  if (!await confirmDialog(`把「${theme.name}」设为默认主题吗？没有单独指定主题的成员都会使用它。`, { title: '设为默认主题' })) return;
  try {
    await request(`/themes/${encodeURIComponent(theme.id)}/default`, { method: 'POST' });
    await loadThemes();
    toast('已设为默认主题');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#themeDeleteBtn').addEventListener('click', async () => {
  const theme = themeById(state.themeEditingId);
  if (!theme) return;
  if (!await confirmDialog(`确定删除主题「${theme.name}」吗？仍被成员使用的主题需要先更换；删除无法撤销。`, { title: '删除主题', confirmText: '删除', danger: true })) return;
  try {
    await request(`/themes/${encodeURIComponent(theme.id)}`, { method: 'DELETE' });
    state.themeEditingId = '';
    await loadThemes();
    toast('主题已删除');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error); // 409 会显示「还有 N 名成员在使用」
  }
});

$('#batchThemeBtn').addEventListener('click', () => {
  if (state.selected.size === 0) return;
  $('#themeAssignSummary').textContent = `将给已勾选的 ${state.selected.size} 位成员应用主题`;
  renderThemeSelects();
  $('#themeAssignSelect').value = '';
  $('#themeAssignOverlay').hidden = false;
});

$('#themeAssignCancel').addEventListener('click', () => { $('#themeAssignOverlay').hidden = true; });

$('#themeAssignForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const ids = Array.from(state.selected);
  if (ids.length === 0) return;
  const themeId = $('#themeAssignSelect').value;
  const theme = themeId ? themeById(themeId) : null;
  const label = theme ? theme.name : '默认主题';
  if (!await confirmDialog(`确定给这 ${ids.length} 位成员应用「${label}」吗？10 秒内可在右下角提示里撤销。`, { title: '应用主题', confirmText: '应用' })) return;
  try {
    const result = await request('/students/batch', { method: 'POST', body: { studentIds: ids, set: { theme: themeId } } });
    $('#themeAssignOverlay').hidden = true;
    clearSelection();
    await loadStudents();
    toast(`已为 ${result.updated} 位成员应用主题`, undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

/* ---------- 启动 ---------- */

(async function start() {
  try {
    const session = await request('/session');
    $('#whoami').textContent = `已登录：${session.username}`;
    await enterPanel();
  } catch (error) {
    if (error.status !== 401) showLogin('无法连接服务器，请刷新重试');
  }
})();
