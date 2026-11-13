// 一次性迁移：修正早期默认排版的对齐问题。
// 只处理 id/类型/纵坐标都匹配旧模板的页面；有任何自定义元素或位置变化就跳过，避免覆盖用户排版。
const TEMPLATES = {
  cover: {
    't-year': { type: 'text', old: 200, next: 337 },
    't-name': { type: 'text', old: 240, next: 377 },
    't-dept': { type: 'text', old: 300, next: 437 },
    't-dedication': { type: 'text', old: 350, next: 487 },
    't-hint': { type: 'text', old: 600, next: 600 },
  },
  stat: {
    't-line': { type: 'text', old: 250, next: 330 },
    't-num': { type: 'text', old: 292, next: 372 },
    't-sub': { type: 'text', old: 410, next: 490 },
  },
  activities: {
    't-title': { type: 'text', old: 220, next: 250 },
    't-line': { type: 'text', old: 265, next: 295 },
    't-num': { type: 'text', old: 305, next: 335 },
    't-list': { type: 'text', old: 420, next: 450 },
    't-sub': { type: 'text', old: 540, next: 575 },
  },
  memory: {
    't-title': { type: 'text', old: 100, next: 135 },
    't-name': { type: 'text', old: 150, next: 185 },
    't-date': { type: 'text', old: 215, next: 250 },
    't-work': { type: 'text', old: 255, next: 290 },
    't-photo-1': { type: 'extra', old: 380, next: 415 },
    't-photo-2': { type: 'extra', old: 380, next: 415 },
    't-sub': { type: 'text', old: 650, next: 685 },
  },
  partners: {
    't-line': { type: 'text', old: 160, next: 200 },
    't-num': { type: 'text', old: 200, next: 240 },
    't-sub': { type: 'text', old: 320, next: 360 },
    't-photo-1': { type: 'extra', old: 400, next: 440 },
  },
  keyword: {
    't-line': { type: 'text', old: 240, next: 330 },
    't-keyword': { type: 'text', old: 285, next: 378 },
    't-reason': { type: 'text', old: 360, next: 458 },
  },
  message: {
    't-line': { type: 'text', old: 220, next: 190 },
    't-message': { type: 'text', old: 270, next: 245 },
    't-closing': { type: 'text', old: 600, next: 640 },
  },
};

const MIGRATION_KEY = 'layout_center_v1';

// 活动足迹页的第二次修正：底部字幕不参与居中，主体（标题/说明/数字/列表）单独围绕画布中心
const ACTIVITIES_KEY_V2 = 'layout_activities_v2';
const ACTIVITIES_V2 = {
  't-title': { type: 'text', from: 250, to: 312 },
  't-line': { type: 'text', from: 295, to: 357 },
  't-num': { type: 'text', from: 335, to: 397 },
  't-list': { type: 'text', from: 450, to: 512 },
  't-sub': { type: 'text', from: 575, to: 575 },
};

function matchesTemplate(elements, template, fromField) {
  const ids = Object.keys(template);
  if (!Array.isArray(elements) || elements.length !== ids.length) return false;
  const byId = new Map(elements.map(element => [element && element.id, element]));
  if (byId.size !== ids.length) return false;
  return ids.every(id => {
    const element = byId.get(id);
    const spec = template[id];
    return element && element.type === spec.type && element.y === spec[fromField];
  });
}

function hasSetting(db, key) {
  return Boolean(db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key));
}

function markSetting(db, key) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, '1');
}

function loadPages(db) {
  const pageTypes = new Map();
  for (const row of db.prepare('SELECT key, type, config FROM pages').all()) {
    let config = {};
    try {
      config = JSON.parse(row.config);
    } catch {
      config = {};
    }
    pageTypes.set(row.key, { type: row.type, config });
  }
  return pageTypes;
}

function themeLayouts(db, callback) {
  const update = db.prepare('UPDATE themes SET config = ?, updated_at = datetime(\'now\') WHERE id = ?');
  let pagesMoved = 0;
  let themesChanged = 0;

  for (const row of db.prepare('SELECT id, config FROM themes').all()) {
    let config;
    try {
      config = JSON.parse(row.config);
    } catch {
      continue;
    }
    if (!config || typeof config.layout !== 'object' || !config.layout) continue;

    let changed = false;
    for (const [key, page] of Object.entries(config.layout)) {
      if (!page || !Array.isArray(page.elements)) continue;
      if (callback(key, page.elements)) {
        changed = true;
        pagesMoved += 1;
      }
    }
    if (changed) {
      update.run(JSON.stringify(config), row.id);
      themesChanged += 1;
    }
  }
  return { pages: pagesMoved, themes: themesChanged };
}

function migrateDefaultLayouts(db) {
  const result = { skipped: true, pages: 0, themes: 0 };

  if (!hasSetting(db, MIGRATION_KEY)) {
    result.skipped = false;
    const pageTypes = loadPages(db);
    const moved = db.transaction(() => themeLayouts(db, (key, elements) => {
      const pageInfo = pageTypes.get(key);
      const template = pageInfo && TEMPLATES[pageInfo.type];
      if (!template || !matchesTemplate(elements, template, 'old')) return false;
      for (const element of elements) element.y = template[element.id].next;
      return true;
    }))();
    markSetting(db, MIGRATION_KEY);
    result.pages += moved.pages;
    result.themes += moved.themes;
    if (moved.pages > 0) {
      console.log(`[layout-migrate] centered ${moved.pages} page layout(s) in ${moved.themes} theme(s)`);
    }
  }

  if (!hasSetting(db, ACTIVITIES_KEY_V2)) {
    result.skipped = false;
    const pageTypes = loadPages(db);
    const moved = db.transaction(() => themeLayouts(db, (key, elements) => {
      const pageInfo = pageTypes.get(key);
      if (!pageInfo || pageInfo.type !== 'activities') return false;
      if (!matchesTemplate(elements, ACTIVITIES_V2, 'from')) return false;
      for (const element of elements) element.y = ACTIVITIES_V2[element.id].to;
      return true;
    }))();
    markSetting(db, ACTIVITIES_KEY_V2);
    result.pages += moved.pages;
    result.themes += moved.themes;
    if (moved.pages > 0) {
      console.log(`[layout-migrate] recentered activities page in ${moved.themes} theme(s)`);
    }
  }

  return result;
}

module.exports = {
  migrateDefaultLayouts,
  TEMPLATES,
  MIGRATION_KEY,
  ACTIVITIES_V2,
  ACTIVITIES_KEY_V2,
};
