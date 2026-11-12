const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'report.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT,
    join_date TEXT,
    volunteer_hours REAL,
    activity_count INTEGER,
    partner TEXT,
    message TEXT,
    bg_dir TEXT,
    bg_music TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT,
    expire INTEGER
  );

  CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    password_changed_at TEXT,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// CREATE TABLE IF NOT EXISTS 不会给已存在的表补字段，老库需要手动补列
const studentColumns = db.prepare('PRAGMA table_info(students)').all().map(column => column.name);
for (const column of [
  'bg_dir', 'bg_music', 'join_date', 'theme',
  'activities', 'activity1_name', 'activity1_date', 'activity1_work',
  'activity2_name', 'activity2_date', 'activity2_work', 'keyword', 'keyword_reason',
]) {
  if (!studentColumns.includes(column)) db.exec(`ALTER TABLE students ADD COLUMN ${column} TEXT`);
}
if (!studentColumns.includes('partner_count')) db.exec('ALTER TABLE students ADD COLUMN partner_count INTEGER');

// 「加入天数」改为「入会日期」：老库按“今天往前推 N 天”折算成日期，然后删掉旧列
if (studentColumns.includes('join_days')) {
  db.exec("UPDATE students SET join_date = date('now', '-' || join_days || ' days') WHERE join_date IS NULL AND join_days IS NOT NULL");
  db.exec('ALTER TABLE students DROP COLUMN join_days');
}

// 成员端改为「姓名 + 学号」登录，密码字段不再使用
if (studentColumns.includes('password_hash')) db.exec('ALTER TABLE students DROP COLUMN password_hash');

// 老库没有默认主题时补一条；必须放在 students.theme 列补齐之后
require('./lib/themes').ensureDefault(db);
// 页面注册表与年度设置：空库或页面被全部删掉时补默认 8 页
require('./lib/pages').seed(db);
// 一次性把早前生成的默认排版模板垂直居中（只动与旧模板完全一致的页面）
require('./lib/layout-migrate').migrateDefaultLayouts(db);

module.exports = db;
