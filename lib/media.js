const fs = require('fs');
const path = require('path');

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'static');

// 数组顺序即优先级：同一个名字有多个格式时取排在前面的
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.ogg', '.wav'];
const FONT_EXTENSIONS = ['.woff2', '.woff'];

// 新版页面 key 与旧版背景图目录的兼容映射：新 key 没图时回退旧文件
const BACKGROUND_ALIASES = {
  '01-cover': ['01-opening'],
  '02-hours': ['03-hours'],
  '03-activities': ['04-activities'],
  '06-partners': ['05-partner'],
  '08-message': ['06-message', '07-ending'],
};

const KINDS = {
  image: { dir: 'images', extensions: IMAGE_EXTENSIONS },
  music: { dir: 'music', extensions: AUDIO_EXTENSIONS },
  font: { dir: 'fonts/custom', extensions: FONT_EXTENSIONS }, // 自定义字体只有 display/body 两个槽位
  decor: { dir: 'images/decor', extensions: IMAGE_EXTENSIONS }, // 排版编辑器用的贴纸/装饰图
};

const UNSAFE_SEGMENT = /[/\\:*?"<>|\x00-\x1f]/;

function mediaRoot(kind) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`未知的资源类型：${kind}`);
  return { root: path.join(STATIC_DIR, spec.dir), extensions: spec.extensions };
}

/* ---------- 通用文件列举 ---------- */

function listFiles(dir, extensions) {
  try {
    return fs.readdirSync(dir)
      .filter(name => extensions.includes(path.extname(name).toLowerCase()))
      .sort((a, b) => {
        const priority = extensions.indexOf(path.extname(a).toLowerCase()) - extensions.indexOf(path.extname(b).toLowerCase());
        return priority !== 0 ? priority : a.localeCompare(b);
      });
  } catch {
    return []; // 目录不存在就等于没配资源
  }
}

// 同一个基名下只保留优先级最高的那个文件
function byBasename(files) {
  const map = new Map();
  for (const name of files) {
    const base = path.parse(name).name;
    if (!map.has(base)) map.set(base, name);
  }
  return map;
}

/* ---------- URL 与抗缓存 ---------- */

// nginx 对 /images/、/music/ 设了 30 天缓存，所以 URL 必须带文件指纹，换图后浏览器才会重新拉
function withVersion(absPath, url) {
  try {
    const stat = fs.statSync(absPath);
    return `${url}?v=${Math.round(stat.mtimeMs)}-${stat.size}`;
  } catch {
    return url;
  }
}

const URL_BASE = { image: '/images', music: '/music', font: '/fonts/custom', decor: '/images/decor' };

function fileUrl(kind, dir, name) {
  const base = URL_BASE[kind] || '/images';
  return dir ? `${base}/${encodeURIComponent(dir)}/${encodeURIComponent(name)}` : `${base}/${encodeURIComponent(name)}`;
}

/* ---------- 成员报告用：解析出可用资源 ---------- */

// 键是去掉扩展名的文件名（页面写 data-bg="01-opening"），成员目录优先于共享目录
function buildBackgroundMap(studentId, bgDir) {
  const ownDir = isSafeSegment(bgDir) ? bgDir : studentId; // 目录名非法就退回学号，不让脏数据影响渲染
  const result = {};
  const sharedRoot = path.join(STATIC_DIR, 'images');
  for (const name of byBasename(listFiles(sharedRoot, IMAGE_EXTENSIONS)).values()) {
    result[path.parse(name).name] = withVersion(path.join(sharedRoot, name), fileUrl('image', null, name));
  }
  const ownRoot = path.join(sharedRoot, ownDir);
  for (const name of byBasename(listFiles(ownRoot, IMAGE_EXTENSIONS)).values()) {
    result[path.parse(name).name] = withVersion(path.join(ownRoot, name), fileUrl('image', ownDir, name));
  }
  return result;
}

// 新页面 key 没有图时，按旧 key 回退，保证旧素材继续可用
function withBackgroundAliases(pages, backgrounds) {
  const result = { ...backgrounds };
  for (const page of pages) {
    if (result[page.key]) continue;
    for (const oldKey of BACKGROUND_ALIASES[page.key] || []) {
      if (backgrounds[oldKey]) {
        result[page.key] = backgrounds[oldKey];
        break;
      }
    }
  }
  return result;
}

// 显式写了文件名就按它找（写全名优先，只写基名则按格式优先级），否则找与学号同名的音频
function resolveMusicFile(studentId, bgMusic) {
  const { root, extensions } = mediaRoot('music');
  const files = listFiles(root, extensions);
  const wanted = bgMusic
    ? (files.includes(bgMusic) ? bgMusic : byBasename(files).get(bgMusic))
    : byBasename(files).get(studentId);
  return wanted || null;
}

function resolveMusicUrl(studentId, bgMusic) {
  const wanted = resolveMusicFile(studentId, bgMusic);
  if (!wanted) return null;
  const { root } = mediaRoot('music');
  return withVersion(path.join(root, wanted), fileUrl('music', null, wanted));
}

/* ---------- 字体（主题用） ---------- */

const FONT_PRESET_NAMES = {
  'smiley-sans': '得意黑',
  'lxgw-wenkai': '霞鹜文楷',
  'noto-sans-sc': '思源黑体',
  'zcool-kuaile': '站酷快乐体',
  'ma-shan-zheng': '马善政毛笔楷书',
};

function fontDir(custom) {
  return path.join(STATIC_DIR, 'fonts', custom ? 'custom' : 'presets');
}

// 预置字体：目录里有文件就等于可用，中文名来自上面的映射
function listFontPresets() {
  const dir = fontDir(false);
  const order = Object.keys(FONT_PRESET_NAMES);
  return [...byBasename(listFiles(dir, FONT_EXTENSIONS))]
    .map(([id, name]) => ({
      id,
      name: FONT_PRESET_NAMES[id] || id,
      url: withVersion(path.join(dir, name), `/fonts/presets/${encodeURIComponent(name)}`),
    }))
    .sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.id.localeCompare(b.id);
    });
}

function hasFontPreset(id) {
  return typeof id === 'string' && listFontPresets().some(preset => preset.id === id);
}

// 主题里的字体选择：null / 预设 id / 'custom' → 真实 URL；文件不存在返回 null，前端回退系统字体
function resolveFontUrl(choice, slot) {
  if (!choice) return null;
  const dir = fontDir(choice === 'custom');
  const wanted = choice === 'custom' ? slot : choice;
  const name = byBasename(listFiles(dir, FONT_EXTENSIONS)).get(wanted);
  if (!name) return null;
  const base = choice === 'custom' ? '/fonts/custom' : '/fonts/presets';
  return withVersion(path.join(dir, name), `${base}/${encodeURIComponent(name)}`);
}

// woff/woff2 的文件头，防止把改名的任意文件写进字体槽位
function isWoffBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const tag = buffer.toString('ascii', 0, 4);
  return tag === 'wOF2' || tag === 'wOFF';
}

/* ---------- 管理面板用：列举与安全写入 ---------- */

function isSafeSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value.trim() === value
    && value !== '.'
    && value !== '..'
    && !UNSAFE_SEGMENT.test(value);
}

function isSafeFileName(name, extensions) {
  return isSafeSegment(name) && !name.startsWith('.') && extensions.includes(path.extname(name).toLowerCase());
}

// 目标文件的绝对路径：先名字白名单，再前缀断言（Express 5 会解码路由参数，%2F 会变成 /，不能只信路由形状）
function resolveMediaPath(kind, dir, name) {
  const { root, extensions } = mediaRoot(kind);
  if (dir && !isSafeSegment(dir)) throw new Error('目录名不合法');
  if (!isSafeFileName(name, extensions)) throw new Error(`文件名不合法，只允许 ${extensions.join(' / ')}`);
  const rootResolved = path.resolve(root);
  const base = dir ? path.resolve(rootResolved, dir) : rootResolved;
  if (base !== rootResolved && !base.startsWith(rootResolved + path.sep)) throw new Error('目录越界');
  const target = path.join(base, name);
  if (path.dirname(target) !== base) throw new Error('路径不合法');
  return target;
}

// 先写同目录临时文件再改名：rename 是原子的，nginx 不会读到半个文件
function atomicWrite(target, buffer) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, buffer, { mode: 0o644 });
  fs.renameSync(temp, target);
}

// 列出某个目录下的资源文件（dir 为空表示共享目录）
function listEntries(kind, dir) {
  const { root, extensions } = mediaRoot(kind);
  const base = dir ? path.join(root, dir) : root;
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // 跳过上传中的临时文件
    const full = path.join(base, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({
      name,
      key: path.parse(name).name,
      ext: path.extname(name).toLowerCase(),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      url: withVersion(full, fileUrl(kind, dir, name)),
      supported: extensions.includes(path.extname(name).toLowerCase()),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// 删掉不再需要的空目录（例如成员的专属图目录被清空后）
function removeDirIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // 目录不存在或非空都不需要处理
  }
}

module.exports = {
  STATIC_DIR,
  IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
  mediaRoot,
  BACKGROUND_ALIASES,
  withBackgroundAliases,
  listFontPresets,
  hasFontPreset,
  resolveFontUrl,
  isWoffBuffer,
  listFiles,
  byBasename,
  buildBackgroundMap,
  resolveMusicFile,
  resolveMusicUrl,
  isSafeSegment,
  isSafeFileName,
  resolveMediaPath,
  atomicWrite,
  listEntries,
  removeDirIfEmpty,
  withVersion,
  fileUrl,
};
