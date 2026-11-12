const FALLBACK = {
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

const MUSIC_PREF_KEY = 'report.bgm';
const MUSIC_VOLUME = 0.6;

const loginScreen = document.querySelector('#loginScreen');
const reportScreen = document.querySelector('#reportScreen');
const loginForm = document.querySelector('#loginForm');
const loginBtn = document.querySelector('#loginBtn');
const loginError = document.querySelector('#loginError');
const loginPreface = document.querySelector('#loginPreface');
const logoutBtn = document.querySelector('#logoutBtn');
const changePasswordBtn = document.querySelector('#changePasswordBtn');
const passwordScreen = document.querySelector('#passwordScreen');
const passwordForm = document.querySelector('#passwordForm');
const passwordBtn = document.querySelector('#passwordBtn');
const passwordBack = document.querySelector('#passwordBack');
const passwordError = document.querySelector('#passwordError');
const passwordOk = document.querySelector('#passwordOk');
const oldPasswordInput = document.querySelector('#oldPassword');
const newPasswordInput = document.querySelector('#newPassword');
const confirmPasswordInput = document.querySelector('#confirmPassword');
const studentIdInput = document.querySelector('#studentId');
const passwordInput = document.querySelector('#password');
const bgm = document.querySelector('#bgm');
const musicToggle = document.querySelector('#musicToggle');
const previewBadge = document.querySelector('#previewBadge');
const endingActions = document.querySelector('#endingActions');

const FONT_FALLBACK = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const LAYOUT_WIDTH = 390;
const LAYOUT_HEIGHT = 844;
const PLACEHOLDER_KEYS = [
  'name', 'department', 'joinDays', 'volunteerHours', 'activityCount', 'partner', 'message',
  'reportYear', 'activities', 'activity1Name', 'activity1Date', 'activity1Work',
  'activity2Name', 'activity2Date', 'activity2Work', 'partnerCount', 'partnerLine', 'partnerCaption',
  'keyword', 'keywordReason',
];
const NUMERIC_PLACEHOLDERS = new Set(['joinDays', 'volunteerHours', 'activityCount', 'partnerCount']);
const PAGE_TYPES = new Set(['cover', 'stat', 'activities', 'memory', 'partners', 'keyword', 'message']);

let swiper = null;
let reportData = null;
let previewMode = false;
const layoutFontPromises = new Map();

// 手机端常见的一类失败：复用中的 keep-alive 连接刚好被服务端关闭，
// 请求发到已关闭的 socket 上会直接抛 TypeError（Failed to fetch），
// 且不会到达服务器日志。这类情况自动重试一次即可恢复。
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

async function request(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetchWithRetry(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应（例如 Nginx 的 502 页面）走下面的统一报错
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- 入场动画 ---------- */

function playAnimations(root) {
  root.querySelectorAll('[data-animate]').forEach((node) => {
    const effect = node.dataset.animate;
    node.style.setProperty('--animate-duration', node.dataset.duration || '0.9s');
    node.style.setProperty('--animate-delay', node.dataset.delay || '0ms');
    node.classList.remove('animate__animated', `animate__${effect}`);
    void node.offsetWidth; // 强制重排，保证再次进入同一页时动画重播
    node.classList.add('animate__animated', `animate__${effect}`);
  });
}

/* ---------- 大数字滚动 ---------- */

function countUp(node, target) {
  // 字段没填（比如没录入入会日期）时不显示 0，直接给个破折号
  if (target === null || target === undefined || target === '') {
    node.textContent = '—';
    return;
  }
  const value = Number(target);
  const end = Number.isFinite(value) ? value : 0;
  const decimals = Number.isInteger(end) ? 0 : 1;
  const duration = 1200;
  const startedAt = performance.now();

  function frame(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (progress < 1) {
      node.textContent = (end * eased).toFixed(decimals);
      requestAnimationFrame(frame);
    } else {
      node.textContent = end.toFixed(decimals);
    }
  }

  node.textContent = (0).toFixed(decimals);
  requestAnimationFrame(frame);
}

function playPage(slide) {
  if (!slide) return;
  playAnimations(slide);
  playEntryRing(slide);
  const canvas = slide.querySelector('.layout-canvas');
  if (canvas) {
    canvas.classList.remove('is-entering');
    void canvas.offsetWidth;
    canvas.classList.add('is-entering');
  }
  slide.querySelectorAll('[data-count]').forEach((node) => {
    countUp(node, reportData ? reportData[node.dataset.count] : 0);
  });
}

// 每次进入该屏扩散一次光圈：移除→强制重排→重新挂类，确保动画重播
function playEntryRing(slide) {
  const ring = slide.querySelector('.entry-ring');
  if (!ring) return;
  ring.classList.remove('is-bursting');
  void ring.offsetWidth;
  ring.classList.add('is-bursting');
}

/* ---------- 渲染 ---------- */

function pageTemplate(page) {
  const type = PAGE_TYPES.has(page.type) ? page.type : 'message';
  const config = page.config || {};

  if (type === 'cover') {
    return `
      <p class="line" data-animate="fadeIn"><span data-field="reportYear"></span> 年度回顾</p>
      <h2 class="huge" data-animate="fadeInUp" data-delay="150ms"><span data-field="name"></span></h2>
      <p class="sub" data-animate="fadeInUp" data-delay="250ms"><span data-field="department"></span></p>
      <p class="sub" data-animate="fadeInUp" data-delay="350ms">这一年，你的每一份付出，都值得被记录。</p>
      <p class="swipe-hint">上滑继续</p>
    `;
  }

  if (type === 'stat') {
    if (config.field === 'activityCount') {
      return `
        <p class="line" data-animate="fadeIn">这一年，你参与了</p>
        <p class="number" data-animate="zoomIn" data-delay="150ms"><span data-count="activityCount">0</span><small>次</small></p>
        <p class="sub" data-animate="fadeInUp" data-delay="400ms">活动，每一次都在场</p>
      `;
    }
    return `
      <p class="line" data-animate="fadeIn">这一年，你累计贡献了</p>
      <p class="number" data-animate="zoomIn" data-delay="150ms"><span data-count="volunteerHours">0</span><small>小时</small></p>
      <p class="sub" data-animate="fadeInUp" data-delay="400ms">的志愿服务</p>
    `;
  }

  if (type === 'activities') {
    return `
      <p class="line" data-animate="fadeIn">活动足迹</p>
      <p class="line" data-animate="fadeIn" data-delay="100ms">这一年，你参与了</p>
      <p class="number" data-animate="zoomIn" data-delay="150ms"><span data-count="activityCount">0</span><small>次活动</small></p>
      <div class="activity-list" data-animate="fadeInUp" data-delay="350ms"></div>
      <p class="sub" data-animate="fadeInUp" data-delay="450ms">每一次都在场</p>
    `;
  }

  if (type === 'memory') {
    const index = config.index === 2 ? 2 : 1;
    return `
      <p class="line" data-animate="fadeIn">活动回忆</p>
      <h2 class="huge" data-animate="fadeInUp" data-delay="120ms"><span data-field="activity${index}Name"></span></h2>
      <p class="sub" data-animate="fadeInUp" data-delay="200ms"><span data-field="activity${index}Date"></span></p>
      <p class="message work" data-animate="fadeInUp" data-delay="300ms" data-field="activity${index}Work"></p>
      <p class="sub" data-animate="fadeInUp" data-delay="450ms">${index === 1 ? '定格一次投入' : '再看一个瞬间'}</p>
    `;
  }

  if (type === 'partners') {
    return `
      <p class="line" data-animate="fadeIn">同行伙伴</p>
      <p class="number" data-animate="zoomIn" data-delay="150ms"><span data-count="partnerCount">0</span><small>位</small></p>
      <p class="sub" data-animate="fadeInUp" data-delay="400ms" data-field="partnerCaption"></p>
    `;
  }

  if (type === 'keyword') {
    return `
      <p class="line" data-animate="fadeIn">你的年度关键词是</p>
      <h2 class="huge" data-animate="zoomIn" data-delay="150ms"><span data-field="keyword"></span></h2>
      <p class="sub" data-animate="fadeInUp" data-delay="400ms" data-field="keywordReason"></p>
    `;
  }

  return `
    <p class="line" data-animate="fadeIn">部长想对你说</p>
    <p class="message" data-animate="fadeInUp" data-delay="200ms" data-field="message"></p>
    <p class="sub" data-animate="fadeInUp" data-delay="500ms">感谢这一年的同行，期待下一程的你</p>
  `;
}

function fillActivityList(inner, activities) {
  const list = inner.querySelector('.activity-list');
  if (!list) return;
  const names = Array.isArray(activities) ? activities.filter(Boolean) : [];
  if (names.length === 0) {
    list.textContent = '（活动记录待补充）';
    return;
  }
  for (const name of names) {
    const tag = document.createElement('span');
    tag.className = 'activity-tag';
    tag.textContent = name;
    list.append(tag);
  }
}

function buildSlides(pages, data) {
  const wrapper = document.querySelector('#reportSwiper .swiper-wrapper');
  wrapper.textContent = '';
  for (const page of pages) {
    const type = PAGE_TYPES.has(page.type) ? page.type : 'message';
    const section = document.createElement('section');
    section.className = `swiper-slide page page-${type}`;
    section.dataset.bg = page.key;
    section.dataset.pageType = type;
    const inner = document.createElement('div');
    inner.className = 'page-inner';
    inner.innerHTML = pageTemplate({ ...page, type });
    section.append(inner);
    wrapper.append(section);
    if (type === 'activities') fillActivityList(inner, data.activities);
  }
}

function renderReport(data) {
  reportData = data;
  document.querySelectorAll('[data-field]').forEach((node) => {
    const value = data[node.dataset.field];
    const empty = value === null || value === undefined || value === '';
    node.textContent = empty ? FALLBACK[node.dataset.field] || '' : String(value);
  });
}

// 后端只返回确实存在的图片地址，这里不用再试探
function applyBackgrounds(backgrounds) {
  document.querySelectorAll('.page[data-bg]').forEach((page) => {
    const url = backgrounds && backgrounds[page.dataset.bg];
    if (!url) return; // 没配图就保留页面自带的渐变
    page.style.backgroundImage = `url("${url}")`;
    page.classList.add('has-bg');
  });
}

/* ---------- 主题与字体 ---------- */

function hexToRgb(hex) {
  const matched = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!matched) return null;
  const value = parseInt(matched[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function applyTheme(theme) {
  const base = (theme && theme.base) || {};
  if (base.accent) {
    reportScreen.style.setProperty('--accent', base.accent);
    const accentRgb = hexToRgb(base.accent);
    if (accentRgb) reportScreen.style.setProperty('--accent-rgb', accentRgb);
  }
  if (base.accent2) {
    reportScreen.style.setProperty('--accent-2', base.accent2);
    const accent2Rgb = hexToRgb(base.accent2);
    if (accent2Rgb) reportScreen.style.setProperty('--accent-2-rgb', accent2Rgb);
  }
  const scrimRgb = hexToRgb(base.scrimColor);
  if (scrimRgb) reportScreen.style.setProperty('--scrim-rgb', scrimRgb);
  if (typeof base.scrim === 'number') reportScreen.style.setProperty('--scrim-alpha', String(base.scrim));

  const motion = (theme && theme.motion) || {};
  reportScreen.classList.toggle('decor-notes-off', motion.notes === false);
  reportScreen.classList.toggle('decor-ambient-off', motion.ambient === false);

  const pages = (theme && theme.pages) || {};
  document.querySelectorAll('.page[data-bg]').forEach((page) => {
    const override = pages[page.dataset.bg] || {};
    const values = {
      '--accent': override.accent || '',
      '--accent-2': override.accent2 || '',
      '--accent-rgb': hexToRgb(override.accent) || '',
      '--accent-2-rgb': hexToRgb(override.accent2) || '',
      '--scrim-rgb': hexToRgb(override.scrimColor) || '',
      '--scrim-alpha': typeof override.scrim === 'number' ? String(override.scrim) : '',
    };
    for (const [name, value] of Object.entries(values)) {
      if (value) page.style.setProperty(name, value);
      else page.style.removeProperty(name);
    }
  });
}

// 字体只在主题里配置了才加载；失败/超时就保留系统字体栈，绝不阻塞报告
async function loadFonts(fonts) {
  if (!fonts || typeof FontFace === 'undefined') return;
  const slots = [
    ['display', 'ReportDisplay', '--font-display'],
    ['body', 'ReportBody', '--font-body'],
  ];
  for (const [slot, family, cssVar] of slots) {
    const url = fonts[slot];
    if (!url) continue;
    try {
      const face = new FontFace(family, `url("${url}")`);
      await Promise.race([
        face.load(),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('字体加载超时')), 2000)),
      ]);
      document.fonts.add(face);
      reportScreen.style.setProperty(cssVar, `"${family}", ${FONT_FALLBACK}`);
    } catch {
      // 静默回退
    }
  }
}

/* ---------- 自由排版 ---------- */

function ensureLayoutFont(url, family) {
  if (!url || typeof FontFace === 'undefined') return;
  const key = `${family}|${url}`;
  if (layoutFontPromises.has(key)) return;
  const promise = (async () => {
    try {
      const face = new FontFace(family, `url("${url}")`);
      await Promise.race([
        face.load(),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('字体加载超时')), 2000)),
      ]);
      document.fonts.add(face);
    } catch {
      // 静默回退
    }
  })();
  layoutFontPromises.set(key, promise);
}

function layoutFontFamily(ref, theme) {
  const fonts = (theme && theme.fonts) || {};
  if (ref === 'display') {
    ensureLayoutFont(fonts.display, 'ReportDisplay');
    return fonts.display ? `"ReportDisplay", ${FONT_FALLBACK}` : FONT_FALLBACK;
  }
  if (ref === 'body') {
    ensureLayoutFont(fonts.body, 'ReportBody');
    return fonts.body ? `"ReportBody", ${FONT_FALLBACK}` : FONT_FALLBACK;
  }
  const url = ref && fonts.presets ? fonts.presets[ref] : null;
  if (!url) return FONT_FALLBACK;
  const family = `RF-${ref}`;
  ensureLayoutFont(url, family);
  return `"${family}", ${FONT_FALLBACK}`;
}

function substituteLayoutText(text, data) {
  return String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!PLACEHOLDER_KEYS.includes(key)) return '';
    const value = data ? data[key] : '';
    if (key === 'activities') {
      const names = Array.isArray(value) ? value.filter(Boolean) : (value ? [String(value)] : []);
      return names.length ? names.join('、') : '（活动记录待补充）';
    }
    if (value === null || value === undefined || value === '') {
      if (NUMERIC_PLACEHOLDERS.has(key)) return '—';
      return FALLBACK[key] || '';
    }
    return String(value);
  });
}

function renderLayoutElement(element, theme) {
  if (element.type === 'image') {
    const node = document.createElement('img');
    node.className = 'layout-el layout-image';
    node.src = element.src;
    node.alt = '';
    node.loading = 'lazy';
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
    node.style.width = `${element.w}px`;
    node.style.height = `${element.h}px`;
    node.style.objectFit = element.fit;
    node.style.opacity = String(element.opacity);
    node.style.zIndex = String(element.z);
    if (element.radius) node.style.borderRadius = `${element.radius}px`;
    return node;
  }

  const node = document.createElement('span');
  node.className = 'layout-el layout-text';
  node.style.left = `${element.x}px`;
  node.style.top = `${element.y}px`;
  node.style.width = `${element.w}px`;
  node.style.opacity = String(element.opacity);
  node.style.zIndex = String(element.z);
  node.style.color = element.color;
  node.style.fontSize = `${element.size}px`;
  node.style.fontWeight = String(element.weight);
  node.style.textAlign = element.align;
  node.style.lineHeight = String(element.lineHeight);
  node.style.fontFamily = layoutFontFamily(element.font, theme);
  node.textContent = substituteLayoutText(element.text, reportData);
  if (element.unit) {
    const unit = document.createElement('small');
    unit.textContent = element.unit;
    unit.style.fontSize = '0.24em';
    unit.style.marginLeft = '0.2em';
    unit.style.opacity = '0.72';
    node.append(unit);
  }
  return node;
}

// 有排版的页面隐藏默认文字（结尾页的按钮行保留），改为渲染 390×844 设计稿
function renderLayout(theme) {
  const layout = (theme && theme.layout) || {};
  document.querySelectorAll('.page[data-bg]').forEach((page) => {
    page.querySelectorAll('.layout-canvas').forEach(node => node.remove());
    const spec = layout[page.dataset.bg];
    if (!spec || !Array.isArray(spec.elements) || spec.elements.length === 0) {
      page.classList.remove('layout-active');
      return;
    }
    page.classList.add('layout-active');
    const canvas = document.createElement('div');
    canvas.className = 'layout-canvas';
    for (const element of spec.elements) canvas.append(renderLayoutElement(element, theme));
    page.append(canvas);
  });
}

// 元素按设计稿等比缩放；背景图由所在页面负责铺满
function applyLayoutScale() {
  const scale = Math.min(
    reportScreen.clientWidth / LAYOUT_WIDTH,
    reportScreen.clientHeight / LAYOUT_HEIGHT
  ) || 1;
  reportScreen.style.setProperty('--layout-scale', String(scale));
}

window.addEventListener('resize', applyLayoutScale);

/* ---------- 背景音乐 ---------- */

function musicPreference() {
  try {
    return localStorage.getItem(MUSIC_PREF_KEY);
  } catch {
    return null; // 隐私模式下读不到，按默认（自动播放）处理
  }
}

function rememberMusicPreference(value) {
  try {
    localStorage.setItem(MUSIC_PREF_KEY, value);
  } catch {
    // 写不进去不影响本次播放
  }
}

function setMusicState(playing) {
  musicToggle.classList.toggle('is-playing', playing);
  musicToggle.setAttribute('aria-label', playing ? '关闭背景音乐' : '播放背景音乐');
}

function playMusic() {
  bgm.play().then(() => setMusicState(true)).catch(() => setMusicState(false));
}

function stopMusic() {
  bgm.pause();
  setMusicState(false);
}

function setupMusic(url) {
  musicToggle.hidden = !url;
  if (!url) {
    bgm.removeAttribute('src');
    setMusicState(false);
    return;
  }
  if (bgm.getAttribute('src') !== url) bgm.setAttribute('src', url);
  bgm.volume = MUSIC_VOLUME;
  // 上次是自己关掉的，这次就不要自动响起来；预览模式不改动真实用户的偏好
  if (!previewMode && musicPreference() === 'off') setMusicState(false);
  else playMusic();
}

musicToggle.addEventListener('click', () => {
  if (bgm.paused) {
    if (!previewMode) rememberMusicPreference('on');
    playMusic();
  } else {
    if (!previewMode) rememberMusicPreference('off');
    stopMusic();
  }
});

// 文件缺失或解码失败时，把开关一起藏掉
bgm.addEventListener('error', () => {
  musicToggle.hidden = true;
});

/* ---------- 屏幕切换 ---------- */

async function loadLoginCopy() {
  try {
    const data = await request('/api/login-copy');
    const preface = typeof data.preface === 'string' ? data.preface : '';
    loginPreface.textContent = preface;
    loginPreface.hidden = preface === '';
  } catch {
    // 接口不可用时保留 HTML 里的默认文案
  }
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function hideLoginError() {
  loginError.textContent = '';
  loginError.hidden = true;
}

function showLogin(message) {
  reportScreen.hidden = true;
  passwordScreen.hidden = true;
  loginScreen.hidden = false;
  stopMusic();
  loginBtn.disabled = false;
  loginBtn.textContent = '进入报告';
  passwordInput.value = '';
  if (message) showLoginError(message);
  else hideLoginError();
  playAnimations(loginScreen);
  if (swiper) swiper.slideTo(0, 0);
}

function enterReport(data) {
  if (swiper) {
    swiper.destroy(true, false);
    swiper = null;
  }
  const pages = Array.isArray(data.pages) ? data.pages : [];
  buildSlides(pages, data);
  renderReport(data);
  loginScreen.hidden = true;
  passwordScreen.hidden = true;
  reportScreen.hidden = false;
  hideLoginError();

  const wrapper = document.querySelector('#reportSwiper .swiper-wrapper');
  const slides = wrapper.querySelectorAll('.swiper-slide');
  const lastSlide = slides[slides.length - 1] || null;
  if (lastSlide) {
    const inner = lastSlide.querySelector('.page-inner');
    if (inner) inner.append(endingActions);
    endingActions.hidden = false;
  } else {
    endingActions.hidden = true;
  }

  applyTheme(data.theme);
  loadFonts(data.theme && data.theme.fonts);
  applyBackgrounds(data.backgrounds);
  setupMusic(data.music);
  renderLayout(data.theme);
  applyLayoutScale();

  // 切页光圈的元素只建一次（纯装饰，不写进 HTML）
  slides.forEach((page) => {
    if (page.querySelector('.entry-ring')) return;
    const ring = document.createElement('span');
    ring.className = 'entry-ring';
    ring.setAttribute('aria-hidden', 'true');
    page.append(ring);
  });

  if (previewMode) {
    changePasswordBtn.hidden = true;
    logoutBtn.hidden = true;
    previewBadge.hidden = false;
  }

  document.querySelector('.swiper-pagination').textContent = '';
  swiper = new Swiper('#reportSwiper', {
    direction: 'vertical',
    speed: 800,
    resistanceRatio: 0.6,
    mousewheel: true,
    observer: true,
    observeParents: true,
    pagination: { el: '.swiper-pagination', clickable: true },
    on: {
      slideChangeTransitionStart(instance) {
        playPage(instance.slides[instance.activeIndex]);
      },
    },
  });
  swiper.slideTo(0, 0);
  playPage(swiper.slides[0]);
}

/* ---------- 修改密码 ---------- */

function showPasswordError(message) {
  passwordOk.hidden = true;
  passwordError.textContent = message;
  passwordError.hidden = false;
}

function showPasswordOk(message) {
  passwordError.hidden = true;
  passwordOk.textContent = message;
  passwordOk.hidden = false;
}

function resetPasswordForm() {
  oldPasswordInput.value = '';
  newPasswordInput.value = '';
  confirmPasswordInput.value = '';
  passwordError.hidden = true;
  passwordOk.hidden = true;
  passwordBtn.disabled = false;
  passwordBtn.textContent = '保存新密码';
}

function showChangePassword() {
  resetPasswordForm();
  reportScreen.hidden = true;
  passwordScreen.hidden = false;
  playAnimations(passwordScreen);
}

function backToReport() {
  passwordScreen.hidden = true;
  reportScreen.hidden = false;
  if (swiper) {
    swiper.update();
    playPage(swiper.slides[swiper.activeIndex]);
  }
}

/* ---------- 登录与退出 ---------- */

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideLoginError();

  const studentId = studentIdInput.value.trim();
  const password = passwordInput.value;
  if (!studentId || !password) {
    showLoginError('请填写学号和密码');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '正在打开…';

  try {
    await request('/api/login', { method: 'POST', body: { studentId, password } });
    const data = await request('/api/report');
    enterReport(data);
  } catch (error) {
    showLoginError(error.message);
    loginBtn.disabled = false;
    loginBtn.textContent = '进入报告';
  }
});

logoutBtn.addEventListener('click', async () => {
  if (previewMode) return; // 预览窗口不能销毁管理员与成员共用的会话
  logoutBtn.disabled = true;
  try {
    await request('/api/logout', { method: 'POST' });
  } catch {
    // 服务端退出失败也回到登录页，避免卡在报告里
  }
  logoutBtn.disabled = false;
  showLogin('已退出登录');
});

changePasswordBtn.addEventListener('click', () => {
  if (!previewMode) showChangePassword();
});
passwordBack.addEventListener('click', backToReport);

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordError.hidden = true;
  passwordOk.hidden = true;

  const oldPassword = oldPasswordInput.value;
  const newPassword = newPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (!oldPassword || !newPassword || !confirmPassword) return showPasswordError('请把三项都填上');
  if (newPassword.length < 6 || newPassword.length > 64) return showPasswordError('新密码长度需为 6–64 位');
  if (newPassword !== confirmPassword) return showPasswordError('两次输入的新密码不一致');
  if (newPassword === oldPassword) return showPasswordError('新密码不能和当前密码相同');

  passwordBtn.disabled = true;
  passwordBtn.textContent = '保存中…';

  try {
    const result = await request('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
    resetPasswordForm();
    const extra = result && result.otherSessionsRemoved > 0 ? '，其他设备上的登录已失效' : '';
    showPasswordOk(`密码修改成功${extra}`);
  } catch (error) {
    passwordBtn.disabled = false;
    passwordBtn.textContent = '保存新密码';
    if (error.message === '未登录') {
      showLogin('登录已过期，请重新登录');
      return;
    }
    showPasswordError(error.message);
  }
});

/* ---------- 启动 ---------- */

// 真实报告预览：管理面板用新窗口打开 /index.html?preview=1&student=..&themeId=..
// 只依赖管理员会话，绝不调用 /api/logout（会连管理面板一起退掉）
async function startPreview(params) {
  previewMode = true;
  try {
    await request('/api/admin/session');
  } catch {
    showLogin('请先在管理面板登录，再打开真实报告预览');
    return;
  }

  const studentId = params.get('student') || '';
  if (!studentId) {
    showLogin('预览链接缺少成员学号');
    return;
  }

  try {
    const themeId = params.get('themeId') || '';
    const query = themeId ? `?themeId=${encodeURIComponent(themeId)}` : '';
    const data = await request(`/api/admin/students/${encodeURIComponent(studentId)}/report${query}`);
    enterReport(data);
  } catch (error) {
    showLogin(`无法打开预览：${error.message}`);
  }
}

(async function start() {
  const params = new URLSearchParams(location.search);
  if (params.get('preview') === '1') {
    await startPreview(params);
    return;
  }

  loadLoginCopy();
  playAnimations(loginScreen);
  try {
    const data = await request('/api/report');
    enterReport(data);
  } catch (error) {
    if (error.status !== 401) {
      showLoginError('无法连接服务器，请刷新重试');
    }
  }
})();
