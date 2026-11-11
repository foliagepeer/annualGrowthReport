// 主题的单一规则来源：配置校验、主题 CRUD、报告端解析。
// 主题只允许受控字段，不接受任意 CSS；登录页与面板不套主题。
const crypto = require('crypto');
const media = require('./media');

const NAME_MAX = 32;
const THEME_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_KEY = /^[A-Za-z0-9_-]{1,40}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// 排版设计稿尺寸：前端按视口等比缩放，元素坐标/字号都用这套设计像素
const LAYOUT_WIDTH = 390;
const LAYOUT_HEIGHT = 844;
const LAYOUT_MAX_ELEMENTS = 40;
const LAYOUT_MAX_TEXT = 2000;
const LAYOUT_WEIGHTS = [400, 500, 600, 700, 800];
const LAYOUT_ALIGNS = ['left', 'center', 'right'];
const LAYOUT_ELEMENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const DECOR_SRC = /^\/images\/decor\/[A-Za-z0-9._-]{1,120}$/;

// 默认值与 static/style.css 的 :root 保持一致：没有主题时外观零变化
const DEFAULT_THEME = {
  base: { accent: '#7dd3fc', accent2: '#bcd6ff', scrim: 0.45, scrimColor: '#060a14' },
  fonts: { display: null, body: null },
  motion: { notes: true, ambient: true },
  pages: {},
  layout: {},
};

function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_THEME));
}

function roundScrim(value) {
  return Math.round(value * 100) / 100;
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

function isScrim(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 0.9;
}

function pageOverride(value, strict) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return strict ? { error: '按页覆盖的格式不对' } : { value: null };
  }
  const out = {};
  for (const key of ['accent', 'accent2', 'scrimColor']) {
    if (value[key] === undefined) continue;
    if (!HEX_COLOR.test(value[key])) {
      if (strict) return { error: `页面颜色 ${key} 需为 #RRGGBB` };
      continue;
    }
    out[key] = value[key].toLowerCase();
  }
  if (value.scrim !== undefined) {
    if (!isScrim(value.scrim)) {
      if (strict) return { error: '页面暗层强度需在 0–0.9 之间' };
    } else {
      out.scrim = roundScrim(value.scrim);
    }
  }
  return { value: Object.keys(out).length ? out : null };
}

/* ---------- 页面排版 ---------- */

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function layoutElement(raw, strict, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return strict ? { error: '页面元素格式不对' } : { value: null };
  }
  const type = raw.type;
  if (type !== 'text' && type !== 'image') {
    return strict ? { error: '元素类型只能是 text 或 image' } : { value: null };
  }
  const id = typeof raw.id === 'string' && LAYOUT_ELEMENT_ID.test(raw.id) ? raw.id : null;
  if (strict && !id) return { error: '元素 id 不合法' };

  const element = {
    id: id || `e${index}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    x: clampNumber(raw.x, 0, LAYOUT_WIDTH, LAYOUT_WIDTH / 2),
    y: clampNumber(raw.y, 0, LAYOUT_HEIGHT, LAYOUT_HEIGHT / 2),
    w: clampNumber(raw.w, 10, LAYOUT_WIDTH, 200),
    z: Math.round(clampNumber(raw.z, 0, 20, 1)),
    opacity: clampNumber(raw.opacity, 0.1, 1, 1),
  };

  if (type === 'text') {
    if (strict && typeof raw.text !== 'string') return { error: '文字内容格式不对' };
    const font = raw.font === 'display' || raw.font === 'body'
      ? raw.font
      : (typeof raw.font === 'string' && media.hasFontPreset(raw.font) ? raw.font : null);
    if (strict && raw.font !== undefined && raw.font !== null && raw.font !== ''
      && raw.font !== 'display' && raw.font !== 'body' && !media.hasFontPreset(raw.font)) {
      return { error: `字体不存在：${raw.font}` };
    }
    if (strict && raw.color !== undefined && !HEX_COLOR.test(raw.color)) {
      return { error: '文字颜色需为 #RRGGBB' };
    }
    Object.assign(element, {
      text: typeof raw.text === 'string' ? raw.text.slice(0, LAYOUT_MAX_TEXT) : '',
      unit: typeof raw.unit === 'string' ? raw.unit.slice(0, 8) : '',
      font,
      size: Math.round(clampNumber(raw.size, 8, 160, 16)),
      weight: LAYOUT_WEIGHTS.includes(raw.weight) ? raw.weight : 400,
      color: HEX_COLOR.test(raw.color) ? raw.color.toLowerCase() : '#f4f7ff',
      align: LAYOUT_ALIGNS.includes(raw.align) ? raw.align : 'center',
      lineHeight: clampNumber(raw.lineHeight, 1, 3, 1.25),
    });
  } else {
    if (strict && !DECOR_SRC.test(raw.src || '')) return { error: '图片地址不合法' };
    if (!DECOR_SRC.test(raw.src || '')) return { value: null };
    Object.assign(element, {
      src: raw.src,
      h: clampNumber(raw.h, 10, LAYOUT_HEIGHT, 120),
      fit: raw.fit === 'cover' ? 'cover' : 'contain',
      radius: Math.round(clampNumber(raw.radius, 0, 100, 0)),
    });
  }
  return { value: element };
}

function layoutConfig(raw, strict) {
  const layout = {};
  if (raw === undefined || raw === null) return { layout };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return strict ? { error: '页面排版格式不对' } : { layout };
  }
  for (const key of Object.keys(raw)) {
    if (!PAGE_KEY.test(key)) {
      if (strict) return { error: `未知页面：${key}` };
      continue;
    }
    const page = raw[key];
    if (!page || typeof page !== 'object' || !Array.isArray(page.elements)) {
      if (strict) return { error: '页面元素必须是数组' };
      continue;
    }
    const elements = [];
    for (const [index, item] of page.elements.slice(0, LAYOUT_MAX_ELEMENTS).entries()) {
      const parsed = layoutElement(item, strict, index);
      if (parsed.error) return parsed;
      if (parsed.value) elements.push(parsed.value);
    }
    if (elements.length > 0) layout[key] = { elements };
  }
  return { layout };
}

// 宽松归一化：读库/渲染时用，坏值静默丢掉，保证报告永远可渲染
function normalizeConfig(raw) {
  const config = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return config;

  if (raw.base && typeof raw.base === 'object') {
    for (const key of ['accent', 'accent2', 'scrimColor']) {
      if (HEX_COLOR.test(raw.base[key])) config.base[key] = raw.base[key].toLowerCase();
    }
    if (isScrim(raw.base.scrim)) config.base.scrim = roundScrim(raw.base.scrim);
  }

  if (raw.fonts && typeof raw.fonts === 'object') {
    for (const slot of ['display', 'body']) {
      const choice = raw.fonts[slot];
      if (choice === null || choice === undefined || choice === '') config.fonts[slot] = null;
      else if (choice === 'custom' || (typeof choice === 'string' && media.hasFontPreset(choice))) config.fonts[slot] = choice;
    }
  }

  if (raw.motion && typeof raw.motion === 'object') {
    for (const key of ['notes', 'ambient']) {
      if (typeof raw.motion[key] === 'boolean') config.motion[key] = raw.motion[key];
    }
  }

  if (raw.pages && typeof raw.pages === 'object' && !Array.isArray(raw.pages)) {
    for (const key of Object.keys(raw.pages)) {
      if (!PAGE_KEY.test(key)) continue;
      const parsed = pageOverride(raw.pages[key], false);
      if (parsed.value) config.pages[key] = parsed.value;
    }
  }

  config.layout = layoutConfig(raw.layout, false).layout;

  return config;
}

// 严格校验：管理员保存时用，非法值直接拒绝
function validateConfig(raw) {
  if (raw === undefined || raw === null) return { config: defaultConfig() };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: '主题配置格式不对' };
  const config = defaultConfig();

  if (raw.base !== undefined) {
    if (!raw.base || typeof raw.base !== 'object' || Array.isArray(raw.base)) return { error: '颜色配置格式不对' };
    for (const key of ['accent', 'accent2', 'scrimColor']) {
      if (raw.base[key] === undefined) continue;
      if (!HEX_COLOR.test(raw.base[key])) return { error: `颜色 ${key} 需为 #RRGGBB` };
      config.base[key] = raw.base[key].toLowerCase();
    }
    if (raw.base.scrim !== undefined) {
      if (!isScrim(raw.base.scrim)) return { error: '暗层强度需在 0–0.9 之间' };
      config.base.scrim = roundScrim(raw.base.scrim);
    }
  }

  if (raw.fonts !== undefined) {
    if (!raw.fonts || typeof raw.fonts !== 'object' || Array.isArray(raw.fonts)) return { error: '字体配置格式不对' };
    for (const slot of ['display', 'body']) {
      const choice = raw.fonts[slot];
      if (choice === undefined) continue;
      if (choice === null || choice === '') config.fonts[slot] = null;
      else if (choice === 'custom') config.fonts[slot] = 'custom';
      else if (typeof choice === 'string' && media.hasFontPreset(choice)) config.fonts[slot] = choice;
      else return { error: `字体不存在：${choice}` };
    }
  }

  if (raw.motion !== undefined) {
    if (!raw.motion || typeof raw.motion !== 'object' || Array.isArray(raw.motion)) return { error: '动效配置格式不对' };
    for (const key of ['notes', 'ambient']) {
      if (raw.motion[key] === undefined) continue;
      if (typeof raw.motion[key] !== 'boolean') return { error: '动效开关需为布尔值' };
      config.motion[key] = raw.motion[key];
    }
  }

  if (raw.pages !== undefined) {
    if (!raw.pages || typeof raw.pages !== 'object' || Array.isArray(raw.pages)) return { error: '按页覆盖的格式不对' };
    for (const key of Object.keys(raw.pages)) {
      if (!PAGE_KEY.test(key)) return { error: `未知页面：${key}` };
      const parsed = pageOverride(raw.pages[key], true);
      if (parsed.error) return parsed;
      if (parsed.value) config.pages[key] = parsed.value;
    }
  }

  if (raw.layout !== undefined) {
    const parsed = layoutConfig(raw.layout, true);
    if (parsed.error) return parsed;
    config.layout = parsed.layout;
  }

  return { config };
}

/* ---------- 行解析与 CRUD ---------- */

function parseRow(row) {
  let config;
  let invalid = false;
  try {
    config = normalizeConfig(JSON.parse(row.config));
  } catch {
    config = defaultConfig();
    invalid = true;
  }
  return {
    id: row.id,
    name: row.name,
    config,
    isDefault: Boolean(row.is_default),
    invalid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getThemeRow(db, id) {
  if (!id || !THEME_ID.test(id)) return null;
  return db.prepare('SELECT * FROM themes WHERE id = ?').get(id) || null;
}

function getTheme(db, id) {
  const row = getThemeRow(db, id);
  return row ? parseRow(row) : null;
}

function defaultRow(db) {
  return db.prepare('SELECT * FROM themes WHERE is_default = 1 ORDER BY datetime(created_at) ASC, id ASC LIMIT 1').get()
    || db.prepare("SELECT * FROM themes WHERE id = 'default'").get()
    || db.prepare('SELECT * FROM themes ORDER BY datetime(created_at) ASC, id ASC LIMIT 1').get()
    || null;
}

// 空库或默认主题被手工删掉时补一个，保证 /api/report 永远有主题可用
function ensureDefault(db) {
  const total = db.prepare('SELECT count(*) AS c FROM themes').get().c;
  if (total === 0) {
    db.prepare('INSERT INTO themes (id, name, config, is_default) VALUES (?, ?, ?, 1)')
      .run('default', '默认主题', JSON.stringify(DEFAULT_THEME));
    return;
  }
  if (!db.prepare('SELECT 1 FROM themes WHERE is_default = 1').get()) {
    const first = db.prepare('SELECT id FROM themes ORDER BY datetime(created_at) ASC, id ASC LIMIT 1').get();
    if (first) db.prepare('UPDATE themes SET is_default = 1 WHERE id = ?').run(first.id);
  }
}

function listThemes(db) {
  const usage = new Map(
    db.prepare("SELECT theme, count(*) AS c FROM students WHERE theme IS NOT NULL AND theme != '' GROUP BY theme")
      .all()
      .map(row => [row.theme, row.c])
  );
  return db.prepare('SELECT * FROM themes ORDER BY datetime(created_at) ASC, id ASC').all()
    .map(row => ({ ...parseRow(row), usage: usage.get(row.id) || 0 }));
}

function createTheme(db, name, config) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO themes (id, name, config, is_default) VALUES (?, ?, ?, 0)')
    .run(id, name, JSON.stringify(config));
  return getTheme(db, id);
}

function updateTheme(db, id, name, config) {
  db.prepare("UPDATE themes SET name = ?, config = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, JSON.stringify(config), id);
  return getTheme(db, id);
}

function setDefault(db, id) {
  db.transaction(() => {
    db.prepare('UPDATE themes SET is_default = 0').run();
    db.prepare("UPDATE themes SET is_default = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  })();
}

function duplicateTheme(db, id, name) {
  const row = getThemeRow(db, id);
  if (!row) return null;
  const { config } = parseRow(row);
  return createTheme(db, name, config);
}

function deleteTheme(db, id) {
  const row = getThemeRow(db, id);
  if (!row) return { error: 'not_found' };
  if (row.is_default) return { error: 'default' };
  const usage = db.prepare('SELECT count(*) AS c FROM students WHERE theme = ?').get(id).c;
  if (usage > 0) return { error: 'in_use', usage };
  db.prepare('DELETE FROM themes WHERE id = ?').run(id);
  return { success: true };
}

/* ---------- 报告端解析 ---------- */

// 成员配置的主题可能已被删除/损坏：一律回落到默认主题，绝不让报告 500
function resolveForReport(db, themeId) {
  const row = getThemeRow(db, themeId) || defaultRow(db);
  let config = defaultConfig();
  if (row) {
    try {
      config = normalizeConfig(JSON.parse(row.config));
    } catch {
      config = defaultConfig();
    }
  }
  const presets = {};
  for (const preset of media.listFontPresets()) presets[preset.id] = preset.url;

  return {
    id: row ? row.id : 'default',
    base: config.base,
    motion: config.motion,
    pages: config.pages,
    layout: config.layout,
    fonts: {
      display: media.resolveFontUrl(config.fonts.display, 'display'),
      body: media.resolveFontUrl(config.fonts.body, 'body'),
      presets,
    },
  };
}

module.exports = {
  DEFAULT_THEME,
  defaultConfig,
  normalizeName,
  normalizeConfig,
  validateConfig,
  ensureDefault,
  listThemes,
  getTheme,
  getThemeRow,
  createTheme,
  updateTheme,
  setDefault,
  duplicateTheme,
  deleteTheme,
  resolveForReport,
};
