// 主题的单一规则来源：配置校验、主题 CRUD、报告端解析。
// 主题只允许受控字段，不接受任意 CSS；登录页与面板不套主题。
const crypto = require('crypto');
const media = require('./media');

const NAME_MAX = 32;
const THEME_ID = /^[A-Za-z0-9_-]{1,40}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// 默认值与 static/style.css 的 :root 保持一致：没有主题时外观零变化
const DEFAULT_THEME = {
  base: { accent: '#7dd3fc', accent2: '#bcd6ff', scrim: 0.45, scrimColor: '#060a14' },
  fonts: { display: null, body: null },
  motion: { notes: true, record: true },
  pages: {},
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
    for (const key of ['notes', 'record']) {
      if (typeof raw.motion[key] === 'boolean') config.motion[key] = raw.motion[key];
    }
  }

  if (raw.pages && typeof raw.pages === 'object' && !Array.isArray(raw.pages)) {
    for (const key of Object.keys(raw.pages)) {
      if (!media.PAGE_KEYS.includes(key)) continue;
      const parsed = pageOverride(raw.pages[key], false);
      if (parsed.value) config.pages[key] = parsed.value;
    }
  }

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
    for (const key of ['notes', 'record']) {
      if (raw.motion[key] === undefined) continue;
      if (typeof raw.motion[key] !== 'boolean') return { error: '动效开关需为布尔值' };
      config.motion[key] = raw.motion[key];
    }
  }

  if (raw.pages !== undefined) {
    if (!raw.pages || typeof raw.pages !== 'object' || Array.isArray(raw.pages)) return { error: '按页覆盖的格式不对' };
    for (const key of Object.keys(raw.pages)) {
      if (!media.PAGE_KEYS.includes(key)) return { error: `未知页面：${key}` };
      const parsed = pageOverride(raw.pages[key], true);
      if (parsed.error) return parsed;
      if (parsed.value) config.pages[key] = parsed.value;
    }
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

// 学员配置的主题可能已被删除/损坏：一律回落到默认主题，绝不让报告 500
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
  return {
    id: row ? row.id : 'default',
    base: config.base,
    motion: config.motion,
    pages: config.pages,
    fonts: {
      display: media.resolveFontUrl(config.fonts.display, 'display'),
      body: media.resolveFontUrl(config.fonts.body, 'body'),
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
