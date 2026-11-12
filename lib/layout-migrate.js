// 一次性迁移：早期默认排版模板整体偏上，这里把「与旧模板完全一致」的排版垂直居中。
// 只处理 id/类型/y 都匹配旧模板的页面；有任何自定义元素或位置变化就跳过，避免覆盖用户排版。
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

function matchesTemplate(elements, template) {
  const ids = Object.keys(template);
  if (!Array.isArray(elements) || elements.length !== ids.length) return false;
  const byId = new Map(elements.map(element => [element && element.id, element]));
  if (byId.size !== ids.length) return false;
  return ids.every(id => {
    const element = byId.get(id);
    const spec = template[id];
    return element && element.type === spec.type && element.y === spec.old;
  });
}

function migrateDefaultLayouts(db) {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)) {
    return { skipped: true, pages: 0, themes: 0 };
  }

  const pageRows = db.prepare('SELECT key, type, config FROM pages').all();
  const pageTypes = new Map();
  for (const row of pageRows) {
    let config = {};
    try {
      config = JSON.parse(row.config);
    } catch {
      config = {};
    }
    pageTypes.set(row.key, { type: row.type, config });
  }

  const update = db.prepare('UPDATE themes SET config = ?, updated_at = datetime(\'now\') WHERE id = ?');
  const themes = db.prepare('SELECT id, config FROM themes').all();
  let pagesMoved = 0;
  let themesChanged = 0;

  db.transaction(() => {
    for (const row of themes) {
      let config;
      try {
        config = JSON.parse(row.config);
      } catch {
        continue;
      }
      if (!config || typeof config.layout !== 'object' || !config.layout) continue;
      let changed = false;

      for (const [key, page] of Object.entries(config.layout)) {
        const pageInfo = pageTypes.get(key);
        const template = pageInfo && TEMPLATES[pageInfo.type];
        const elements = page && Array.isArray(page.elements) ? page.elements : null;
        if (!template || !elements || !matchesTemplate(elements, template)) continue;

        for (const element of elements) {
          element.y = template[element.id].next;
        }
        changed = true;
        pagesMoved += 1;
      }

      if (changed) {
        update.run(JSON.stringify(config), row.id);
        themesChanged += 1;
      }
    }

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(MIGRATION_KEY, '1');
  })();

  if (pagesMoved > 0) {
    console.log(`[layout-migrate] centered ${pagesMoved} page layout(s) in ${themesChanged} theme(s)`);
  }
  return { skipped: false, pages: pagesMoved, themes: themesChanged };
}

module.exports = { migrateDefaultLayouts, TEMPLATES, MIGRATION_KEY };
