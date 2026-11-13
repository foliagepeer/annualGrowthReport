const API = '/api/admin';

const state = {
  meta: null,
  students: [],
  keyword: '',
  selected: new Set(),
  media: null,
  mediaExtras: null,
  mediaStudentId: '',
  preview: { source: null, text: '', file: null },
  reportPreview: null,
  editing: null,
  themes: [],
  themeFonts: null,
  themeEditingId: '',
  themeDraft: null,
  archives: [],
  restore: null,
  previewStudentId: '',
  themeAssignStudentId: '',
  themeMode: 'style',
  layoutPageKey: '01-cover',
  layoutSelectedId: '',
  layoutPreviewData: null,
  layoutPreviewFor: '',
  layoutScale: 1,
  pages: [],
  reportYear: '',
  editingPageKey: null,
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
    state.pages = state.meta.pages || [];
    state.reportYear = state.meta.reportYear || '';
    if (!state.meta.pageKeys.includes(state.layoutPageKey)) state.layoutPageKey = state.meta.pageKeys[0] || '01-cover';
    $('#reportYearInput').value = state.reportYear;
    $('#archiveYear').value = state.reportYear || new Date().getFullYear();
    $('#loginPrefaceInput').value = (state.meta.loginCopy && state.meta.loginCopy.preface) || '';
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
  await loadExtras();
  renderPages();
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
  for (const tab of document.querySelectorAll('.tabs .tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  if (name === 'theme' && state.meta && state.meta.features && state.meta.features.theme && state.themes.length === 0) {
    loadThemes().then(loadThemeFonts).catch(showError);
  }
  if (name === 'pages') renderPages();
  if (name === 'archives') loadArchives().catch(showError);
  if (name === 'theme' && state.themeMode === 'layout') {
    requestAnimationFrame(() => {
      if (isLayoutMode()) applyEditorScale();
    });
  }
}

// 只绑定顶部主导航；排版里的「元素/属性」子页签不使用 data-tab
for (const tab of document.querySelectorAll('.tabs .tab')) {
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
  if (isLayoutMode()) loadLayoutPreview();
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
    actions.append(button('主题', 'ghost', () => openThemeAssign(item)));
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
    link.download = `成员名单-所选${ids.length}人.xlsx`;
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
  $('#batchSummary').textContent = `将编辑已勾选的 ${state.selected.size} 位成员`;
  $('#batchValue').value = '';
  syncBatchValueInput();
  $('#batchOverlay').hidden = false;
});

$('#batchCancel').addEventListener('click', () => { $('#batchOverlay').hidden = true; });

// 入会日期给出示例格式，其它字段说明「留空=清空」
function syncBatchValueInput() {
  const field = $('#batchField').value;
  const isDate = field === 'joinDate' || field === 'activity1Date' || field === 'activity2Date';
  const isActivities = field === 'activities';
  $('#batchValue').placeholder = isDate
    ? '2024-09-01，可填多个用、分隔'
    : isActivities ? '留空 = 按每人自己的活动回忆生成' : '留空表示清空该字段';
  $('#batchFieldHint').hidden = !isActivities;
  $('#batchAutoActivitiesRow').hidden = !isActivities;
  if (isActivities) {
    $('#batchFieldHint').textContent = '留空时按每位成员自己的两条活动回忆名称生成；也可以直接点下面的按钮立即生成。';
  }
}

$('#batchField').addEventListener('change', syncBatchValueInput);

$('#batchAutoActivitiesBtn').addEventListener('click', async () => {
  const ids = Array.from(state.selected);
  if (ids.length === 0) return showBatchMessage('没有勾选成员');
  if (!await confirmDialog('将按每位成员自己的两条活动回忆名称生成活动记录；没有活动回忆名称的成员会跳过。10 秒内可在提示里撤销。', { title: '自动生成活动记录' })) return;

  const button = $('#batchAutoActivitiesBtn');
  button.disabled = true;
  try {
    const result = await request('/students/batch', { method: 'POST', body: { studentIds: ids, autoActivities: true } });
    $('#batchOverlay').hidden = true;
    clearSelection();
    await loadStudents();
    toast(`已为 ${result.updated} 位成员生成活动记录`
      + (result.skipped.length ? `，跳过 ${result.skipped.length} 位（没有活动回忆名称）` : ''), undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showBatchMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

const BATCH_NUMERIC_FIELDS = new Set(['volunteerHours', 'activityCount', 'partnerCount']);

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
  if (!await confirmDialog(`确定把 ${ids.length} 位成员的「${label}」改成「${shown}」吗？（改错的话，10 秒内可在屏幕下方的提示里点「撤销」还原）`, { title: '批量编辑' })) return;

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
  partnerCount: '#f_partnerCount',
  activities: '#f_activities',
  activity1Name: '#f_activity1Name',
  activity1Date: '#f_activity1Date',
  activity1Work: '#f_activity1Work',
  activity2Name: '#f_activity2Name',
  activity2Date: '#f_activity2Date',
  activity2Work: '#f_activity2Work',
  keyword: '#f_keyword',
  keywordReason: '#f_keywordReason',
  message: '#f_message',
  bgDir: '#f_bgDir',
  bgMusic: '#f_bgMusic',
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
  $('#f_partnerCount').value = item && item.partnerCount !== null && item.partnerCount !== undefined ? item.partnerCount : '';
  $('#f_activities').value = item ? item.activities || '' : '';
  $('#f_activity1Name').value = item ? item.activity1Name || '' : '';
  $('#f_activity1Date').value = item ? item.activity1Date || '' : '';
  $('#f_activity1Work').value = item ? item.activity1Work || '' : '';
  $('#f_activity2Name').value = item ? item.activity2Name || '' : '';
  $('#f_activity2Date').value = item ? item.activity2Date || '' : '';
  $('#f_activity2Work').value = item ? item.activity2Work || '' : '';
  $('#f_keyword').value = item ? item.keyword || '' : '';
  $('#f_keywordReason').value = item ? item.keywordReason || '' : '';
  $('#f_message').value = item ? item.message || '' : '';
  $('#f_bgDir').value = item ? item.bgDir || '' : '';
  $('#f_bgMusic').value = item ? item.bgMusic || '' : '';
  $('#f_theme').value = item && item.theme ? item.theme : '';
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

$('#fillActivitiesBtn').addEventListener('click', () => {
  const names = [...new Set([
    $('#f_activity1Name').value.trim(),
    $('#f_activity2Name').value.trim(),
  ].filter(Boolean))];
  if (names.length === 0) return alertDialog('请先填写至少一个活动回忆的名称');
  $('#f_activities').value = names.join('、');
  toast('已从活动回忆生成活动记录');
});

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
    partnerCount: numberOrNull($('#f_partnerCount').value),
    activities: $('#f_activities').value.trim(),
    activity1Name: $('#f_activity1Name').value.trim(),
    activity1Date: $('#f_activity1Date').value.trim(),
    activity1Work: $('#f_activity1Work').value.trim(),
    activity2Name: $('#f_activity2Name').value.trim(),
    activity2Date: $('#f_activity2Date').value.trim(),
    activity2Work: $('#f_activity2Work').value.trim(),
    keyword: $('#f_keyword').value.trim(),
    keywordReason: $('#f_keywordReason').value.trim(),
    message: $('#f_message').value,
    bgDir: $('#f_bgDir').value.trim(),
    bgMusic: $('#f_bgMusic').value.trim(),
    theme: $('#f_theme').value,
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
        if (String(value) !== original) changed[key] = value;
      }
      delete changed.studentId;
      const result = await request(`/students/${encodeURIComponent(before.studentId)}`, { method: 'PUT', body: changed });
      closeEditor();
      await loadStudents();
      await loadMedia();
      if (result.changed.length === 0) {
        toast('没有任何改动', { type: 'info' });
      } else {
        toast(`已保存：${result.changed.join('、')}`, undoToast(result.undo));
      }
    } else {
      const result = await request('/students', { method: 'POST', body: payload });
      closeEditor();
      await loadStudents();
      await loadMedia();
      toast('已新增');
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
  if (!await confirmDialog(`确定删除「${item.name}（${item.studentId}）」吗？该成员将无法再登录；删除后 10 秒内，可在屏幕下方的提示里点「撤销」还原。`, { title: '删除成员', confirmText: '删除', danger: true })) return;
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
    const resolvedTheme = data.themeId ? themeById(data.themeId) : null;
    const themeName = (resolvedTheme && resolvedTheme.name)
      || (data.theme && data.theme.name)
      || data.themeId
      || '（默认主题）';
    const themeLabel = `${themeName}${resolvedTheme && resolvedTheme.isDefault ? '（默认）' : ''}`;
    for (const [label, value] of [
      ['姓名', data.name],
      ['部门', data.department],
      ['年度', data.reportYear],
      ['入会日期', data.joinDate || '未填'],
      ['加入天数', data.joinDays === null || data.joinDays === undefined ? '—（未填入会日期）' : `${data.joinDays} 天（实时计算）`],
      ['志愿时长', data.volunteerHours],
      ['活动次数', data.activityCount],
      ['活动记录', (data.activities || []).join('、') || '未填'],
      ['活动一', data.activity1 && data.activity1.name ? `${data.activity1.name} ${data.activity1.date || ''}：${data.activity1.work || ''}` : '未填'],
      ['活动二', data.activity2 && data.activity2.name ? `${data.activity2.name} ${data.activity2.date || ''}：${data.activity2.work || ''}` : '未填'],
      ['伙伴人数', data.partnerLine || '—'],
      ['年度关键词', data.keyword ? `${data.keyword}${data.keywordReason ? `：${data.keywordReason}` : ''}` : '未填'],
      ['部长寄语', data.message],
      ['背景图目录', data.bgDir || '（未指定，用学号目录）'],
      ['背景音乐', data.bgMusic || '（未指定，找与学号同名）'],
      ['主题', themeLabel],
      ['页面数', `${Array.isArray(data.pages) ? data.pages.length : 0} 页`],
    ]) {
      body.append(el('div', 'muted', `${label}：${value ?? '-'}`));
    }
    body.append(el('div', 'muted', '—— 实际会加载的资源 ——'));
    const themeLayout = (data.theme && data.theme.layout) || {};
    for (const page of state.meta.pages || []) {
      if (!page.enabled) continue;
      const url = data.backgrounds[page.key];
      const layout = themeLayout[page.key];
      const slotCount = layout ? (layout.elements || []).filter(element => element.type === 'extra').length : 0;
      const layoutText = layout ? `主题排版（${(layout.elements || []).length} 个元素，${slotCount} 个图片槽位）` : '默认版式';
      body.append(el('div', null, `${page.title}：${url || '未配置（用页面渐变）'} · ${layoutText}`));
      const extras = (data.extras && data.extras[page.key]) || [];
      if (extras.length > 0) {
        body.append(el('div', 'muted', `　附加图片 ${extras.length} 张：${extras.map(file => file.name).join('、')}`));
      }
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

// 成员的专属图目录：显式指定过就用它，否则用学号
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
      const option = el('option', null, pageName(key));
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

    // 上传同一张图到每名成员各自的专属目录
    if (action === 'upload') {
      const file = $('#mediaBatchImage').files && $('#mediaBatchImage').files[0];
      if (!file) return showMediaBatchMessage('请选择要上传的图片');
      const extensions = state.meta.extensions.image;
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (!extensions.includes(ext)) return showMediaBatchMessage(`只支持 ${extensions.join(' / ')} 格式`);
      if (file.size > state.meta.limits.image) return showMediaBatchMessage(`图片不能超过 ${Math.round(state.meta.limits.image / 1024 / 1024)}MB`);

      const slot = $('#mediaBatchSlotKey').value;
      if (!await confirmDialog(`将把这张图写进 ${ids.length} 位成员各自的专属目录（同名直接覆盖），继续吗？`, { title: '批量上传专属图', confirmText: '上传' })) return;

      let done = 0;
      let failed = 0;
      for (const [index, studentId] of ids.entries()) {
        // 必须写进该成员实际读取的目录（显式指定过图目录时就不是学号目录）
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

    // 删除这些成员在某槽位的专属图
    if (action === 'remove') {
      const slot = $('#mediaBatchRemoveKey').value;
      const targets = [];
      for (const studentId of ids) {
        const dir = mediaDirOf(studentId);
        const entry = state.media.images.dirs.find(item => item.dir === dir);
        const file = entry && entry.files.find(item => item.key === slot && item.supported);
        if (file) targets.push({ dir, name: file.name });
      }
      if (targets.length === 0) return showMediaBatchMessage('这些成员在该槽位都没有专属图，无需删除');
      if (!await confirmDialog(`将删除 ${targets.length} 位成员在「${slot}」的专属图（媒体文件删除后无法撤销），继续吗？`, { title: '删除专属图', confirmText: '删除', danger: true })) return;

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

function renderExtraPageOptions() {
  const select = $('#extraPageKey');
  if (!select || !state.meta) return;
  const previous = select.value;
  select.textContent = '';
  for (const page of state.meta.pages || []) {
    const option = el('option', null, `${page.title}（${page.key}）${page.enabled ? '' : ' · 已停用'}`);
    option.value = page.key;
    select.append(option);
  }
  if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
}

async function loadExtras() {
  if (!state.mediaStudentId) {
    state.mediaExtras = null;
    renderExtras();
    return;
  }
  try {
    state.mediaExtras = await request(`/students/${encodeURIComponent(state.mediaStudentId)}/photos`);
  } catch (error) {
    state.mediaExtras = null;
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
  renderExtras();
}

function renderExtras() {
  const box = $('#extraList');
  if (!box) return;
  box.textContent = '';
  const data = state.mediaExtras;
  if (!data || !data.pages || !data.groups || Object.keys(data.groups).length === 0) {
    box.append(el('p', 'muted', state.mediaStudentId ? '这个成员还没有附加图片' : '还没有成员'));
    return;
  }
  for (const page of data.pages) {
    const files = data.groups[page.key] || [];
    if (files.length === 0) continue;
    const group = el('div', 'extra-group');
    const head = el('div', 'row-head');
    head.append(el('strong', null, page.title));
    head.append(el('span', 'muted', `${page.key} · ${files.length} 张 · 插在该页之后`));
    group.append(head);
    const grid = el('div', 'slots');
    for (const file of files) {
      const card = el('div', 'slot');
      const thumb = el('div', 'thumb');
      thumb.style.backgroundImage = `url("${file.url}")`;
      card.append(thumb);
      card.append(el('div', 'slot-name', file.name));
      card.append(el('div', 'muted', `${Math.round(file.size / 1024)}KB`));
      card.append(button('删除', 'ghost', () => deleteExtraPhoto(page.key, file.name)));
      grid.append(card);
    }
    group.append(grid);
    box.append(group);
  }
  if (!box.childNodes.length) box.append(el('p', 'muted', '这个成员还没有附加图片'));
}

async function uploadExtraFor(studentId, pageKey, name, file, overwrite) {
  const extensions = (state.meta && state.meta.extensions && state.meta.extensions.image) || [];
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) {
    throw new Error(`只支持 ${extensions.join(' / ')} 格式；iPhone 的 HEIC 请先转成 JPG 再传`);
  }
  if (file.size > state.meta.limits.image) {
    throw new Error(`图片不能超过 ${Math.round(state.meta.limits.image / 1024 / 1024)}MB`);
  }
  const query = new URLSearchParams({ pageKey, name });
  if (overwrite) query.set('overwrite', '1');
  return request(`/students/${encodeURIComponent(studentId)}/photos?${query.toString()}`, {
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
}

async function uploadExtraPhoto(file, pageKey, overwrite) {
  return uploadExtraFor(state.mediaStudentId, pageKey, file.name, file, overwrite);
}

async function deleteExtraPhoto(pageKey, name) {
  if (!await confirmDialog(`确定删除「${name}」吗？图片文件删除后无法撤销。`, { title: '删除附加图片', confirmText: '删除', danger: true })) return;
  try {
    const query = new URLSearchParams({ pageKey, name });
    await request(`/students/${encodeURIComponent(state.mediaStudentId)}/photos?${query.toString()}`, { method: 'DELETE' });
    await loadExtras();
    toast('已删除附加图片');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

function pickActive(files, key, extensions) {
  const candidates = files.filter(file => file.key === key && file.supported);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => extensions.indexOf(a.ext) - extensions.indexOf(b.ext))[0];
}

function renderMedia() {
  if (!state.media) return;
  renderExtraPageOptions();
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
    ? `当前成员：${student.name}（${student.studentId}）；专属目录：images/${ownDir}/${student.bgDir ? '（Excel/编辑里显式指定）' : '（默认用学号）'}`
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
    line.append(el('strong', null, `当前成员使用：${current ? current.name : '未配置音乐'}`));
    if (!current) line.append(el('span', 'muted', '可以上传一首，或把文件名改成学号同名让它自动匹配'));
    const actions = el('div', 'row-actions');
    actions.append(button('恢复默认（找与学号同名）', 'ghost', () => assignMusic(student, null)));
    if (current) actions.append(button('为该成员取消音乐', 'danger', () => assignMusic(student, '', true)));
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
    toast(disable ? '已取消该成员的音乐' : (name ? `已把 ${name} 指定给 ${student.name}` : '已恢复默认规则'));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

$('#mediaStudent').addEventListener('change', (event) => {
  state.mediaStudentId = event.target.value;
  renderMedia();
  loadExtras();
});

$('#extraFiles').addEventListener('change', (event) => {
  const files = [...(event.target.files || [])];
  $('#extraProgress').textContent = files.length ? `已选择 ${files.length} 张图片` : '';
});

$('#uploadExtraBtn').addEventListener('click', async () => {
  const input = $('#extraFiles');
  const files = [...(input.files || [])];
  if (files.length === 0) return alertDialog('请先选择图片');
  const pageKey = $('#extraPageKey').value;
  if (!pageKey) return alertDialog('请先选择归属页面');

  let ok = 0;
  let failed = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    $('#extraProgress').textContent = `正在上传 ${index + 1}/${files.length}：${file.name}`;
    try {
      await uploadExtraPhoto(file, pageKey, $('#extraOverwrite').checked);
      ok += 1;
    } catch (error) {
      if (error.status === 409 && await confirmDialog(`「${file.name}」已存在，要覆盖吗？`, { title: '覆盖图片', confirmText: '覆盖' })) {
        try {
          await uploadExtraPhoto(file, pageKey, true);
          ok += 1;
          continue;
        } catch (retryError) {
          error = retryError;
        }
      }
      if (error.status === 401) return showLogin('登录已过期，请重新登录');
      failed += 1;
      showError(error);
    }
  }
  input.value = '';
  await loadExtras();
  $('#extraProgress').textContent = `完成：成功 ${ok} 张${failed ? `，失败 ${failed} 张` : ''}`;
  toast(`已上传 ${ok} 张附加图片${failed ? `，${failed} 张失败` : ''}`, { type: failed ? 'warn' : 'info' });
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
  const name = await promptDialog('保存为哪个文件名？（用学号命名可自动归属该成员）', suggested);
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
  const keys = [...(state.meta.pageKeys || []), ...(state.meta.legacyPageKeys || [])];
  const extraKeys = (state.meta.pages || []).map(page => page.key).sort((a, b) => b.length - a.length);
  const { image: imageExts, music: musicExts } = state.meta.extensions;

  // 目录上传时 webkitRelativePath 形如 "我选的文件夹/2021001/01-opening.jpg"，
  // 第一段通常是用户选中的文件夹本身；如果直接选中了学号文件夹则保留
  const segments = (file.webkitRelativePath || '').split('/').filter(Boolean);
  const directStudentFolder = segments.length >= 3
    && studentStmExists(segments[0])
    && (extraKeys.includes(segments[1]) || keys.includes(segments[1]));
  const parts = segments.length >= 3 && !directStudentFolder ? segments.slice(1) : segments;
  const baseName = parts.length > 0 ? parts[parts.length - 1] : file.name;
  const ext = (baseName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const stem = ext ? baseName.slice(0, baseName.length - ext.length) : baseName;
  // 只有「确实是成员表里的学号」时才把目录当学号用，
  // 否则「我选的文件夹/04-activities.webp」这种会被误判
  const rawFolder = parts.length > 1 ? parts[0] : '';
  const folder = rawFolder && studentStmExists(rawFolder) ? rawFolder : '';

  // 0) 成员附加图片：<学号>/<页面key>/<文件名>.<扩展名>
  if (parts.length >= 3 && studentStmExists(parts[0]) && extraKeys.includes(parts[1]) && imageExts.includes(ext)) {
    return { kind: 'extra', studentId: parts[0], pageKey: parts[1], name: baseName };
  }

  // 1) 文件夹形式：<学号>/<槽位>.<扩展名>
  if (folder && keys.includes(stem) && imageExts.includes(ext)) {
    return { kind: 'image', dir: folder, name: `${stem}${ext}`, studentId: folder };
  }
  // 2) 共享图：<槽位>.<扩展名>
  if (!folder && keys.includes(stem) && imageExts.includes(ext)) {
    return { kind: 'image', dir: '', name: `${stem}${ext}` };
  }
  // 3) 成员专属图：<学号>-<槽位>.<扩展名> 或 <学号>_<槽位>.<扩展名>
  const matched = stem.match(/^(.+?)[-_](.+)$/);
  if (matched && keys.includes(matched[2]) && imageExts.includes(ext)) {
    return { kind: 'image', dir: matched[1], name: `${matched[2]}${ext}`, studentId: matched[1] };
  }
  // 4) 成员附加图片：<学号>__<页面key>__<文件名>.<扩展名>
  const extraSep = stem.indexOf('__');
  if (extraSep > 0 && imageExts.includes(ext)) {
    const studentId = stem.slice(0, extraSep);
    const rest = stem.slice(extraSep + 2);
    const pageKey = /^[A-Za-z0-9_-]{1,32}$/.test(studentId)
      ? extraKeys.find(key => rest.startsWith(`${key}__`))
      : '';
    const extraName = pageKey ? rest.slice(pageKey.length + 2) : '';
    if (pageKey && extraName) {
      return { kind: 'extra', studentId, pageKey, name: `${extraName}${ext}` };
    }
  }
  // 5) 背景音乐：<学号>.<扩展名>
  if (!folder && musicExts.includes(ext) && /^[A-Za-z0-9_-]{1,32}$/.test(stem)) {
    return { kind: 'music', dir: '', name: `${stem}${ext}`, studentId: stem };
  }
  return { error: '文件名无法识别：背景图用「槽位名」或「学号-槽位名」，附加图片用「学号__页面key__文件名」，音乐用「学号」命名' };
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
    const limit = parsed.kind === 'music' ? state.meta.limits.music : state.meta.limits.image;
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
  if (item.kind === 'extra') return `${item.studentId} 的附加图片（${item.pageKey}）→ images/extras/${item.studentId}/${item.pageKey}/${item.name}`;
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
  const purgePhotos = $('#batchPurgePhotos').checked;
  const purgeMusic = $('#batchPurgeMusic').checked;
  const ready = batchPlan.filter(item => item.status === 'ready');
  if (ready.length === 0) return;

  const progress = $('#batchProgress');
  let purgeNote = '';
  if (purgePhotos || purgeMusic) {
    try {
      const preview = await request('/media/purge', {
        method: 'POST',
        body: { photos: purgePhotos, music: purgeMusic, dryRun: true },
      });
      const parts = [];
      if (purgePhotos) {
        parts.push(`删除成员照片 ${preview.photos.files} 个文件（${preview.photos.dirs} 个目录 + ${preview.photos.extraStudents} 名成员的附加图）`);
      }
      if (purgeMusic) parts.push(`删除成员音乐 ${preview.music.files} 个文件`);
      parts.push(`随后上传 ${ready.length} 个文件${overwrite ? '（同名直接覆盖）' : ''}`);
      const ok = await confirmDialog(
        `将先清空：${parts.join('；')}。共享背景图、装饰图、字体不会被删除；文件删除不可撤销。继续吗？`,
        { title: '清空并上传', confirmText: '继续', danger: true }
      );
      if (!ok) return;
      progress.textContent = '正在清空成员媒体…';
      await request('/media/purge', {
        method: 'POST',
        body: { photos: purgePhotos, music: purgeMusic, dryRun: false },
      });
      purgeNote = '；已清空旧媒体';
      await loadMedia();
      await loadExtras();
    } catch (error) {
      if (error.status === 401) return showLogin('登录已过期，请重新登录');
      progress.textContent = '';
      return showError(error);
    }
  } else if (!await confirmDialog(`将上传 ${ready.length} 个文件${overwrite ? '（同名文件直接覆盖）' : '（遇到同名文件会跳过）'}，继续吗？`, { title: '批量上传', confirmText: '开始上传' })) {
    return;
  }

  batchUploading = true;
  renderBatchPlan();
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, item] of ready.entries()) {
    progress.textContent = `上传中 ${index + 1}/${ready.length}：${item.file.name}`;
    try {
      if (item.kind === 'extra') {
        await uploadExtraFor(item.studentId, item.pageKey, item.name, item.file, overwrite);
      } else {
        await upload({ kind: item.kind, dir: item.dir, name: item.name, file: item.file, overwrite });
      }
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
    + (failed ? `，失败 ${failed} 个` : '')
    + purgeNote;
  renderBatchPlan();
  await loadMedia();
  await loadExtras();
});

/* ---------- 导入 / 导出 ---------- */

function renderPreview(data) {
  const box = $('#previewBox');
  box.textContent = '';
  if (data.replace && data.replace.requested) {
    box.append(el('p', 'msg error',
      `覆盖导入：提交后将先删除现有 ${data.replace.existingTotal} 名成员，其中 ${data.replace.deleting} 人不在本次文件里；文件里还有 ${data.replace.errorRows} 行无法解析或校验失败，需先修好才能提交。`));
  }
  const counts = data.counts;
  box.append(el('p', 'msg ok', `共 ${counts.total} 行：新增 ${counts.insert} · 更新 ${counts.update} · 无变化 ${counts.unchanged} · 错误 ${counts.error}`));

  const items = el('div', 'preview-items');
  for (const item of data.items) {
    const row = el('div', 'preview-item');
    row.append(el('span', 'muted', `第 ${item.line} 行`));
    row.append(el('span', null, `${item.studentId || '—'} ${item.name || ''}`.trim()));
    row.append(el('span', `badge ${item.action}`, { insert: '新增', update: '更新', unchanged: '无变化', error: '错误' }[item.action] || item.action));
    if (item.changedFields && item.changedFields.length) row.append(el('span', 'muted', `改动：${item.changedFields.join('、')}`));
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
  const replace = $('#importReplaceRoster').checked;
  try {
    const data = await request('/import/text/preview', { method: 'POST', body: { text, replace } });
    state.preview = { source: 'text', text, file: null, replace, replaceInfo: data.replace };
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
  const replace = $('#importReplaceRoster').checked;
  if (replace !== state.preview.replace) {
    return await alertDialog('覆盖选项在预览后变了，请重新预览再导入');
  }
  const warning = replace
    ? `确认先清空全部现有成员（其中 ${state.preview.replaceInfo ? state.preview.replaceInfo.deleting : 0} 人不在本次文件里），再写入预览中的 ${state.preview.replaceInfo ? state.preview.replaceInfo.matched : 0} 条记录吗？`
    : '确认按预览结果写入数据库吗？';
  if (!await confirmDialog(warning, { title: replace ? '覆盖导入名单' : '确认导入', confirmText: replace ? '清空并写入' : '写入数据库', danger: replace })) return;
  try {
    const result = await request('/import/text', { method: 'POST', body: { text: state.preview.text, replace } });
    $('#commitTextBtn').disabled = true;
    await loadStudents();
    await loadMedia();
    const summary = `导入完成：写入 ${result.imported} 条，无变化 ${result.unchanged} 条，跳过 ${result.skipped.length} 条`
      + (result.cleared ? `；已清空旧名单 ${result.cleared} 人` : '');
    toast(summary, result.undo ? undoToast(result.undo) : {});
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
  const replace = $('#importReplaceRoster').checked;
  try {
    const data = await request(`/import/xlsx/preview${replace ? '?replace=1' : ''}`, {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    state.preview = { source: 'xlsx', text: '', file, replace, replaceInfo: data.replace };
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
  const replace = $('#importReplaceRoster').checked;
  if (replace !== state.preview.replace) {
    return await alertDialog('覆盖选项在预览后变了，请重新预览再导入');
  }
  const warning = replace
    ? `确认先清空全部现有成员（其中 ${state.preview.replaceInfo ? state.preview.replaceInfo.deleting : 0} 人不在本次文件里），再写入预览中的 ${state.preview.replaceInfo ? state.preview.replaceInfo.matched : 0} 条记录吗？`
    : '确认按预览结果写入数据库吗？';
  if (!await confirmDialog(warning, { title: replace ? '覆盖导入名单' : '确认导入', confirmText: replace ? '清空并写入' : '写入数据库', danger: replace })) return;
  try {
    const result = await request(`/import/xlsx${replace ? '?replace=1' : ''}`, {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    $('#commitExcelBtn').disabled = true;
    await loadStudents();
    await loadMedia();
    const summary = `导入完成：写入 ${result.imported} 条，无变化 ${result.unchanged} 条，跳过 ${result.skipped.length} 条`
      + (result.cleared ? `；已清空旧名单 ${result.cleared} 人` : '');
    toast(summary, result.undo ? undoToast(result.undo) : {});
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

// 覆盖选项变了，旧预览不再可信，必须重新预览
$('#importReplaceRoster').addEventListener('change', () => {
  $('#commitTextBtn').disabled = true;
  $('#commitExcelBtn').disabled = true;
});

/* ---------- 年度归档 ---------- */

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

async function loadArchives() {
  const data = await request('/archives');
  state.archives = data.items || [];
  renderArchives();
  if (!$('#archiveYear').value) $('#archiveYear').value = state.reportYear || '';
}

function renderArchives() {
  const box = $('#archiveList');
  box.textContent = '';
  if (state.archives.length === 0) {
    box.append(el('p', 'muted', '还没有归档快照。先点上方「归档当前年度」生成一份。'));
    return;
  }
  for (const item of state.archives) {
    const counts = item.counts || {};
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('strong', null, `${item.year} 年`));
    main.append(el('span', 'muted', `${counts.students || 0} 人 · 照片 ${counts.imageFiles || 0} 张 + 附加 ${counts.extraFiles || 0} 张 · 音乐 ${counts.musicFiles || 0} 首 · ${formatBytes(item.size)}`));
    main.append(el('span', 'muted', `生成于 ${item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '—'}`));
    const actions = el('div', 'row-actions');
    const download = el('a', 'ghost', '下载');
    download.href = `${API}/archives/${encodeURIComponent(item.year)}/download`;
    actions.append(download);
    actions.append(button('恢复', 'ghost', () => openYearRestore(item.year)));
    actions.append(button('删除', 'danger', () => removeArchive(item.year)));
    row.append(main, actions);
    box.append(row);
  }
}

async function createArchive() {
  const year = $('#archiveYear').value.trim();
  if (!/^\d{4}$/.test(year)) return alertDialog('年份需为四位数字（2000–2100）');
  const message = $('#archiveMessage');
  const btn = $('#createArchiveBtn');
  message.textContent = '正在打包名单与成员媒体，请勿关闭页面…';
  btn.disabled = true;
  try {
    let result;
    try {
      result = await request('/archives', { method: 'POST', body: { year } });
    } catch (error) {
      if (error.status !== 409) throw error;
      const overwrite = await confirmDialog(`${year} 年的归档已存在。覆盖后旧快照会被永久删除，继续吗？`, {
        title: '覆盖归档', confirmText: '覆盖旧快照', danger: true,
      });
      if (!overwrite) {
        message.textContent = '';
        return;
      }
      result = await request('/archives', { method: 'POST', body: { year, overwrite: true } });
    }
    message.textContent = `已生成 ${result.year} 年归档（${formatBytes(result.size)}）。`;
    toast('归档已生成');
    await loadArchives();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    message.textContent = '';
    showError(error);
  } finally {
    btn.disabled = false;
  }
}

async function removeArchive(year) {
  const ok = await confirmDialog(`删除 ${year} 年的归档包？快照文件会被永久删除，无法撤销。`, {
    title: '删除归档', confirmText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await request(`/archives/${encodeURIComponent(year)}`, { method: 'DELETE' });
    toast(`已删除 ${year} 年归档`);
    await loadArchives();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

function uploadArchiveFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/archives/upload?filename=${encodeURIComponent(file.name)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      $('#archiveUploadProgress').textContent = `上传中 ${Math.round(event.loaded / event.total * 100)}%（${formatBytes(event.loaded)} / ${formatBytes(event.total)}）`;
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const error = new Error((data && data.error) || `上传失败（${xhr.status}）`);
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('上传中断，请检查网络后重试'));
    xhr.send(file);
  });
}

async function openYearRestore(year) {
  try {
    const preview = await request(`/archives/${encodeURIComponent(year)}/preview`);
    state.restore = { type: 'year', year, preview };
    renderRestoreBox();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

function renderRestoreBox() {
  const restore = state.restore;
  if (!restore) {
    $('#restoreCard').hidden = true;
    return;
  }
  const preview = restore.preview || {};
  const incoming = preview.incoming || {};
  const current = preview.current || {};
  const photos = current.photos || {};
  const music = current.music || {};
  $('#restoreCard').hidden = false;
  $('#restoreSummary').textContent = `归档 ${preview.source ? preview.source.year : ''} 年：${incoming.students || 0} 人 · 照片 ${(incoming.imageFiles || 0) + (incoming.extraFiles || 0)} 个 · 音乐 ${incoming.musicFiles || 0} 个；当前 ${current.students || 0} 人 · 照片 ${photos.files || 0} 个 · 音乐 ${music.files || 0} 个。`;
  const warnings = preview.warnings || [];
  $('#restoreWarnings').textContent = warnings.join('；');
  $('#restoreWarnings').hidden = warnings.length === 0;
  $('#restoreKeepLabel').hidden = restore.type !== 'upload';
  $('#restoreKeep').checked = restore.type === 'upload';
  $('#restoreRoster').checked = true;
  $('#restorePhotos').checked = true;
  $('#restoreMusic').checked = true;
  $('#restoreSetYear').checked = true;
  $('#restoreMessage').hidden = true;
  $('#restoreConfirmBtn').disabled = false;
  $('#restoreCard').scrollIntoView({ block: 'nearest' });
}

async function cancelRestore() {
  const restore = state.restore;
  state.restore = null;
  $('#restoreCard').hidden = true;
  $('#archiveUploadProgress').textContent = '';
  if (restore && restore.type === 'upload') {
    try { await request(`/archives/upload/${encodeURIComponent(restore.token)}`, { method: 'DELETE' }); } catch {}
  }
}

async function confirmRestore() {
  const restore = state.restore;
  if (!restore) return;
  const categories = {
    roster: $('#restoreRoster').checked,
    photos: $('#restorePhotos').checked,
    music: $('#restoreMusic').checked,
  };
  if (!categories.roster && !categories.photos && !categories.music) return alertDialog('至少选择名单、照片、音乐中的一类');
  const setReportYear = $('#restoreSetYear').checked;
  const keep = restore.type === 'upload' && $('#restoreKeep').checked;
  const preview = restore.preview || {};
  const incoming = preview.incoming || {};
  const current = preview.current || {};
  const parts = [];
  if (categories.roster) parts.push(`清空现有 ${current.students || 0} 名成员并写入 ${incoming.students || 0} 人（所有成员会被注销登录）`);
  if (categories.photos) {
    parts.push(`清空当前 ${((current.photos || {}).files) || 0} 个成员照片文件并写入 ${(incoming.imageFiles || 0) + (incoming.extraFiles || 0)} 个`);
  }
  if (categories.music) parts.push(`清空当前 ${((current.music || {}).files) || 0} 首成员音乐并写入 ${incoming.musicFiles || 0} 首`);
  if (setReportYear) parts.push(`把年度改为 ${preview.source ? preview.source.year : ''}`);

  const ok = await confirmDialog(`将执行：${parts.join('；')}。文件操作不可撤销，继续吗？`, {
    title: '恢复归档', confirmText: '开始恢复', danger: true,
  });
  if (!ok) return;

  $('#restoreConfirmBtn').disabled = true;
  $('#restoreMessage').hidden = true;
  try {
    const body = {
      ...categories,
      setReportYear,
      keep,
      overwrite: false,
    };
    if (restore.type === 'upload') body.token = restore.token;
    else body.year = restore.year;

    let result;
    try {
      result = await request('/archives/restore', { method: 'POST', body });
    } catch (error) {
      if (error.status !== 409 || !keep) throw error;
      const overwrite = await confirmDialog('该年份的归档已存在，覆盖旧快照后继续？', {
        title: '覆盖归档', confirmText: '覆盖并恢复', danger: true,
      });
      if (!overwrite) throw error;
      result = await request('/archives/restore', { method: 'POST', body: { ...body, overwrite: true } });
    }

    state.restore = null;
    $('#restoreCard').hidden = true;
    $('#archiveUploadProgress').textContent = '';
    const roster = result.categories.roster || {};
    const photos = result.categories.photos || {};
    const music = result.categories.music || {};
    const summary = [
      categories.roster ? `名单 ${roster.inserted || 0} 人` : '',
      categories.photos ? `照片 ${photos.files || 0} 个` : '',
      categories.music ? `音乐 ${music.files || 0} 首` : '',
    ].filter(Boolean).join(' · ');
    toast(`恢复完成：${summary}${roster.sessionsRemoved ? `；${roster.sessionsRemoved} 个成员会话已注销` : ''}`);
    await loadStudents();
    await loadMedia();
    await loadExtras();
    await loadArchives();
    if (result.setReportYear) {
      state.meta = await request('/meta');
      state.reportYear = state.meta.reportYear || '';
      $('#reportYearInput').value = state.reportYear;
      $('#archiveYear').value = state.reportYear;
    }
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    if (error.status === 410) {
      state.restore = null;
      $('#restoreCard').hidden = true;
    }
    $('#restoreMessage').textContent = error.message;
    $('#restoreMessage').hidden = false;
  } finally {
    $('#restoreConfirmBtn').disabled = false;
  }
}

$('#createArchiveBtn').addEventListener('click', createArchive);
$('#refreshArchivesBtn').addEventListener('click', () => loadArchives().catch(showError));
$('#uploadArchiveBtn').addEventListener('click', async () => {
  const input = $('#archiveUploadInput');
  const file = input.files && input.files[0];
  if (!file) return alertDialog('请先选择归档 zip');
  const btn = $('#uploadArchiveBtn');
  btn.disabled = true;
  $('#archiveUploadName').textContent = file.name;
  $('#archiveUploadProgress').textContent = '正在上传…';
  try {
    const data = await uploadArchiveFile(file);
    state.restore = { type: 'upload', token: data.token, preview: data.preview };
    renderRestoreBox();
    $('#archiveUploadProgress').textContent = '上传完成，请确认恢复选项。';
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    $('#archiveUploadProgress').textContent = '';
    showError(error);
  } finally {
    btn.disabled = false;
    input.value = '';
  }
});
$('#restoreConfirmBtn').addEventListener('click', confirmRestore);
$('#restoreCancelBtn').addEventListener('click', cancelRestore);

/* ---------- 外观 / 主题 ---------- */

const FALLBACK_FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const DEFAULT_THEME_CONFIG = {
  base: { accent: '#7dd3fc', accent2: '#bcd6ff', scrim: 0.45, scrimColor: '#060a14' },
  fonts: { display: null, body: null },
  motion: { notes: true, ambient: true },
  pages: {},
  layout: {},
};

const loadedPreviewFonts = new Set();

// 页面键 → 面板里显示的名字（值仍是 data-bg 的键）
function pageName(key) {
  const page = ((state.meta && state.meta.pages) || []).find(item => item.key === key);
  return page ? page.title : key;
}

function renderThemePageOptions() {
  const select = $('#t_page');
  if (!select) return;
  const previous = select.value;
  select.textContent = '';
  for (const key of ((state.meta && state.meta.pageKeys) || [])) {
    select.append(new Option(pageName(key), key));
  }
  if (previous && ((state.meta && state.meta.pageKeys) || []).includes(previous)) select.value = previous;
}

function defaultThemeConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_THEME_CONFIG));
}

function themeById(id) {
  return state.themes.find(theme => theme.id === id) || null;
}

function showThemeMessage(text) {
  for (const id of ['themeMessage', 'layoutMessage']) {
    const message = $(`#${id}`);
    if (!message) continue;
    message.textContent = text;
    message.hidden = false;
  }
}

function hideThemeMessages() {
  for (const id of ['themeMessage', 'layoutMessage']) {
    const message = $(`#${id}`);
    if (message) message.hidden = true;
  }
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
  // 字体就绪后重新应用一次，右侧预览不会停在系统默认字体
  if (state.themeDraft) updateThemePreview();
  if (isLayoutMode()) renderLayoutEditor();
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
  $('#t_ambient').checked = config.motion.ambient !== false;

  renderThemePageOptions();
  renderPageFields();

  renderFontOptions();
  renderFontStates();
  renderPageOverrides();
  updateThemePreview();

  const usage = theme.isDefault ? '默认主题' : `使用 ${theme.usage} 人`;
  $('#themeMeta').textContent = `${theme.name} · ${usage}${theme.invalid ? ' · 配置损坏，已按默认值读取' : ''}`;

  if (state.themeMode === 'layout') renderLayoutEditor();
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

$('#t_ambient').addEventListener('change', (event) => {
  if (!state.themeDraft) return;
  state.themeDraft.motion.ambient = event.target.checked;
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
  toast(`已保存「${pageName(key)}」的单独设置，记得保存主题`, { type: 'info' });
});

$('#t_pageClear').addEventListener('click', () => {
  if (!state.themeDraft) return;
  const key = $('#t_page').value;
  if (!key) return;
  delete state.themeDraft.pages[key];
  renderPageFields();
  renderPageOverrides();
  updateThemePreview();
  toast(`「${pageName(key)}」已恢复为全局设置`, { type: 'info' });
});

function renderPageOverrides() {
  const box = $('#t_pageList');
  box.textContent = '';
  if (!state.themeDraft) return;
  const pages = state.themeDraft.pages || {};
  const keys = Object.keys(pages);
  if (keys.length === 0) {
    box.append(el('p', 'muted', '还没有单独调整的页面'));
    return;
  }
  for (const key of keys) {
    const override = pages[key];
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('strong', null, pageName(key)));
    const parts = [];
    if (override.accent) parts.push(`装饰 ${override.accent}`);
    if (override.accent2) parts.push(`数字 ${override.accent2}`);
    if (typeof override.scrim === 'number') parts.push(`压暗 ${override.scrim}`);
    if (override.scrimColor) parts.push(`压暗色 ${override.scrimColor}`);
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
  // 字体列表还没加载时不要渲染：此时预设为空，会把主题里已选的字体误判成已删除
  if (!state.themeDraft || !state.themeFonts) return;
  const presets = state.themeFonts.presets || [];
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
  if (!state.themeFonts) return;
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
  hideThemeMessages();
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
  if (!studentId) return alertDialog('请先选择预览成员');
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

function openThemeAssign(item) {
  state.themeAssignStudentId = item.studentId;
  $('#themeAssignSummary').textContent = `给 ${item.name}（${item.studentId}）单独设置主题`;
  renderThemeSelects();
  $('#themeAssignSelect').value = item.theme || '';
  $('#themeAssignOverlay').hidden = false;
}

$('#batchThemeBtn').addEventListener('click', () => {
  if (state.selected.size === 0) return;
  state.themeAssignStudentId = '';
  $('#themeAssignSummary').textContent = `将给已勾选的 ${state.selected.size} 位成员应用主题`;
  renderThemeSelects();
  $('#themeAssignSelect').value = '';
  $('#themeAssignOverlay').hidden = false;
});

$('#themeAssignCancel').addEventListener('click', () => {
  state.themeAssignStudentId = '';
  $('#themeAssignOverlay').hidden = true;
});

$('#themeAssignForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const singleId = state.themeAssignStudentId;
  const ids = singleId ? [singleId] : Array.from(state.selected);
  if (ids.length === 0) return;
  const themeId = $('#themeAssignSelect').value;
  const theme = themeId ? themeById(themeId) : null;
  const label = theme ? theme.name : '默认主题';
  const who = singleId
    ? `给 ${(state.students.find(item => item.studentId === singleId) || {}).name || singleId} 应用「${label}」`
    : `给这 ${ids.length} 位成员应用「${label}」`;
  if (!await confirmDialog(`确定${who}吗？10 秒内可在右下角提示里撤销。`, { title: '应用主题', confirmText: '应用' })) return;
  try {
    const result = await request('/students/batch', { method: 'POST', body: { studentIds: ids, set: { theme: themeId } } });
    $('#themeAssignOverlay').hidden = true;
    state.themeAssignStudentId = '';
    if (singleId) {
      await loadStudents();
    } else {
      clearSelection();
      await loadStudents();
    }
    toast(`已为 ${result.updated} 位成员应用主题`, undoToast(result.undo));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

/* ---------- 页面排版编辑器 ---------- */

const LAYOUT_W = 390;
const LAYOUT_H = 844;
const LAYOUT_PLACEHOLDERS = [
  'name', 'department', 'joinDays', 'volunteerHours', 'activityCount', 'partner', 'message',
  'reportYear', 'activities', 'activity1Name', 'activity1Date', 'activity1Work',
  'activity2Name', 'activity2Date', 'activity2Work', 'partnerCount', 'partnerLine', 'partnerCaption',
  'keyword', 'keywordReason',
];
const LAYOUT_NUMERIC = new Set(['joinDays', 'volunteerHours', 'activityCount', 'partnerCount']);
const LAYOUT_FALLBACK_SAMPLE = {
  name: '示例成员', department: '示例部门', joinDays: 365, volunteerHours: 120, activityCount: 12,
  activities: ['迎新晚会', '支教'],
  activity1Name: '迎新晚会', activity1Date: '2026-09-10', activity1Work: '现场统筹',
  activity2Name: '支教', activity2Date: '2026-07-15', activity2Work: '课程设计',
  partnerCount: 12, partnerLine: '这一年，你与 12 位伙伴并肩同行。', partnerCaption: '这一年，你与伙伴并肩同行。',
  keyword: '现场定心丸', keywordReason: '每次活动都能稳住场面', message: '愿你保持热爱，继续向前。',
  reportYear: String(new Date().getFullYear()),
};
// 成员数据为空时的兜底，与成员端默认版式保持一致
const LAYOUT_FALLBACK_TEXT = {
  partnerLine: '这一年，你和伙伴们并肩同行。',
  partnerCaption: '这一年，你和伙伴们并肩同行。',
  message: '（暂无寄语）',
  keyword: '待揭晓',
  keywordReason: '',
  activity1Name: '（活动待补充）',
  activity1Date: '',
  activity1Work: '（工作内容待补充）',
  activity2Name: '（活动待补充）',
  activity2Date: '',
  activity2Work: '（工作内容待补充）',
};
const editorFontPromises = new Map();

const layoutId = () => `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clampLayout = (value, min, max) => Math.min(Math.max(value, min), max);
const isLayoutMode = () => state.themeMode === 'layout';

function layoutPageElements(key = state.layoutPageKey) {
  const page = state.themeDraft && state.themeDraft.layout && state.themeDraft.layout[key];
  return page && Array.isArray(page.elements) ? page.elements : [];
}

function setLayoutPageElements(key, elements) {
  if (!state.themeDraft) return;
  if (!state.themeDraft.layout) state.themeDraft.layout = {};
  if (elements.length > 0) state.themeDraft.layout[key] = { elements };
  else delete state.themeDraft.layout[key];
}

function selectedLayoutElement() {
  return layoutPageElements().find(item => item.id === state.layoutSelectedId) || null;
}

function layoutSubstitute(text, sample) {
  return String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!LAYOUT_PLACEHOLDERS.includes(key)) return '';
    const value = sample ? sample[key] : '';
    if (key === 'activities') {
      const names = Array.isArray(value) ? value.filter(Boolean) : (value ? [String(value)] : []);
      return names.length ? names.join('、') : '（活动记录待补充）';
    }
    if (value === null || value === undefined || value === '') {
      if (LAYOUT_NUMERIC.has(key)) return '—';
      return LAYOUT_FALLBACK_TEXT[key] || '';
    }
    return String(value);
  });
}

function layoutSample() {
  const data = state.layoutPreviewData;
  if (!data) return LAYOUT_FALLBACK_SAMPLE;
  return {
    name: data.name,
    department: data.department,
    joinDays: data.joinDays,
    volunteerHours: data.volunteerHours,
    activityCount: data.activityCount,
    activities: data.activities,
    activity1Name: data.activity1Name ?? (data.activity1 && data.activity1.name),
    activity1Date: data.activity1Date ?? (data.activity1 && data.activity1.date),
    activity1Work: data.activity1Work ?? (data.activity1 && data.activity1.work),
    activity2Name: data.activity2Name ?? (data.activity2 && data.activity2.name),
    activity2Date: data.activity2Date ?? (data.activity2 && data.activity2.date),
    activity2Work: data.activity2Work ?? (data.activity2 && data.activity2.work),
    partnerCount: data.partnerCount,
    partnerLine: data.partnerLine,
    partnerCaption: data.partnerCaption,
    keyword: data.keyword,
    keywordReason: data.keywordReason,
    message: data.message,
    reportYear: data.reportYear,
    extras: data.extras || {},
  };
}

function defaultLayoutTemplate(page) {
  const type = page && page.type;
  const config = (page && page.config) || {};
  const line = (id, y, text, opts = {}) => ({
    id, type: 'text', x: 25, y, w: 340, text,
    unit: opts.unit || '', font: opts.font || 'body', size: opts.size || 15, weight: opts.weight || 400,
    color: '#f4f7ff', align: opts.align || 'center', lineHeight: opts.lineHeight || 1.4,
    opacity: opts.opacity === undefined ? 0.72 : opts.opacity, z: 1,
  });
  const name = (id, y, text, size = 42) => line(id, y, text, { font: 'display', size, weight: 700, lineHeight: 1.25, opacity: 1 });
  const number = (id, y, text, unit) => line(id, y, text, { unit, font: 'display', size: 76, weight: 800, lineHeight: 1, opacity: 1 });
  const photo = (id, slot, opts = {}) => ({
    id, type: 'extra', slot,
    x: opts.x === undefined ? 25 : opts.x, y: opts.y === undefined ? 140 : opts.y,
    w: opts.w || 160, h: opts.h || 120, fit: opts.fit || 'cover', radius: opts.radius === undefined ? 12 : opts.radius,
    opacity: 1, z: 1,
  });

  if (type === 'cover') {
    return [
      line('t-year', 337, '{{reportYear}} 年度回顾'),
      name('t-name', 377, '{{name}}'),
      line('t-dept', 437, '{{department}}'),
      line('t-dedication', 487, '这一年，你的每一份付出，都值得被记录。', { size: 14, opacity: 0.6 }),
      line('t-hint', 600, '上滑继续', { size: 13, opacity: 0.5 }),
    ];
  }
  if (type === 'stat') {
    if (config.field === 'activityCount') {
      return [
        line('t-line', 330, '这一年，你参与了'),
        number('t-num', 372, '{{activityCount}}', '次'),
        line('t-sub', 490, '活动，每一次都在场'),
      ];
    }
    return [
      line('t-line', 330, '这一年，你累计贡献了'),
      number('t-num', 372, '{{volunteerHours}}', '小时'),
      line('t-sub', 490, '的志愿服务'),
    ];
  }
  if (type === 'activities') {
    return [
      line('t-title', 312, '活动足迹'),
      line('t-line', 357, '这一年，你参与了'),
      number('t-num', 397, '{{activityCount}}', '次活动'),
      line('t-list', 512, '{{activities}}', { size: 13, lineHeight: 1.7 }),
      line('t-sub', 575, '每一次都在场'),
    ];
  }
  if (type === 'memory') {
    const index = config.index === 2 ? 2 : 1;
    return [
      line('t-title', 135, '活动回忆'),
      name('t-name', 185, `{{activity${index}Name}}`, 28),
      line('t-date', 250, `{{activity${index}Date}}`, { size: 13, opacity: 0.6 }),
      line('t-work', 290, `{{activity${index}Work}}`, { size: 15, lineHeight: 1.8, opacity: 0.85 }),
      photo('t-photo-1', 1, { x: 25, y: 415, w: 160, h: 170 }),
      photo('t-photo-2', 2, { x: 205, y: 415, w: 160, h: 170 }),
      line('t-sub', 685, index === 1 ? '定格一次投入' : '再看一个瞬间'),
    ];
  }
  if (type === 'partners') {
    return [
      line('t-line', 200, '同行伙伴'),
      number('t-num', 240, '{{partnerCount}}', '位'),
      line('t-sub', 360, '{{partnerCaption}}'),
      photo('t-photo-1', 1, { x: 55, y: 440, w: 280, h: 200, radius: 14 }),
    ];
  }
  if (type === 'keyword') {
    return [
      line('t-line', 330, '你的年度关键词是'),
      name('t-keyword', 378, '{{keyword}}'),
      line('t-reason', 458, '{{keywordReason}}', { size: 14, lineHeight: 1.8 }),
    ];
  }
  if (type === 'message') {
    return [
      line('t-line', 190, '部长想对你说'),
      line('t-message', 245, '{{message}}', { size: 17, lineHeight: 2, align: 'left', opacity: 1 }),
      line('t-closing', 640, '感谢这一年的同行，期待下一程的你', { size: 13, opacity: 0.6 }),
    ];
  }
  return [];
}

function estimatedTextHeight(element) {
  return Math.max(56, Math.round(element.size * element.lineHeight * 2.2));
}

// 默认放在「承担工作 / 伙伴文案」下面；已有图片槽位时沿用它的高度
function defaultExtraSlots(page, elements = []) {
  if (!page) return [];
  const existing = elements.find(element => element.type === 'extra');
  if (page.type === 'memory') {
    const work = elements.find(element => element.type === 'text' && /activity[12]Work/.test(element.text || ''));
    const sub = elements.find(element => element.type === 'text' && (element.id === 't-sub' || /定格一次投入|再看一个瞬间/.test(element.text || '')));
    let y = existing ? existing.y : (work ? work.y + estimatedTextHeight(work) + 14 : 380);
    let h = existing ? existing.h : 170;
    if (!existing && sub && sub.y > y + 60) h = Math.min(h, sub.y - y - 14);
    h = Math.max(60, h);
    y = Math.min(y, 844 - h - 44);
    return [
      { slot: 1, x: 25, y, w: 160, h, radius: 12 },
      { slot: 2, x: 205, y, w: 160, h, radius: 12 },
    ];
  }
  if (page.type === 'partners') {
    const caption = elements.find(element => element.type === 'text' && /partnerCaption/.test(element.text || ''));
    let y = existing ? existing.y : (caption ? caption.y + estimatedTextHeight(caption) + 14 : 400);
    const h = existing ? existing.h : 200;
    y = Math.min(y, 844 - h - 44);
    return [{ slot: 1, x: 55, y, w: 280, h, radius: 14 }];
  }
  return [];
}

function currentLayoutPage() {
  return (state.meta.pages || []).find(page => page.key === state.layoutPageKey) || null;
}

function makeExtraElement(slot, fallback) {
  return {
    id: layoutId(), type: 'extra', slot,
    x: fallback ? fallback.x : 95, y: fallback ? fallback.y : 340,
    w: fallback ? fallback.w : 200, h: fallback ? fallback.h : 140,
    fit: 'cover', radius: fallback && fallback.radius !== undefined ? fallback.radius : 12,
    opacity: 1, z: 1,
  };
}

function addLayoutExtra() {
  if (!state.themeDraft) return;
  const elements = layoutPageElements();
  const used = new Set(elements.filter(element => element.type === 'extra').map(element => element.slot));
  if (used.size >= 6) return toast('一页最多 6 个图片槽位', { type: 'info' });
  let slot = 1;
  while (used.has(slot)) slot += 1;
  const defaults = defaultExtraSlots(currentLayoutPage(), elements);
  const element = makeExtraElement(slot, defaults.find(item => item.slot === slot));
  elements.push(element);
  state.layoutSelectedId = element.id;
  renderLayoutEditor();
  setLayoutSideTab('props');
  toast(`已添加图片槽位 ${slot}，可拖动或缩放`);
}

function fillLayoutExtras() {
  if (!state.themeDraft) return;
  const elements = layoutPageElements();
  const defaults = defaultExtraSlots(currentLayoutPage(), elements);
  if (defaults.length === 0) return toast('这一页没有默认图片槽位，请用「添加图片槽位」', { type: 'info' });
  const used = new Set(elements.filter(element => element.type === 'extra').map(element => element.slot));
  const added = defaults.filter(item => !used.has(item.slot));
  if (added.length === 0) return toast('图片槽位已经齐了', { type: 'info' });
  for (const item of added) elements.push(makeExtraElement(item.slot, item));
  state.layoutSelectedId = elements[elements.length - 1].id;
  renderLayoutEditor();
  setLayoutSideTab('props');
  toast(`已补齐 ${added.length} 个图片槽位`);
}

function editorFontUrl(ref) {
  const theme = state.themeDraft;
  if (!theme || !ref) return null;
  const presets = (state.themeFonts && state.themeFonts.presets) || [];
  if (ref === 'display' || ref === 'body') {
    const choice = theme.fonts[ref];
    if (!choice) return null;
    if (choice === 'custom') {
      const custom = state.themeFonts && state.themeFonts.custom && state.themeFonts.custom[ref];
      return custom ? custom.url : null;
    }
    const preset = presets.find(item => item.id === choice);
    return preset ? preset.url : null;
  }
  const preset = presets.find(item => item.id === ref);
  return preset ? preset.url : null;
}

function ensureEditorFont(url, family) {
  if (!url || typeof FontFace === 'undefined') return;
  const key = `${family}|${url}`;
  if (editorFontPromises.has(key)) return;
  editorFontPromises.set(key, (async () => {
    try {
      const face = new FontFace(family, `url("${url}")`);
      await Promise.race([
        face.load(),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      document.fonts.add(face);
    } catch {
      // 回退系统字体
    }
  })());
}

function adminFontFamily(ref) {
  const url = editorFontUrl(ref);
  if (!url) return FALLBACK_FONT;
  const family = ref === 'display' ? 'EditorDisplay'
    : ref === 'body' ? 'EditorBody'
      : `EditorPreset-${ref}`;
  ensureEditorFont(url, family);
  return `"${family}", ${FALLBACK_FONT}`;
}

function renderLayoutPageSelect() {
  const select = $('#layoutPage');
  if (!select || !state.meta) return;
  const current = state.layoutPageKey;
  select.textContent = '';
  for (const key of state.meta.pageKeys) select.append(new Option(pageName(key), key));
  if (state.meta.pageKeys.includes(current)) select.value = current;
  else {
    state.layoutPageKey = state.meta.pageKeys[0] || '01-cover';
    select.value = state.layoutPageKey;
  }
}

function applyEditorScale() {
  const wrap = $('#layoutCanvasWrap');
  const canvas = $('#layoutCanvas');
  if (!wrap || !canvas) return;
  const maxHeight = Math.min(window.innerHeight * 0.72, LAYOUT_H);
  const scale = Math.min(wrap.clientWidth / LAYOUT_W, maxHeight / LAYOUT_H) || 1;
  state.layoutScale = scale;
  wrap.style.height = `${Math.round(LAYOUT_H * scale)}px`;
  canvas.style.transform = `scale(${scale})`;
}

function layoutResizeHandle(element, node) {
  const handle = document.createElement('span');
  handle.className = 'layout-resize-handle';
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startLayoutResize(event, element, node, handle);
  });
  return handle;
}

function layoutEditorNode(element, sample) {
  const node = document.createElement('div');
  node.className = `layout-editor-el layout-${element.type}`;
  node.dataset.id = element.id;
  node.style.left = `${element.x}px`;
  node.style.top = `${element.y}px`;
  node.style.width = `${element.w}px`;
  node.style.opacity = String(element.opacity);
  node.style.zIndex = String(element.z);

  if (element.type === 'image' || element.type === 'extra') {
    node.style.height = `${element.h}px`;
    let src = element.src;
    if (element.type === 'extra') {
      const photos = (sample && sample.extras && sample.extras[state.layoutPageKey]) || [];
      const photo = photos[Math.max(0, (element.slot || 1) - 1)];
      src = photo ? photo.url : '';
    }
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = element.fit;
      if (element.radius) img.style.borderRadius = `${element.radius}px`;
      node.append(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'layout-photo-placeholder';
      placeholder.textContent = `图片槽位 ${element.slot || 1}（预览成员暂无）`;
      node.append(placeholder);
    }
  } else {
    node.style.color = element.color;
    node.style.fontSize = `${element.size}px`;
    node.style.fontWeight = String(element.weight);
    node.style.textAlign = element.align;
    node.style.lineHeight = String(element.lineHeight);
    node.style.fontFamily = adminFontFamily(element.font);
    const activityOnly = /^\{\{\s*activities\s*\}\}$/.test(String(element.text || '').trim());
    if (activityOnly) {
      node.classList.add('layout-activity-list');
      const names = sample && Array.isArray(sample.activities) ? sample.activities.filter(Boolean) : [];
      if (names.length === 0) {
        node.textContent = '（活动记录待补充）';
      } else {
        for (const name of names) {
          const tag = document.createElement('span');
          tag.className = 'activity-tag';
          tag.textContent = name;
          node.append(tag);
        }
      }
    } else {
      node.textContent = layoutSubstitute(element.text, sample);
    }
    if (element.unit) {
      const unit = document.createElement('small');
      unit.textContent = element.unit;
      unit.style.fontSize = '0.24em';
      unit.style.marginLeft = '0.2em';
      unit.style.opacity = '0.72';
      node.append(unit);
    }
  }

  node.addEventListener('pointerdown', (event) => startLayoutDrag(event, element, node));
  if (element.id === state.layoutSelectedId) {
    node.classList.add('is-selected');
    node.append(layoutResizeHandle(element, node));
  }
  return node;
}

function startLayoutDrag(event, element, node) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  state.layoutSelectedId = element.id;
  for (const other of document.querySelectorAll('.layout-editor-el')) {
    other.classList.toggle('is-selected', other === node);
  }
  if (!node.querySelector('.layout-resize-handle')) node.append(layoutResizeHandle(element, node));
  renderLayoutProperties();
  setLayoutSideTab('props');

  const rect = $('#layoutCanvas').getBoundingClientRect();
  const scale = rect.width / LAYOUT_W || 1;
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = element.x;
  const originY = element.y;
  let moved = false;

  node.setPointerCapture(event.pointerId);
  const onMove = (moveEvent) => {
    moved = true;
    element.x = Math.round(clampLayout(originX + (moveEvent.clientX - startX) / scale, 0, LAYOUT_W - element.w));
    element.y = Math.round(clampLayout(originY + (moveEvent.clientY - startY) / scale, 0, LAYOUT_H - 20));
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
  };
  const onEnd = () => {
    node.removeEventListener('pointermove', onMove);
    node.removeEventListener('pointerup', onEnd);
    node.removeEventListener('pointercancel', onEnd);
    if (moved) renderLayoutEditor();
  };
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onEnd);
  node.addEventListener('pointercancel', onEnd);
}

function startLayoutResize(event, element, node, handle) {
  const rect = $('#layoutCanvas').getBoundingClientRect();
  const scale = rect.width / LAYOUT_W || 1;
  const startX = event.clientX;
  const startY = event.clientY;
  const originW = element.w;
  const originH = element.h;
  let moved = false;

  handle.setPointerCapture(event.pointerId);
  const onMove = (moveEvent) => {
    moved = true;
    element.w = Math.round(clampLayout(originW + (moveEvent.clientX - startX) / scale, 40, LAYOUT_W - element.x));
    node.style.width = `${element.w}px`;
    if (element.type === 'image' || element.type === 'extra') {
      element.h = Math.round(clampLayout(originH + (moveEvent.clientY - startY) / scale, 20, LAYOUT_H - element.y));
      node.style.height = `${element.h}px`;
    }
  };
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    if (moved) renderLayoutEditor();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function renderLayoutCanvas() {
  const canvas = $('#layoutCanvas');
  if (!canvas || !state.themeDraft) return;
  canvas.querySelectorAll('.layout-editor-el').forEach(node => node.remove());
  const key = state.layoutPageKey;
  const theme = state.themeDraft;
  const bg = $('#layoutBg');
  const url = state.layoutPreviewData && state.layoutPreviewData.backgrounds && state.layoutPreviewData.backgrounds[key];
  bg.style.backgroundImage = url ? `url("${url}")` : 'linear-gradient(165deg, #0d1b3e 0%, #16255c 55%, #233a86 100%)';
  const override = (theme.pages && theme.pages[key]) || {};
  const scrimColor = override.scrimColor || theme.base.scrimColor;
  const scrim = typeof override.scrim === 'number' ? override.scrim : theme.base.scrim;
  canvas.style.setProperty('--scrim-rgb', hexToRgb(scrimColor) || '6, 10, 20');
  canvas.style.setProperty('--scrim-alpha', String(scrim));
  const sample = layoutSample();
  for (const element of layoutPageElements(key)) canvas.append(layoutEditorNode(element, sample));
  applyEditorScale();
}

function renderLayoutElementList() {
  const box = $('#layoutElementList');
  if (!box) return;
  box.textContent = '';
  const elements = layoutPageElements();
  if (elements.length === 0) {
    box.append(el('p', 'muted', '还没有元素'));
    return;
  }
  for (const element of elements) {
    const row = el('div', `row${element.id === state.layoutSelectedId ? ' is-selected' : ''}`);
    const main = el('div', 'row-main');
    const isExtra = element.type === 'extra';
    const label = isExtra
      ? `图片槽位 ${element.slot || 1}`
      : element.type === 'image'
        ? '装饰图片'
        : (element.text || '（空文字）');
    const kind = isExtra ? '图片槽位' : element.type === 'image' ? '装饰图片' : '文字';
    main.append(el('strong', null, String(label).slice(0, 24)));
    main.append(el('span', 'muted', `${kind} · x ${Math.round(element.x)} · y ${Math.round(element.y)} · 宽 ${Math.round(element.w)}`));
    row.append(main);
    row.addEventListener('click', () => {
      state.layoutSelectedId = element.id;
      renderLayoutEditor();
      setLayoutSideTab('props');
    });
    box.append(row);
  }
}

function renderLayoutProperties() {
  const panel = $('#layoutProps');
  if (!panel) return;
  const element = selectedLayoutElement();
  const empty = $('#layoutPropsEmpty');
  const selectedLabel = $('#layoutSelectedLabel');
  if (!element) {
    panel.hidden = true;
    if (empty) empty.hidden = false;
    if (selectedLabel) selectedLabel.textContent = '';
    return;
  }
  if (empty) empty.hidden = true;
  if (selectedLabel) {
    const name = element.type === 'extra'
      ? `图片槽位 ${element.slot || 1}`
      : element.type === 'image' ? '装饰图片' : String(element.text || '（空文字）').slice(0, 20);
    selectedLabel.textContent = `当前：${name}`;
  }
  const isText = element.type === 'text';
  const isExtra = element.type === 'extra';
  panel.hidden = false;

  for (const id of ['layoutTextRow', 'layoutUnitRow']) {
    const row = $(`#${id}`);
    if (row) row.hidden = !isText;
  }
  for (const id of ['layoutFont', 'layoutSize', 'layoutWeight', 'layoutColor', 'layoutAlign']) {
    const input = $(`#${id}`);
    const label = input && input.closest('label');
    if (label) label.hidden = !isText;
  }
  const imageProps = $('#layoutImageProps');
  if (imageProps) imageProps.hidden = isText;
  const slotRow = $('#layoutSlotRow');
  if (slotRow) slotRow.hidden = !isExtra;

  if (isText) {
    $('#layoutText').value = element.text || '';
    $('#layoutUnit').value = element.unit || '';
    const fontSelect = $('#layoutFont');
    fontSelect.textContent = '';
    fontSelect.append(new Option('系统默认', ''));
    fontSelect.append(new Option('主题标题字体', 'display'));
    fontSelect.append(new Option('主题正文字体', 'body'));
    for (const preset of (state.themeFonts && state.themeFonts.presets) || []) {
      fontSelect.append(new Option(preset.name, preset.id));
    }
    fontSelect.value = element.font || '';
    $('#layoutSize').value = String(element.size);
    $('#layoutWeight').value = String(element.weight);
    $('#layoutColor').value = element.color;
    $('#layoutColorHex').value = element.color.toUpperCase();
    $('#layoutAlign').value = element.align;
  } else {
    $('#layoutImageInfo').textContent = isExtra
      ? `图片槽位 ${element.slot || 1}（按归属页面从该成员上传的附加图片里取第 ${element.slot || 1} 张）`
      : element.src;
    if (isExtra) $('#layoutSlot').value = String(element.slot || 1);
    $('#layoutFit').value = element.fit;
    $('#layoutRadius').value = String(element.radius || 0);
  }
  $('#layoutX').value = String(Math.round(element.x));
  $('#layoutY').value = String(Math.round(element.y));
  $('#layoutW').value = String(Math.round(element.w));
  $('#layoutHRow').hidden = isText;
  if (!isText) $('#layoutH').value = String(Math.round(element.h));
  $('#layoutOpacity').value = String(element.opacity);
  $('#layoutZ').value = String(element.z);
}

function updateSelectedLayoutElement(patch) {
  const element = selectedLayoutElement();
  if (!element) return;
  Object.assign(element, patch);
  renderLayoutCanvas();
  renderLayoutElementList();
}

function renderLayoutEditor() {
  if (!isLayoutMode() || !state.themeDraft) return;
  renderLayoutPageSelect();
  const page = currentLayoutPage();
  if (page && layoutPageElements().length === 0) {
    setLayoutPageElements(state.layoutPageKey, defaultLayoutTemplate(page));
  }
  if (!layoutPageElements().some(element => element.id === state.layoutSelectedId)) state.layoutSelectedId = '';
  renderLayoutCanvas();
  const key = state.layoutPageKey;
  const count = layoutPageElements(key).length;
  const source = state.layoutPreviewData ? '背景与示例数据来自预览成员' : '暂无预览成员，使用示例数据';
  $('#layoutMeta').textContent = `${pageName(key)} · ${count} 个元素（${source}）`;
  renderLayoutElementList();
  renderLayoutProperties();
  if (state.meta && state.meta.pageKeys) {
    $('#layoutMeta').textContent += ` · 占位符：${LAYOUT_PLACEHOLDERS.map(key => `{{${key}}}`).join(' ')}`;
  }
}

async function loadLayoutPreview(force = false) {
  if (!isLayoutMode()) return;
  const studentId = ($('#previewStudent') && $('#previewStudent').value) || state.previewStudentId || (state.students[0] && state.students[0].studentId);
  if (!studentId) {
    state.layoutPreviewData = null;
    state.layoutPreviewFor = '';
    renderLayoutEditor();
    return;
  }
  if (!force && state.layoutPreviewFor === studentId && state.layoutPreviewData) {
    renderLayoutEditor();
    return;
  }
  try {
    const data = await request(`/students/${encodeURIComponent(studentId)}/report`);
    state.layoutPreviewData = data;
    state.layoutPreviewFor = studentId;
  } catch (error) {
    state.layoutPreviewData = null;
    state.layoutPreviewFor = '';
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
  renderLayoutEditor();
}

async function resetLayout() {
  if (!state.themeDraft) return;
  const page = currentLayoutPage();
  if (!page) return;
  if (!await confirmDialog('恢复默认排版会丢弃这一页的自定义调整，回到当前默认样式（保存主题后生效）。', { title: '恢复默认排版', confirmText: '恢复', danger: true })) return;
  setLayoutPageElements(state.layoutPageKey, defaultLayoutTemplate(page));
  state.layoutSelectedId = '';
  renderLayoutEditor();
  setLayoutSideTab('list');
  toast('已恢复默认排版，记得保存主题');
}

function addLayoutText() {
  if (!state.themeDraft) return;
  const element = {
    id: layoutId(), type: 'text', x: 95, y: 380, w: 200,
    text: '新文字', unit: '', font: 'body', size: 20, weight: 400,
    color: '#f4f7ff', align: 'center', lineHeight: 1.4, opacity: 1, z: 1,
  };
  const elements = layoutPageElements();
  elements.push(element);
  setLayoutPageElements(state.layoutPageKey, elements);
  state.layoutSelectedId = element.id;
  renderLayoutEditor();
  setLayoutSideTab('props');
}

async function addLayoutImage(file) {
  if (!file) return;
  const extensions = (state.meta && state.meta.extensions && state.meta.extensions.image) || ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) return alertDialog(`只支持 ${extensions.join(' / ')} 格式`);
  const limit = (state.meta && state.meta.limits && state.meta.limits.image) || 5 * 1024 * 1024;
  if (file.size > limit) return alertDialog(`图片不能超过 ${Math.round(limit / 1024 / 1024)}MB`);
  const name = `decor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  try {
    const result = await upload({ kind: 'decor', dir: '', name, file });
    const src = (result.file && result.file.url ? result.file.url : `/images/decor/${name}`).split('?')[0];
    const element = {
      id: layoutId(), type: 'image', x: 135, y: 360, w: 120, h: 120,
      src, fit: 'contain', radius: 0, opacity: 1, z: 1,
    };
    const elements = layoutPageElements();
    elements.push(element);
    setLayoutPageElements(state.layoutPageKey, elements);
    state.layoutSelectedId = element.id;
    renderLayoutEditor();
    setLayoutSideTab('props');
    toast('图片已添加，可拖动调整位置');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

function setLayoutSideTab(tab) {
  const showList = tab !== 'props';
  const listPane = $('#layoutListPane');
  const propsPane = $('#layoutPropsPane');
  if (!listPane || !propsPane) return;
  listPane.hidden = !showList;
  propsPane.hidden = showList;
  $('#layoutTabList').classList.toggle('is-active', showList);
  $('#layoutTabProps').classList.toggle('is-active', !showList);
}

function selectThemeMode(mode) {
  state.themeMode = mode;
  $('#themeStylePanel').hidden = mode !== 'style';
  $('#themeLayoutPanel').hidden = mode !== 'layout';
  $('#themeModeStyle').classList.toggle('is-active', mode === 'style');
  $('#themeModeLayout').classList.toggle('is-active', mode === 'layout');
  if (mode === 'layout') {
    setLayoutSideTab('list');
    renderLayoutPageSelect();
    loadLayoutPreview();
  }
}

$('#themeModeStyle').addEventListener('click', () => selectThemeMode('style'));
$('#themeModeLayout').addEventListener('click', () => selectThemeMode('layout'));
$('#layoutTabList').addEventListener('click', () => setLayoutSideTab('list'));
$('#layoutTabProps').addEventListener('click', () => setLayoutSideTab('props'));
$('#layoutBackToList').addEventListener('click', () => setLayoutSideTab('list'));

$('#layoutPage').addEventListener('change', (event) => {
  state.layoutPageKey = event.target.value;
  state.layoutSelectedId = '';
  setLayoutSideTab('list');
  renderLayoutEditor();
});
$('#layoutResetBtn').addEventListener('click', resetLayout);
$('#layoutAddText').addEventListener('click', addLayoutText);
$('#layoutAddExtra').addEventListener('click', addLayoutExtra);
$('#layoutFillExtras').addEventListener('click', fillLayoutExtras);
$('#layoutSlot').addEventListener('change', (event) => {
  updateSelectedLayoutElement({ slot: Number(event.target.value) || 1 });
  renderLayoutProperties();
});
$('#layoutAddImage').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  addLayoutImage(file);
});
$('#layoutDelete').addEventListener('click', () => {
  const element = selectedLayoutElement();
  if (!element) return;
  setLayoutPageElements(state.layoutPageKey, layoutPageElements().filter(item => item.id !== element.id));
  state.layoutSelectedId = '';
  renderLayoutEditor();
  setLayoutSideTab('list');
});
$('#layoutDuplicate').addEventListener('click', () => {
  const element = selectedLayoutElement();
  if (!element) return;
  const copy = { ...element, id: layoutId(), x: element.x + 12, y: element.y + 12 };
  const elements = layoutPageElements();
  elements.push(copy);
  setLayoutPageElements(state.layoutPageKey, elements);
  state.layoutSelectedId = copy.id;
  renderLayoutEditor();
  setLayoutSideTab('props');
});
$('#layoutSaveTheme').addEventListener('click', () => saveTheme(false));
$('#layoutPreviewTheme').addEventListener('click', () => saveTheme(true));

$('#layoutText').addEventListener('input', (event) => updateSelectedLayoutElement({ text: event.target.value }));
$('#layoutUnit').addEventListener('input', (event) => updateSelectedLayoutElement({ unit: event.target.value }));
$('#layoutFont').addEventListener('change', (event) => updateSelectedLayoutElement({ font: event.target.value || null }));
$('#layoutSize').addEventListener('input', (event) => updateSelectedLayoutElement({ size: Math.round(clampLayout(Number(event.target.value) || 16, 8, 160)) }));
$('#layoutWeight').addEventListener('change', (event) => updateSelectedLayoutElement({ weight: Number(event.target.value) }));
$('#layoutColor').addEventListener('input', (event) => {
  $('#layoutColorHex').value = event.target.value.toUpperCase();
  updateSelectedLayoutElement({ color: event.target.value });
});
$('#layoutColorHex').addEventListener('input', (event) => {
  const value = event.target.value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
  $('#layoutColor').value = value;
  updateSelectedLayoutElement({ color: value.toLowerCase() });
});
$('#layoutAlign').addEventListener('change', (event) => updateSelectedLayoutElement({ align: event.target.value }));
$('#layoutOpacity').addEventListener('input', (event) => updateSelectedLayoutElement({ opacity: Number(event.target.value) }));
$('#layoutZ').addEventListener('input', (event) => updateSelectedLayoutElement({ z: Math.round(clampLayout(Number(event.target.value) || 0, 0, 20)) }));
$('#layoutFit').addEventListener('change', (event) => updateSelectedLayoutElement({ fit: event.target.value }));
$('#layoutRadius').addEventListener('input', (event) => updateSelectedLayoutElement({ radius: Math.round(clampLayout(Number(event.target.value) || 0, 0, 100)) }));

function commitLayoutBox(key, raw) {
  const element = selectedLayoutElement();
  if (!element) return;
  const number = Number(raw);
  if (!Number.isFinite(number)) return renderLayoutProperties();
  let value = Math.round(number);
  if (key === 'x') value = Math.round(clampLayout(value, 0, LAYOUT_W - element.w));
  if (key === 'y') value = Math.round(clampLayout(value, 0, LAYOUT_H - 20));
  if (key === 'w') value = Math.round(clampLayout(value, 40, LAYOUT_W - element.x));
  if (key === 'h') value = Math.round(clampLayout(value, 20, LAYOUT_H - element.y));
  updateSelectedLayoutElement({ [key]: value });
  renderLayoutProperties();
}

$('#layoutX').addEventListener('change', (event) => commitLayoutBox('x', event.target.value));
$('#layoutY').addEventListener('change', (event) => commitLayoutBox('y', event.target.value));
$('#layoutW').addEventListener('change', (event) => commitLayoutBox('w', event.target.value));
$('#layoutH').addEventListener('change', (event) => commitLayoutBox('h', event.target.value));

$('#previewStudent').addEventListener('change', () => {
  state.previewStudentId = $('#previewStudent').value;
  if (isLayoutMode()) loadLayoutPreview(true);
});

window.addEventListener('resize', () => {
  if (isLayoutMode()) applyEditorScale();
});

/* ---------- 页面注册表 ---------- */

function renderPages() {
  const box = $('#pageList');
  if (!box) return;
  box.textContent = '';
  if (!state.pages.length) {
    box.append(el('p', 'muted', '还没有页面'));
    return;
  }
  for (const page of state.pages) {
    const row = el('div', 'row');
    const head = el('div', 'row-head');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = page.enabled;
    checkbox.addEventListener('change', () => togglePage(page, checkbox.checked));
    const main = el('div', 'row-main');
    main.append(el('strong', null, page.title));
    main.append(el('span', 'muted', `${page.key} · ${page.typeLabel || page.type} · 第 ${page.position} 位${page.enabled ? '' : ' · 已停用'}`));
    head.append(checkbox, main);
    row.append(head);

    const actions = el('div', 'row-actions');
    actions.append(button('上移', 'ghost', () => movePage(page, 'up')));
    actions.append(button('下移', 'ghost', () => movePage(page, 'down')));
    actions.append(button('编辑', 'ghost', () => openPageEditor(page)));
    actions.append(button('删除', 'danger', () => deletePage(page)));
    row.append(actions);
    box.append(row);
  }
}

function syncPageConfigRows() {
  const type = $('#p_type').value;
  $('#p_statRow').hidden = type !== 'stat';
  $('#p_memoryRow').hidden = type !== 'memory';
}

function openPageEditor(page) {
  state.editingPageKey = page ? page.key : null;
  $('#pageEditorTitle').textContent = page ? `编辑页面：${page.title}` : '新增页面';
  $('#p_type').value = page ? page.type : 'cover';
  $('#p_title').value = page ? page.title : '';
  const config = (page && page.config) || {};
  $('#p_statField').value = config.field === 'activityCount' ? 'activityCount' : 'volunteerHours';
  $('#p_memoryIndex').value = String(config.index === 2 ? 2 : 1);
  $('#pageFormMessage').hidden = true;
  syncPageConfigRows();
  $('#pageEditorOverlay').hidden = false;
}

function closePageEditor() {
  $('#pageEditorOverlay').hidden = true;
  state.editingPageKey = null;
}

async function refreshAfterPages() {
  state.meta = await request('/meta');
  state.pages = state.meta.pages || [];
  state.reportYear = state.meta.reportYear || '';
  $('#reportYearInput').value = state.reportYear;
  $('#batchKeys').textContent = (state.meta.pageKeys || []).join('、');
  if (!(state.meta.pageKeys || []).includes(state.layoutPageKey)) {
    state.layoutPageKey = (state.meta.pageKeys || [])[0] || '01-cover';
    state.layoutSelectedId = '';
  }
  renderPages();
  renderThemePageOptions();
  if (state.themeMode === 'layout') {
    renderLayoutPageSelect();
    renderLayoutEditor();
  }
  if (state.media) await loadMedia();
  await loadExtras();
  renderPreviewStudentSelect();
}

async function togglePage(page, enabled) {
  try {
    await request(`/pages/${encodeURIComponent(page.key)}`, { method: 'PUT', body: { enabled } });
    await refreshAfterPages();
    toast(enabled ? '页面已启用' : '页面已停用');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

async function movePage(page, direction) {
  try {
    await request(`/pages/${encodeURIComponent(page.key)}/move`, { method: 'POST', body: { direction } });
    await refreshAfterPages();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

async function deletePage(page) {
  if (!await confirmDialog(`确定删除页面「${page.title}」吗？背景图和主题里对应的设置不会删除，但报告不再显示这一页。`, { title: '删除页面', confirmText: '删除', danger: true })) return;
  try {
    await request(`/pages/${encodeURIComponent(page.key)}`, { method: 'DELETE' });
    await refreshAfterPages();
    toast('页面已删除');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

$('#addPageBtn').addEventListener('click', () => openPageEditor(null));
$('#refreshPagesBtn').addEventListener('click', () => {
  refreshAfterPages().then(() => toast('页面已刷新')).catch(showError);
});
$('#pageCancel').addEventListener('click', closePageEditor);
$('#p_type').addEventListener('change', syncPageConfigRows);
$('#saveYearBtn').addEventListener('click', async () => {
  const year = $('#reportYearInput').value.trim();
  if (!/^\d{4}$/.test(year)) return alertDialog('年度需为 4 位数字');
  try {
    await request('/settings', { method: 'PUT', body: { reportYear: year } });
    state.reportYear = year;
    toast('年度已更新');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});
$('#resetLoginPreface').addEventListener('click', () => {
  const copy = (state.meta && state.meta.loginCopy) || {};
  $('#loginPrefaceInput').value = copy.defaultPreface || '';
});
$('#loginCopyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await request('/settings', { method: 'PUT', body: { loginPreface: $('#loginPrefaceInput').value } });
    state.meta.loginCopy = { ...(state.meta.loginCopy || {}), preface: data.loginPreface };
    $('#loginPrefaceInput').value = data.loginPreface;
    toast(data.loginPreface ? '登录页前言已更新' : '登录页前言已清空，登录页将不再显示');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});
$('#pageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = $('#p_type').value;
  const title = $('#p_title').value.trim();
  if (!title) {
    $('#pageFormMessage').textContent = '请填写页面标题';
    $('#pageFormMessage').hidden = false;
    return;
  }
  const config = type === 'stat'
    ? { field: $('#p_statField').value }
    : type === 'memory'
      ? { index: Number($('#p_memoryIndex').value) }
      : {};
  try {
    if (state.editingPageKey) {
      await request(`/pages/${encodeURIComponent(state.editingPageKey)}`, { method: 'PUT', body: { type, title, config } });
    } else {
      await request('/pages', { method: 'POST', body: { type, title, config } });
    }
    closePageEditor();
    await refreshAfterPages();
    toast('页面已保存');
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    $('#pageFormMessage').textContent = error.message;
    $('#pageFormMessage').hidden = false;
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
