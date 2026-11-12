const express = require('express');
const session = require('express-session');
const db = require('./db');
const media = require('./lib/media');
const themes = require('./lib/themes');
const report = require('./lib/report');
const loginCopy = require('./lib/login-copy');
const createAdminRouter = require('./routes/admin');
const SQLiteSessionStore = require('./session-store');
const { AttemptLimiter } = require('./rate-limit');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'report.sid';
const ADMIN_COOKIE_NAME = 'report.admin.sid';
const STUDENT_SESSION_MS = 1000 * 60 * 60 * 24 * 7;
const ADMIN_SESSION_MS = 1000 * 60 * 60 * 12;

if (!SESSION_SECRET) {
  console.error('缺少环境变量 SESSION_SECRET，拒绝启动');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// 不做 CORS，用不到 OPTIONS 预检；Express 默认会对已注册路径回 200 + Allow，
// 相当于未鉴权就能探出哪些管理接口存在，这里统一按「未知接口」处理
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.status(404).json({ error: '接口不存在' });
  next();
});

// API 响应一律不缓存：里面是成员个人信息，别留在浏览器磁盘缓存里
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const sessionStore = new SQLiteSessionStore(db);
const sessionBase = { secret: SESSION_SECRET, store: sessionStore, resave: false, saveUninitialized: false };

// 管理员与成员用两套独立会话（独立 cookie）：登录/退出互不影响
const adminSession = session({
  ...sessionBase,
  name: ADMIN_COOKIE_NAME,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: ADMIN_SESSION_MS },
});
const studentSession = session({
  ...sessionBase,
  name: COOKIE_NAME,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: STUDENT_SESSION_MS },
});

// 管理接口自带 body 解析（上限更高），必须挂在全局 express.json() 之前，
// 否则几百人的批量文本会先被全局默认的 100kb 上限拦成 413
app.use('/api/admin', adminSession, createAdminRouter({ db, cookieName: ADMIN_COOKIE_NAME }));

// 成员端会话（管理路由之后挂载）
app.use(studentSession);

app.use(express.json());

const findStudentForLogin = db.prepare('SELECT student_id, name FROM students WHERE student_id = ?');
const findReport = db.prepare('SELECT * FROM students WHERE student_id = ?');

/* ---------- 防暴力破解 ---------- */
// 同学号 5 次失败锁 10 分钟；同 IP 放宽到 30 次，避免校园网共用出口被一个人拖累
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const studentLimiter = new AttemptLimiter({ maxFailures: 5, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_MS });
const ipLimiter = new AttemptLimiter({ maxFailures: 30, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_MS });

function lockedSeconds(req, studentId) {
  const targets = [
    [studentLimiter, `student:${studentId}`],
    [ipLimiter, `ip:${req.ip}`],
  ];
  let seconds = 0;
  for (const [limiter, key] of targets) {
    const retry = limiter.retryAfterSeconds(key);
    if (retry && retry > seconds) seconds = retry;
  }
  return seconds;
}

function recordFailure(req, studentId) {
  studentLimiter.fail(`student:${studentId}`);
  ipLimiter.fail(`ip:${req.ip}`);
}

function clearFailures(req, studentId) {
  studentLimiter.succeed(`student:${studentId}`);
  ipLimiter.succeed(`ip:${req.ip}`);
}

function lockedResponse(res, seconds) {
  res.status(429).json({ error: `错误次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试` });
}

/* ---------- 成员专属的背景图与背景音乐：解析逻辑在 lib/media.js ---------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  });
});

// 登录页前言是公开文案，不含任何成员信息；未设置时返回默认值
app.get('/api/login-copy', (req, res) => {
  res.json({ preface: loginCopy.getPreface(db) });
});

app.post('/api/login', (req, res) => {
  const { studentId, name } = req.body || {};
  if (typeof studentId !== 'string' || typeof name !== 'string' || !studentId.trim() || !name.trim()) {
    return res.status(400).json({ error: '请填写姓名和学号' });
  }

  const id = studentId.trim();
  const displayName = name.trim();
  const locked = lockedSeconds(req, id);
  if (locked > 0) return lockedResponse(res, locked);

  const student = findStudentForLogin.get(id);
  if (!student || String(student.name || '').trim() !== displayName) {
    recordFailure(req, id);
    return res.status(401).json({ error: '姓名或学号不正确' });
  }

  clearFailures(req, id);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: '登录失败，请重试' });
    req.session.studentId = student.student_id;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: '登录失败，请重试' });
      res.json({ success: true });
    });
  });
});

app.get('/api/report', (req, res) => {
  const studentId = req.session.studentId;
  if (!studentId) return res.status(401).json({ error: '未登录' });

  const row = findReport.get(studentId);
  if (!row) return res.status(401).json({ error: '未登录' });

  res.json(report.buildReport(db, row, row.theme));
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: '退出失败' });
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status === 413) return res.status(413).json({ error: '请求内容过大' });
  if (status === 400 && err.type) return res.status(400).json({ error: '请求格式错误' });
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '服务器内部错误' : err.message || '请求有误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`年度报告后端已启动，监听端口 ${PORT}`);
});
