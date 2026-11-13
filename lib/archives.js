// 年度归档：把名单（students 全表）与成员照片/音乐打包成 zip，支持下载、恢复与覆盖式清空。
// 归档只含成员数据：共享背景图（images 根目录）、装饰图、字体、主题、页面注册表都不进入归档。
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const yazl = require('yazl');
const yauzl = require('yauzl');
const media = require('./media');
const records = require('./student-records');
const pages = require('./pages');

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'archives');
const TMP_DIR = path.join(ARCHIVE_DIR, 'tmp');
const FORMAT = 'annual-report-archive';
const VERSION = 1;

const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
const MAX_TOTAL_BYTES = 6 * 1024 ** 3;
const MAX_ENTRY_BYTES = 100 * 1024 ** 2;
const MAX_ENTRIES = 50000;
const MAX_ROSTER_ROWS = 10000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

const IMAGE_DIR_EXCLUDE = new Set(['decor', 'extras']);
const MEDIA_PREFIXES = ['media/images/', 'media/music/'];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function ensureDirs() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function isValidYear(year) {
  return /^\d{4}$/.test(String(year)) && Number(year) >= 2000 && Number(year) <= 2100;
}

function archiveFile(year) {
  return path.join(ARCHIVE_DIR, `${year}.zip`);
}

function sidecarFile(year) {
  return path.join(ARCHIVE_DIR, `${year}.json`);
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw fail(400, '归档包包含非法路径');
  }
  return target;
}

/* ---------- 成员媒体清单 ---------- */

function fileList(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!extensions.includes(path.extname(entry.name).toLowerCase())) continue;
    if (!media.isSafeFileName(entry.name, extensions)) continue;
    const absolute = path.join(dir, entry.name);
    out.push({ name: entry.name, abs: absolute, size: fs.statSync(absolute).size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

// 成员照片 = images 下一级成员目录（排除 decor/extras）+ images/extras 整棵树
// 成员音乐 = music 根目录的全部音频文件
function listMemberMedia() {
  const imagesRoot = media.mediaRoot('image').root;
  const musicRoot = media.mediaRoot('music').root;
  const imageDirs = [];
  const extras = [];
  const music = [];
  let imageFiles = 0;
  let imageBytes = 0;
  let extraFiles = 0;
  let extraBytes = 0;
  let musicFiles = 0;
  let musicBytes = 0;

  if (isDirectory(imagesRoot)) {
    for (const entry of fs.readdirSync(imagesRoot, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IMAGE_DIR_EXCLUDE.has(entry.name)) continue;
      if (!entry.isDirectory()) continue;
      const dirAbs = path.join(imagesRoot, entry.name);
      if (isSymlink(dirAbs)) continue;
      const files = fileList(dirAbs, media.IMAGE_EXTENSIONS);
      if (files.length === 0) continue;
      imageDirs.push({ dir: entry.name, files });
      imageFiles += files.length;
      imageBytes += files.reduce((sum, file) => sum + file.size, 0);
    }

    const extrasRoot = path.join(imagesRoot, 'extras');
    if (isDirectory(extrasRoot)) {
      for (const studentEntry of fs.readdirSync(extrasRoot, { withFileTypes: true })) {
        if (!studentEntry.isDirectory() || studentEntry.name.startsWith('.')) continue;
        if (!media.isSafeSegment(studentEntry.name)) continue;
        const studentDir = path.join(extrasRoot, studentEntry.name);
        if (isSymlink(studentDir)) continue;
        for (const pageEntry of fs.readdirSync(studentDir, { withFileTypes: true })) {
          if (!pageEntry.isDirectory() || pageEntry.name.startsWith('.')) continue;
          if (!media.isSafeSegment(pageEntry.name)) continue;
          const pageDir = path.join(studentDir, pageEntry.name);
          if (isSymlink(pageDir)) continue;
          const files = fileList(pageDir, media.IMAGE_EXTENSIONS);
          if (files.length === 0) continue;
          extras.push({ studentId: studentEntry.name, pageKey: pageEntry.name, files });
          extraFiles += files.length;
          extraBytes += files.reduce((sum, file) => sum + file.size, 0);
        }
      }
    }
  }

  if (isDirectory(musicRoot)) {
    for (const file of fileList(musicRoot, media.AUDIO_EXTENSIONS)) {
      music.push(file);
      musicFiles += 1;
      musicBytes += file.size;
    }
  }

  return {
    imageDirs,
    extras,
    music,
    totals: {
      imageDirs: imageDirs.length,
      extraStudents: new Set(extras.map(group => group.studentId)).size,
      extraDirs: extras.length,
      imageFiles,
      imageBytes,
      extraFiles,
      extraBytes,
      musicFiles,
      musicBytes,
      files: imageFiles + extraFiles + musicFiles,
      bytes: imageBytes + extraBytes + musicBytes,
    },
  };
}

// 只清空成员照片/音乐；共享图、decor、字体、主题、页面都不动
function purgeMemberMedia({ photos = false, music = false, dryRun = false } = {}) {
  const inventory = listMemberMedia();
  const imagesRoot = media.mediaRoot('image').root;
  const extrasRoot = path.join(imagesRoot, 'extras');
  const musicRoot = media.mediaRoot('music').root;

  const photoSummary = {
    dirs: inventory.imageDirs.length,
    extraStudents: new Set(inventory.extras.map(group => group.studentId)).size,
    files: inventory.totals.imageFiles + inventory.totals.extraFiles,
    bytes: inventory.totals.imageBytes + inventory.totals.extraBytes,
    sample: [
      ...inventory.imageDirs.slice(0, 10).map(item => `images/${item.dir}/`),
      ...[...new Set(inventory.extras.map(group => group.studentId))]
        .slice(0, 10)
        .map(studentId => `images/extras/${studentId}/`),
    ],
  };
  const musicSummary = {
    files: inventory.music.length,
    bytes: inventory.totals.musicBytes,
    sample: inventory.music.slice(0, 20).map(item => item.name),
  };

  if (dryRun) return { dryRun: true, photos: photoSummary, music: musicSummary };

  if (photos) {
    for (const item of inventory.imageDirs) {
      fs.rmSync(path.join(imagesRoot, item.dir), { recursive: true, force: true });
    }
    for (const studentId of new Set(inventory.extras.map(group => group.studentId))) {
      fs.rmSync(path.join(extrasRoot, studentId), { recursive: true, force: true });
    }
  }
  if (music) {
    for (const file of inventory.music) {
      try {
        fs.unlinkSync(file.abs);
      } catch {
        // 文件可能被并发删除，忽略
      }
    }
  }
  return { dryRun: false, photos: photoSummary, music: musicSummary };
}

/* ---------- 生成归档 ---------- */

function readReportMeta(db) {
  return {
    reportYear: pages.getSetting(db, 'report_year', String(new Date().getFullYear())),
    pageKeys: pages.enabledPages(db).map(page => page.key),
  };
}

function buildManifest({ year, rosterRows, inventory, reportYear, pageKeys }) {
  const rosterIds = new Set(rosterRows.map(row => row.student_id));
  const files = [
    { path: 'roster/students.json', kind: 'roster', size: 0 },
    { path: 'roster/students.xlsx', kind: 'roster', size: 0 },
  ];
  let imageFiles = 0;
  let imageBytes = 0;
  let extraFiles = 0;
  let extraBytes = 0;
  let musicFiles = 0;
  let musicBytes = 0;

  for (const group of inventory.imageDirs) {
    for (const file of group.files) {
      files.push({ path: `media/images/${group.dir}/${file.name}`, kind: 'image', size: file.size });
      imageFiles += 1;
      imageBytes += file.size;
    }
  }
  for (const group of inventory.extras) {
    for (const file of group.files) {
      files.push({
        path: `media/images/extras/${group.studentId}/${group.pageKey}/${file.name}`,
        kind: 'extra',
        size: file.size,
        orphan: !rosterIds.has(group.studentId),
      });
      extraFiles += 1;
      extraBytes += file.size;
    }
  }
  for (const file of inventory.music) {
    files.push({ path: `media/music/${file.name}`, kind: 'music', size: file.size });
    musicFiles += 1;
    musicBytes += file.size;
  }

  return {
    format: FORMAT,
    version: VERSION,
    year,
    createdAt: new Date().toISOString(),
    reportYear,
    pageKeys,
    counts: {
      students: rosterRows.length,
      imageDirs: inventory.totals.imageDirs,
      extraStudents: inventory.totals.extraStudents,
      imageFiles,
      imageBytes,
      extraFiles,
      extraBytes,
      musicFiles,
      musicBytes,
      files: imageFiles + extraFiles + musicFiles,
      bytes: imageBytes + extraBytes + musicBytes,
    },
    files,
  };
}

function writeZip(target, { manifest, rosterRows, inventory }) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(target);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    zip.outputStream.on('error', finish);
    output.on('error', finish);
    output.on('close', () => finish());

    zip.outputStream.pipe(output);
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');
    zip.addBuffer(Buffer.from(JSON.stringify(rosterRows, null, 2), 'utf8'), 'roster/students.json');
    zip.addBuffer(records.exportBuffer(rosterRows), 'roster/students.xlsx');

    for (const group of inventory.imageDirs) {
      for (const file of group.files) {
        zip.addFile(file.abs, `media/images/${group.dir}/${file.name}`, { compress: false });
      }
    }
    for (const group of inventory.extras) {
      for (const file of group.files) {
        zip.addFile(file.abs, `media/images/extras/${group.studentId}/${group.pageKey}/${file.name}`, { compress: false });
      }
    }
    for (const file of inventory.music) {
      zip.addFile(file.abs, `media/music/${file.name}`, { compress: false });
    }
    zip.end();
  });
}

function checkSpace(requiredBytes) {
  try {
    const stats = fs.statfsSync(ARCHIVE_DIR);
    const free = stats.bavail * stats.bsize;
    // zip 基本不压缩媒体，按 1.05 倍预留
    if (requiredBytes > 0 && free < requiredBytes * 1.05) {
      throw fail(409, '归档目录剩余空间不足，请先清理旧快照');
    }
  } catch (error) {
    if (error.status) throw error;
    // statfs 不可用时跳过空间检查
  }
}

async function createArchive(db, { year, overwrite = false } = {}) {
  ensureDirs();
  const normalized = String(year || '').trim();
  if (!isValidYear(normalized)) throw fail(400, '年份需为 2000–2100 的四位数字');
  if (!overwrite && (exists(archiveFile(normalized)) || exists(sidecarFile(normalized)))) {
    throw fail(409, `${normalized} 年的归档已存在，确认后才会覆盖`);
  }

  const rosterRows = db.prepare('SELECT * FROM students ORDER BY student_id').all();
  if (rosterRows.length > MAX_ROSTER_ROWS) throw fail(400, `名单超过 ${MAX_ROSTER_ROWS} 人，请拆分后再归档`);

  const inventory = listMemberMedia();
  checkSpace(inventory.totals.bytes);
  const { reportYear, pageKeys } = readReportMeta(db);
  const manifest = buildManifest({ year: normalized, rosterRows, inventory, reportYear, pageKeys });
  manifest.files[0].size = Buffer.byteLength(JSON.stringify(rosterRows, null, 2));
  manifest.files[1].size = records.exportBuffer(rosterRows).length;

  const part = path.join(TMP_DIR, `${normalized}.${process.pid}.${Date.now()}.part`);
  try {
    await writeZip(part, { manifest, rosterRows, inventory });
    fs.renameSync(part, archiveFile(normalized));
    const side = path.join(TMP_DIR, `${normalized}.${process.pid}.json`);
    fs.writeFileSync(side, JSON.stringify(manifest));
    fs.renameSync(side, sidecarFile(normalized));
  } catch (error) {
    try { fs.rmSync(part, { force: true }); } catch {}
    throw error;
  }

  return {
    year: normalized,
    size: fs.statSync(archiveFile(normalized)).size,
    counts: manifest.counts,
    createdAt: manifest.createdAt,
  };
}

function listArchives() {
  ensureDirs();
  const items = [];
  for (const name of fs.readdirSync(ARCHIVE_DIR)) {
    const match = /^(\d{4})\.json$/.exec(name);
    if (!match) continue;
    const year = match[1];
    const zip = archiveFile(year);
    if (!exists(zip)) continue;
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, name), 'utf8'));
    } catch {
      manifest = {};
    }
    items.push({
      year,
      createdAt: manifest.createdAt || fs.statSync(zip).mtime.toISOString(),
      reportYear: manifest.reportYear || '',
      counts: manifest.counts || {},
      size: fs.statSync(zip).size,
    });
  }
  return items.sort((a, b) => b.year.localeCompare(a.year));
}

function deleteArchive(year) {
  const normalized = String(year || '').trim();
  if (!isValidYear(normalized)) throw fail(400, '年份不合法');
  const zip = archiveFile(normalized);
  const side = sidecarFile(normalized);
  if (!exists(zip) && !exists(side)) throw fail(404, '归档不存在');
  if (exists(zip)) fs.rmSync(zip, { force: true });
  if (exists(side)) fs.rmSync(side, { force: true });
  return { year: normalized };
}

// 上传的临时包在恢复成功后可直接落成正式快照
function saveArchiveFile(zipPath, manifest, { overwrite = false } = {}) {
  ensureDirs();
  const year = String(manifest.year);
  if (!isValidYear(year)) throw fail(400, '归档包年份不合法');
  if (!overwrite && (exists(archiveFile(year)) || exists(sidecarFile(year)))) {
    throw fail(409, `${year} 年的归档已存在，确认后才会覆盖`);
  }
  if (path.resolve(zipPath) !== path.resolve(archiveFile(year))) {
    fs.renameSync(zipPath, archiveFile(year));
  }
  const side = path.join(TMP_DIR, `${year}.${process.pid}.json`);
  fs.writeFileSync(side, JSON.stringify(manifest));
  fs.renameSync(side, sidecarFile(year));
  return { year, size: fs.statSync(archiveFile(year)).size };
}

/* ---------- 读取 / 校验 zip ---------- */

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(fail(400, `无法读取归档包：${error.message}`));
      else resolve(zip);
    });
  });
}

function validateEntryName(name) {
  if (!name || name.includes('\\') || name.includes('\0')) throw fail(400, '归档包包含非法文件名');
  if (name.startsWith('/') || name.endsWith('/')) throw fail(400, '归档包包含非法路径');
  const segments = name.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw fail(400, '归档包包含非法路径');
  }
  if (name === 'manifest.json' || name === 'roster/students.json' || name === 'roster/students.xlsx') return;
  if (!MEDIA_PREFIXES.some(prefix => name.startsWith(prefix))) throw fail(400, `归档包包含未知文件：${name}`);

  if (name.startsWith('media/images/')) {
    const rest = segments.slice(2); // 去掉 media/images
    const fileName = rest[rest.length - 1];
    if (!media.isSafeFileName(fileName, media.IMAGE_EXTENSIONS)) {
      throw fail(400, `归档包包含不支持的图片：${name}`);
    }
    if (rest.length === 2) {
      if (!media.isSafeSegment(rest[0]) || rest[0] === 'decor' || rest[0] === 'extras') {
        throw fail(400, `归档包目录名不合法：${name}`);
      }
    } else if (rest.length === 4 && rest[0] === 'extras') {
      if (!media.isSafeSegment(rest[1]) || !media.isSafeSegment(rest[2])) {
        throw fail(400, `归档包目录名不合法：${name}`);
      }
    } else {
      throw fail(400, `归档包图片路径层级不合法：${name}`);
    }
  } else if (name.startsWith('media/music/')) {
    const rest = segments.slice(2);
    if (rest.length !== 1 || !media.isSafeFileName(rest[0], media.AUDIO_EXTENSIONS)) {
      throw fail(400, `归档包包含不支持的音乐：${name}`);
    }
  }
}

function checkEntry(entry, total) {
  validateEntryName(entry.fileName);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw fail(400, `归档包内文件过大：${entry.fileName}`);
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (mode === 0xa000) throw fail(400, '归档包不能包含符号链接');
  const nextTotal = total + entry.uncompressedSize;
  if (nextTotal > MAX_TOTAL_BYTES) throw fail(400, '归档包解压后体积超出上限');
  return nextTotal;
}

function readEntryBuffer(zip, entry, limit) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          stream.destroy();
          reject(fail(400, '归档包内的名单文件过大'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readZipMeta(zipPath) {
  const zip = await openZip(zipPath);
  const entries = [];
  const wanted = new Map();
  let total = 0;

  await new Promise((resolve, reject) => {
    const finish = (error) => {
      try { zip.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    zip.on('error', error => finish(fail(400, `归档包损坏：${error.message}`)));
    zip.on('entry', (entry) => {
      try {
        total = checkEntry(entry, total);
        if (entries.length >= MAX_ENTRIES) throw fail(400, '归档包文件条目过多');
        entries.push({ name: entry.fileName, size: entry.uncompressedSize });
        const name = entry.fileName;
        if (name === 'manifest.json' || name === 'roster/students.json') wanted.set(name, entry);
        zip.readEntry();
      } catch (error) {
        finish(error);
      }
    });
    zip.on('end', () => finish());
    zip.readEntry();
  });

  if (!wanted.has('manifest.json')) throw fail(400, '归档包缺少 manifest.json');
  if (!wanted.has('roster/students.json')) throw fail(400, '归档包缺少名单数据');

  const zip2 = await openZip(zipPath);
  let manifestBuffer = null;
  let rosterBuffer = null;
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      try { zip2.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    zip2.on('error', error => finish(fail(400, `归档包损坏：${error.message}`)));
    zip2.on('entry', (entry) => {
      if (entry.fileName === 'manifest.json') {
        readEntryBuffer(zip2, entry, 10 * 1024 * 1024).then(buffer => {
          manifestBuffer = buffer;
          zip2.readEntry();
        }).catch(finish);
      } else if (entry.fileName === 'roster/students.json') {
        readEntryBuffer(zip2, entry, 64 * 1024 * 1024).then(buffer => {
          rosterBuffer = buffer;
          zip2.readEntry();
        }).catch(finish);
      } else {
        zip2.readEntry();
      }
    });
    zip2.on('end', () => finish());
    zip2.readEntry();
  });

  let manifest;
  let rosterRows;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
    rosterRows = JSON.parse(rosterBuffer.toString('utf8'));
  } catch {
    throw fail(400, '归档包内容不是有效的 JSON');
  }

  if (!manifest || manifest.format !== FORMAT) throw fail(400, '不是本系统生成的归档包');
  if (manifest.version !== VERSION) throw fail(400, `归档包版本不支持：${manifest.version}`);
  if (!isValidYear(manifest.year)) throw fail(400, '归档包年份不合法');
  if (!Array.isArray(rosterRows) || rosterRows.length > MAX_ROSTER_ROWS) {
    throw fail(400, `归档名单不合法或超过 ${MAX_ROSTER_ROWS} 人`);
  }
  if (!Array.isArray(manifest.files)) throw fail(400, '归档包清单不完整');

  const entryNames = new Set(entries.map(entry => entry.name));
  const expected = new Set(['manifest.json', ...manifest.files.map(file => file.path)]);
  if (expected.size !== entryNames.size) throw fail(400, '归档包清单与实际文件不一致');
  for (const name of expected) {
    if (!entryNames.has(name)) throw fail(400, `归档包缺少文件：${name}`);
  }

  return { manifest, rosterRows, entries };
}

function summarizeEntries(entries) {
  let imageFiles = 0;
  let imageBytes = 0;
  let extraFiles = 0;
  let extraBytes = 0;
  let musicFiles = 0;
  let musicBytes = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('media/images/extras/')) {
      extraFiles += 1;
      extraBytes += entry.size;
    } else if (entry.name.startsWith('media/images/')) {
      imageFiles += 1;
      imageBytes += entry.size;
    } else if (entry.name.startsWith('media/music/')) {
      musicFiles += 1;
      musicBytes += entry.size;
    }
  }
  return { imageFiles, imageBytes, extraFiles, extraBytes, musicFiles, musicBytes };
}

function currentState(db) {
  const inventory = listMemberMedia();
  const students = db.prepare('SELECT count(*) AS total FROM students').get().total;
  return {
    students,
    photos: {
      dirs: inventory.totals.imageDirs,
      extraStudents: inventory.totals.extraStudents,
      files: inventory.totals.imageFiles + inventory.totals.extraFiles,
      bytes: inventory.totals.imageBytes + inventory.totals.extraBytes,
    },
    music: { files: inventory.totals.musicFiles, bytes: inventory.totals.musicBytes },
  };
}

async function previewArchive(db, zipPath) {
  const scanned = await readZipMeta(zipPath);
  const rosterIds = new Set(scanned.rosterRows.map(row => String(row.student_id || '')));
  const orphanStudents = new Set(
    scanned.manifest.files
      .filter(file => file.orphan)
      .map(file => file.path.split('/')[3])
      .filter(Boolean)
  );
  const current = currentState(db);
  const warnings = [];
  if (orphanStudents.size > 0) {
    warnings.push(`归档包含 ${orphanStudents.size} 个不在名单里的学号目录（仍会一起恢复）`);
  }
  const currentPageKeys = new Set(pages.enabledPages(db).map(page => page.key));
  const archivePageKeys = new Set(scanned.manifest.pageKeys || []);
  const missingPages = [...archivePageKeys].filter(key => !currentPageKeys.has(key));
  if (missingPages.length > 0) {
    warnings.push(`归档里的页面 ${missingPages.join('、')} 当前未启用，对应附加图片恢复后不会展示`);
  }
  if (scanned.manifest.reportYear && scanned.manifest.reportYear !== pages.getSetting(db, 'report_year', '')) {
    warnings.push(`归档年度为 ${scanned.manifest.reportYear}，与当前年度不同`);
  }
  return {
    source: { year: scanned.manifest.year, createdAt: scanned.manifest.createdAt },
    incoming: {
      students: scanned.rosterRows.length,
      ...summarizeEntries(scanned.entries),
      pageKeys: scanned.manifest.pageKeys || [],
      reportYear: scanned.manifest.reportYear || '',
    },
    current,
    warnings,
    rosterIds: rosterIds.size,
    scanned,
  };
}

/* ---------- 上传暂存 token ---------- */

const pendingUploads = new Map();

function cleanupPending() {
  const now = Date.now();
  for (const [token, item] of pendingUploads) {
    if (item.expiresAt <= now) {
      pendingUploads.delete(token);
      try { fs.rmSync(item.zipPath, { force: true }); } catch {}
    }
  }
}
setInterval(cleanupPending, 5 * 60 * 1000).unref();

function stashUpload({ zipPath, preview, admin, sessionId }) {
  cleanupPending();
  const token = randomUUID();
  pendingUploads.set(token, {
    zipPath,
    preview,
    admin,
    sessionId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

function peekUpload(token, { admin, sessionId }) {
  const item = pendingUploads.get(String(token || ''));
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    pendingUploads.delete(token);
    try { fs.rmSync(item.zipPath, { force: true }); } catch {}
    return null;
  }
  if (item.admin !== admin || item.sessionId !== sessionId) return null;
  return item;
}

function takeUpload(token, { admin, sessionId }) {
  const item = peekUpload(token, { admin, sessionId });
  if (!item) return null;
  pendingUploads.delete(token);
  return item;
}

function discardUpload(token) {
  const item = pendingUploads.get(String(token || ''));
  if (!item) return false;
  pendingUploads.delete(token);
  try { fs.rmSync(item.zipPath, { force: true }); } catch {}
  return true;
}

/* ---------- 操作锁 ---------- */

let busy = null;

async function withLock(label, task) {
  if (busy) throw fail(409, `另一个${busy}操作正在进行，请稍后再试`);
  busy = label;
  try {
    return await task();
  } finally {
    busy = null;
  }
}

function currentBusy() {
  return busy;
}

/* ---------- 恢复 ---------- */

function movePath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

async function extractEntries(zipPath, destination, { roster, photos, music }) {
  const zip = await openZip(zipPath);
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      try { zip.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    zip.on('error', error => finish(error));
    zip.on('entry', (entry) => {
      const name = entry.fileName;
      const wanted = name === 'roster/students.json' ? roster
        : name.startsWith('media/images/') ? photos
          : name.startsWith('media/music/') ? music
            : false;
      if (!wanted) {
        zip.readEntry();
        return;
      }
      const target = safeJoin(destination, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      zip.openReadStream(entry, (error, stream) => {
        if (error) return finish(error);
        const output = fs.createWriteStream(target);
        stream.on('error', finish);
        output.on('error', finish);
        output.on('close', () => zip.readEntry());
        stream.pipe(output);
      });
    });
    zip.on('end', () => finish());
    zip.readEntry();
  });
}

function nullDanglingThemes(db, rosterRows) {
  const themes = new Set(db.prepare('SELECT id FROM themes').all().map(row => row.id));
  let nulled = 0;
  for (const row of rosterRows) {
    if (row.theme && !themes.has(row.theme)) {
      row.theme = null;
      nulled += 1;
    }
  }
  return nulled;
}

function planRosterRestore(db, rosterRows) {
  const themesNulled = nullDanglingThemes(db, rosterRows);
  const headerRows = records.dbRowsToHeaderRows(rosterRows);
  const partnerById = new Map();
  rosterRows.forEach((row, index) => {
    partnerById.set(String(row.student_id || ''), row.partner ?? null);
    headerRows[index]['主题'] = row.theme || '';
  });
  const plan = records.planRecords(db, headerRows);
  if (plan.counts.error > 0) {
    const first = plan.items.find(item => item.error);
    throw fail(400, `名单第 ${first.line} 行无法恢复：${first.error}`);
  }
  for (const item of plan.items) {
    if (item.record) item.record.partner = partnerById.get(item.record.student_id) ?? null;
  }
  return { plan, themesNulled };
}

async function restoreArchive(db, {
  zipPath,
  roster = false,
  photos = false,
  music = false,
  setReportYear = false,
} = {}) {
  if (!roster && !photos && !music) throw fail(400, '至少选择名单、照片、音乐中的一类');
  const scanned = await readZipMeta(zipPath);
  const staticDir = media.STATIC_DIR;
  try {
    fs.accessSync(staticDir, fs.constants.W_OK);
  } catch {
    throw fail(400, '静态资源目录不可写，无法恢复文件；请检查 compose 里 ./static 的挂载权限');
  }

  const token = randomUUID();
  const staging = path.join(staticDir, `.restore-${token}`);
  const trash = path.join(staticDir, `.trash-${Date.now()}-${process.pid}`);
  const imagesRoot = media.mediaRoot('image').root;
  const extrasRoot = path.join(imagesRoot, 'extras');
  const musicRoot = media.mediaRoot('music').root;

  const result = {
    success: true,
    year: scanned.manifest.year,
    categories: {
      roster: { requested: roster, inserted: 0, themesNulled: 0, sessionsRemoved: 0 },
      photos: { requested: photos, dirs: 0, extraStudents: 0, files: 0, bytes: 0 },
      music: { requested: music, files: 0, bytes: 0 },
    },
    setReportYear: false,
    warnings: [],
  };

  let rosterPlan = null;
  if (roster) {
    const planned = planRosterRestore(db, scanned.rosterRows);
    rosterPlan = planned.plan;
    result.categories.roster.themesNulled = planned.themesNulled;
  }

  const trashed = [];
  const movedIn = [];
  let trashKept = false;

  const rollback = () => {
    const failures = [];
    for (const target of [...movedIn].reverse()) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (error) { failures.push(`清理 ${target}：${error.message}`); }
    }
    for (const item of [...trashed].reverse()) {
      try {
        if (exists(item.to)) movePath(item.to, item.from);
      } catch (error) {
        failures.push(`还原 ${item.from}：${error.message}`);
      }
    }
    trashKept = failures.length > 0;
    return failures;
  };

  try {
    fs.mkdirSync(staging, { recursive: true });
    await extractEntries(zipPath, staging, { roster, photos, music });

    if (photos) {
      const current = listMemberMedia();
      for (const item of current.imageDirs) {
        const from = path.join(imagesRoot, item.dir);
        const to = path.join(trash, 'images', item.dir);
        movePath(from, to);
        trashed.push({ from, to });
      }
      for (const studentId of new Set(current.extras.map(group => group.studentId))) {
        const from = path.join(extrasRoot, studentId);
        const to = path.join(trash, 'images', 'extras', studentId);
        movePath(from, to);
        trashed.push({ from, to });
      }

      const stagedImages = path.join(staging, 'media', 'images');
      if (isDirectory(stagedImages)) {
        for (const entry of fs.readdirSync(stagedImages, { withFileTypes: true })) {
          if (entry.name === 'extras' || entry.name.startsWith('.')) continue;
          const from = path.join(stagedImages, entry.name);
          const to = path.join(imagesRoot, entry.name);
          movePath(from, to);
          movedIn.push(to);
          result.categories.photos.dirs += 1;
        }
        const stagedExtras = path.join(stagedImages, 'extras');
        if (isDirectory(stagedExtras)) {
          fs.mkdirSync(extrasRoot, { recursive: true });
          for (const entry of fs.readdirSync(stagedExtras, { withFileTypes: true })) {
            const from = path.join(stagedExtras, entry.name);
            const to = path.join(extrasRoot, entry.name);
            movePath(from, to);
            movedIn.push(to);
            result.categories.photos.extraStudents += 1;
          }
        }
      }
      const photoTotals = summarizeEntries(scanned.entries);
      result.categories.photos.files = photoTotals.imageFiles + photoTotals.extraFiles;
      result.categories.photos.bytes = photoTotals.imageBytes + photoTotals.extraBytes;
    }

    if (music) {
      const current = listMemberMedia();
      for (const file of current.music) {
        const to = path.join(trash, 'music', file.name);
        movePath(file.abs, to);
        trashed.push({ from: file.abs, to });
      }
      const stagedMusic = path.join(staging, 'media', 'music');
      if (isDirectory(stagedMusic)) {
        for (const entry of fs.readdirSync(stagedMusic, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const from = path.join(stagedMusic, entry.name);
          const to = path.join(musicRoot, entry.name);
          movePath(from, to);
          movedIn.push(to);
        }
      }
      const totals = summarizeEntries(scanned.entries);
      result.categories.music.files = totals.musicFiles;
      result.categories.music.bytes = totals.musicBytes;
    }

    if (roster) {
      const apply = db.transaction(() => {
        db.prepare('DELETE FROM students').run();
        const upsert = db.prepare(records.UPSERT_SQL);
        let inserted = 0;
        for (const item of rosterPlan.items) {
          if (!item.record) continue;
          upsert.run(item.record);
          inserted += 1;
        }
        const sessionsRemoved = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.studentId') IS NOT NULL").run().changes;
        if (setReportYear) pages.setSetting(db, 'report_year', scanned.manifest.year);
        return { inserted, sessionsRemoved };
      });
      const applied = apply();
      result.categories.roster.inserted = applied.inserted;
      result.categories.roster.sessionsRemoved = applied.sessionsRemoved;
      if (setReportYear) result.setReportYear = true;
    } else if (setReportYear) {
      // 没恢复名单时年度设置是独立操作，失败不影响文件恢复
      try {
        pages.setSetting(db, 'report_year', scanned.manifest.year);
        result.setReportYear = true;
      } catch (error) {
        result.warnings.push(`年度设置未更新：${error.message}`);
      }
    }
  } catch (error) {
    const failures = rollback();
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    error.rollback = { attempted: true, ok: failures.length === 0, failures, trash: trashKept ? trash : null };
    throw error;
  }

  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch {}
  return result;
}

/* ---------- 清理 ---------- */

function cleanupStale() {
  try {
    ensureDirs();
    const now = Date.now();
    for (const name of fs.readdirSync(TMP_DIR)) {
      const target = path.join(TMP_DIR, name);
      try {
        if (now - fs.statSync(target).mtimeMs > STALE_MS) fs.rmSync(target, { recursive: true, force: true });
      } catch {}
    }
    for (const year of fs.readdirSync(ARCHIVE_DIR)) {
      if (!/^\d{4}\.(zip|json)$/.test(year)) continue;
      const target = path.join(ARCHIVE_DIR, year);
      const counterpart = year.endsWith('.zip')
        ? sidecarFile(year.slice(0, 4))
        : archiveFile(year.slice(0, 4));
      try {
        if (!exists(counterpart) && now - fs.statSync(target).mtimeMs > STALE_MS) {
          fs.rmSync(target, { force: true });
        }
      } catch {}
    }
    const staticDir = media.STATIC_DIR;
    if (isDirectory(staticDir)) {
      for (const name of fs.readdirSync(staticDir)) {
        if (!name.startsWith('.restore-') && !name.startsWith('.trash-')) continue;
        const target = path.join(staticDir, name);
        try {
          if (now - fs.statSync(target).mtimeMs > STALE_MS) fs.rmSync(target, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch (error) {
    console.error('[archives] 清理临时文件失败：', error.message);
  }
}

module.exports = {
  ARCHIVE_DIR,
  TMP_DIR,
  MAX_UPLOAD_BYTES,
  MAX_TOTAL_BYTES,
  MAX_ENTRY_BYTES,
  MAX_ENTRIES,
  MAX_ROSTER_ROWS,
  ensureDirs,
  cleanupStale,
  isValidYear,
  archiveFile,
  sidecarFile,
  listMemberMedia,
  purgeMemberMedia,
  createArchive,
  listArchives,
  deleteArchive,
  saveArchiveFile,
  previewArchive,
  restoreArchive,
  stashUpload,
  peekUpload,
  takeUpload,
  discardUpload,
  withLock,
  currentBusy,
  summarizeEntries,
};
