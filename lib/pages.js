// 页面注册表：页面类型固定，数量/顺序/启用可配置。
// 背景图槽位直接使用页面 key（成员目录/<key>.(jpg|png|...)）。
const DEFAULT_TYPES = {
  cover: '封面',
  stat: '数字统计',
  activities: '活动列表',
  memory: '活动回忆',
  partners: '同行伙伴',
  keyword: '年度关键词',
  message: '部长寄语',
};

const PAGE_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TITLE_MAX = 32;

const DEFAULT_PAGES = [
  { key: '01-cover', type: 'cover', title: '封面｜你的年度回顾', config: {}, position: 1 },
  { key: '02-hours', type: 'stat', title: '志愿时长｜你投入的时间', config: { field: 'volunteerHours' }, position: 2 },
  { key: '03-activities', type: 'activities', title: '活动足迹｜你参与的精彩', config: {}, position: 3 },
  { key: '04-memory-1', type: 'memory', title: '活动回忆①｜定格一次投入', config: { index: 1 }, position: 4 },
  { key: '05-memory-2', type: 'memory', title: '活动回忆②｜再看一个瞬间', config: { index: 2 }, position: 5 },
  { key: '06-partners', type: 'partners', title: '同行伙伴｜这一年，我们一起', config: {}, position: 6 },
  { key: '07-keyword', type: 'keyword', title: '年度关键词｜属于你的部门身份', config: {}, position: 7 },
  { key: '08-message', type: 'message', title: '部长寄语｜把温暖带向下一年', config: {}, position: 8 },
];

function defaultPages() {
  return DEFAULT_PAGES.map(page => ({
    ...page,
    config: { ...page.config },
    enabled: true,
    typeLabel: DEFAULT_TYPES[page.type],
  }));
}

function parseRow(row) {
  let config = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  const type = Object.prototype.hasOwnProperty.call(DEFAULT_TYPES, row.type) ? row.type : 'message';
  return {
    key: row.key,
    type,
    typeLabel: DEFAULT_TYPES[type],
    title: row.title,
    position: Number(row.position) || 0,
    enabled: Boolean(row.enabled),
    config: normalizeConfig(type, config, false).config,
  };
}

function normalizeConfig(type, raw, strict) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_TYPES, type)) {
    return strict ? { error: '页面类型不合法' } : { config: {} };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return strict ? { error: '页面配置格式不对' } : { config: {} };
  }
  if (type === 'stat') {
    const field = raw.field === 'activityCount' ? 'activityCount' : raw.field === 'volunteerHours' ? 'volunteerHours' : null;
    if (!field) return strict ? { error: '数字页配置只能是 volunteerHours 或 activityCount' } : { config: { field: 'volunteerHours' } };
    return { config: { field } };
  }
  if (type === 'memory') {
    const index = raw.index === 2 ? 2 : raw.index === 1 ? 1 : null;
    if (!index) return strict ? { error: '活动回忆页配置只能是 1 或 2' } : { config: { index: 1 } };
    return { config: { index } };
  }
  return { config: {} };
}

function normalizeTitle(value) {
  const title = String(value ?? '').trim();
  return title && title.length <= TITLE_MAX ? title : null;
}

function listPages(db) {
  return db.prepare('SELECT * FROM pages ORDER BY position ASC, key ASC').all().map(parseRow);
}

// 全部禁用时回退到默认 8 页，保证报告不会渲染空 Swiper
function enabledPages(db) {
  const enabled = listPages(db).filter(page => page.enabled);
  return enabled.length > 0 ? enabled : defaultPages();
}

function pageKeys(db) {
  return enabledPages(db).map(page => page.key);
}

function getPage(db, key) {
  const row = db.prepare('SELECT * FROM pages WHERE key = ?').get(key);
  return row ? parseRow(row) : null;
}

function createPage(db, input) {
  const type = String((input && input.type) || '');
  const checked = normalizeConfig(type, (input && input.config) || {}, true);
  if (checked.error) return { error: checked.error };
  const title = normalizeTitle(input && input.title);
  if (!title) return { error: '页面标题需为 1–32 个字符' };

  const base = `page-${type}-${Date.now().toString(36)}`;
  let key = base;
  let suffix = 1;
  while (db.prepare('SELECT 1 FROM pages WHERE key = ?').get(key)) key = `${base}-${suffix++}`;

  const position = (db.prepare('SELECT max(position) AS max FROM pages').get().max || 0) + 1;
  db.prepare('INSERT INTO pages (key, type, title, position, enabled, config) VALUES (?, ?, ?, ?, 1, ?)')
    .run(key, type, title, position, JSON.stringify(checked.config));
  return { page: getPage(db, key) };
}

function updatePage(db, key, input) {
  const existing = getPage(db, key);
  if (!existing) return { error: 'not_found' };
  const type = input && input.type !== undefined ? String(input.type) : existing.type;
  const checked = normalizeConfig(type, input && input.config !== undefined ? input.config : existing.config, true);
  if (checked.error) return { error: checked.error };
  const title = input && input.title !== undefined ? normalizeTitle(input.title) : existing.title;
  if (!title) return { error: '页面标题需为 1–32 个字符' };
  const enabled = input && input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled;
  db.prepare('UPDATE pages SET type = ?, title = ?, enabled = ?, config = ? WHERE key = ?')
    .run(type, title, enabled ? 1 : 0, JSON.stringify(checked.config), key);
  return { page: getPage(db, key) };
}

function deletePage(db, key) {
  const info = db.prepare('DELETE FROM pages WHERE key = ?').run(key);
  return info.changes > 0 ? { success: true } : { error: 'not_found' };
}

function movePage(db, key, direction) {
  const all = listPages(db);
  const index = all.findIndex(page => page.key === key);
  if (index < 0) return { error: 'not_found' };
  const target = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
  if (target < 0 || target >= all.length) return { success: true };
  db.transaction(() => {
    const swap = all.slice();
    [swap[index], swap[target]] = [swap[target], swap[index]];
    const update = db.prepare('UPDATE pages SET position = ? WHERE key = ?');
    swap.forEach((page, i) => update.run(i + 1, page.key));
  })();
  return { success: true };
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
  return getSetting(db, key);
}

function seed(db) {
  const total = db.prepare('SELECT count(*) AS c FROM pages').get().c;
  if (total === 0) {
    const insert = db.prepare('INSERT INTO pages (key, type, title, position, enabled, config) VALUES (?, ?, ?, ?, 1, ?)');
    db.transaction(() => {
      for (const page of DEFAULT_PAGES) insert.run(page.key, page.type, page.title, page.position, JSON.stringify(page.config));
    })();
  }
  if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get('report_year')) {
    setSetting(db, 'report_year', String(new Date().getFullYear()));
  }
}

module.exports = {
  DEFAULT_TYPES,
  DEFAULT_PAGES,
  PAGE_KEY_RE,
  normalizeConfig,
  normalizeTitle,
  defaultPages,
  listPages,
  enabledPages,
  pageKeys,
  getPage,
  createPage,
  updatePage,
  deletePage,
  movePage,
  getSetting,
  setSetting,
  seed,
};
