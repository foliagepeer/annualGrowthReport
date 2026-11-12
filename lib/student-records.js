// 「成员数据」的唯一规则来源：CLI 导入、面板文本批量、面板单条增删改都走这里，
// 保证三处行为完全一致。纯 JS（只依赖 xlsx/media），不 require db，
// 这样在宿主机上也能直接跑逻辑测试。
const XLSX = require('xlsx');
const media = require('./media');

const HEADERS = [
  '学号', '姓名', '部门', '入会日期', '志愿时长', '活动次数', '活动记录',
  '活动一名称', '活动一日期', '活动一工作', '活动二名称', '活动二日期', '活动二工作',
  '伙伴人数', '年度关键词', '关键词依据', '部长寄语', '背景图目录', '背景音乐',
];
const REQUIRED_HEADERS = ['学号', '姓名'];
// 旧版 11 列文本带「密码」列；密码不再使用，但保留映射以兼容旧文本
const LEGACY_HEADERS = ['学号', '密码', '姓名', '部门', '入会日期', '志愿时长', '活动次数', '年度伙伴', '部长寄语', '背景图目录', '背景音乐'];
const MAX_ROWS = 5000;

// 数据库字段 ↔ 中文表头，用于计算「哪些字段变了」
const FIELD_LABELS = {
  student_id: '学号',
  name: '姓名',
  department: '部门',
  join_date: '入会日期',
  volunteer_hours: '志愿时长',
  activity_count: '活动次数',
  activities: '活动记录',
  activity1_name: '活动一名称',
  activity1_date: '活动一日期',
  activity1_work: '活动一工作',
  activity2_name: '活动二名称',
  activity2_date: '活动二日期',
  activity2_work: '活动二工作',
  partner_count: '伙伴人数',
  keyword: '年度关键词',
  keyword_reason: '关键词依据',
  partner: '年度伙伴',
  message: '部长寄语',
  bg_dir: '背景图目录',
  bg_music: '背景音乐',
  theme: '主题',
};

// 导入时判断「这个字段在文件里到底有没有」：旧模板缺列时沿用库里的值，不清空新字段
const RECORD_FIELDS = [
  ['department', '部门'],
  ['join_date', '入会日期'],
  ['volunteer_hours', '志愿时长'],
  ['activity_count', '活动次数'],
  ['activities', '活动记录'],
  ['activity1_name', '活动一名称'],
  ['activity1_date', '活动一日期'],
  ['activity1_work', '活动一工作'],
  ['activity2_name', '活动二名称'],
  ['activity2_date', '活动二日期'],
  ['activity2_work', '活动二工作'],
  ['partner_count', '伙伴人数'],
  ['keyword', '年度关键词'],
  ['keyword_reason', '关键词依据'],
  ['partner', '年度伙伴'],
  ['message', '部长寄语'],
  ['bg_dir', '背景图目录'],
  ['bg_music', '背景音乐'],
  ['theme', '主题'],
];

const text = value => String(value ?? '').trim();

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/* ---------- 日期（入会日期） ---------- */

function formatDate(year, month, day) {
  const pad = n => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

// 日期一律存成 YYYY-MM-DD。Excel 单元格可能是日期格式、文本、甚至序列号，都要认
function toDate(value, label = '入会日期') {
  if (value === null || value === undefined || value === '') return { value: null };

  // Excel 里是日期格式的单元格时，SheetJS 会给 Date 对象
  if (value && typeof value === 'object' && typeof value.getFullYear === 'function') {
    if (Number.isNaN(value.getTime())) return { error: `${label}无效` };
    return { value: formatDate(value.getFullYear(), value.getMonth() + 1, value.getDate()) };
  }

  // Excel 日期格式的单元格在 raw 模式下会读成序列号（1899-12-30 起算）
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 1 || value > 60000) return { error: `${label}超出合理范围：${value}` };
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return { value: formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) };
  }

  const text = String(value).trim();
  if (!text) return { value: null };

  const patterns = [
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/, // 2024-09-01 / 2024/9/1 / 2024.9.1
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, // 2024年9月1日
    /^(\d{4})(\d{2})(\d{2})$/, // 20240901
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (!matched) continue;
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    if (year < 1900 || year > 2100) return { error: `${label}年份不合理：${text}` };
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return { error: `${label}不存在：${text}` };
    return { value: formatDate(year, month, day) };
  }
  return { error: `${label}无法识别：${text}（写成 2024-09-01 这种格式最稳）` };
}

// 活动日期可以是一场，也可以是多次（如「食堂双十佳评选」办了 4 次），用、，;；分隔
function toDateList(value, label = '活动日期') {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string') return toDate(value, label);
  const parts = value.split(/[、,，;；]/).map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return toDate(parts[0] || '', label);

  const values = [];
  for (const part of parts) {
    const parsed = toDate(part, label);
    if (parsed.error) return parsed;
    if (parsed.value && !values.includes(parsed.value)) values.push(parsed.value);
  }
  const joined = values.join('、');
  if (joined.length > 200) return { error: `${label}最多 200 个字符` };
  return { value: joined };
}

// 旧模板兼容：只有「加入天数」时，按导入当天往前折算成入会日期
function dateFromDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

// 加入天数由入会日期实时算：到今天过了多少天（当天入会算 0 天）
function computeJoinDays(joinDate, now = new Date()) {
  if (!joinDate) return null;
  const matched = String(joinDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return null;
  const start = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - start) / 86400000));
}

/* ---------- 解析：文本 ---------- */

// 按 CSV 规则切分：支持双引号包裹（字段里可以含分隔符），分隔符可以是 , ，\t
function splitLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '，' || ch === '\t') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map(field => field.trim());
}

// 每行一名成员，字段顺序与 Excel 列一致；空行与 # 开头忽略；首行含「学号」时按列名映射
function parseText(input) {
  const rows = [];
  const errors = [];

  const rawLines = String(input ?? '').split(/\r?\n/);
  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const fields = splitLine(raw);
    if (fields.includes('学号')) return; // 表头行直接跳过

    if (fields.length > HEADERS.length) {
      errors.push({ line: index + 1, message: `该行有 ${fields.length} 个字段，超过 ${HEADERS.length} 列（新版已取消密码列，请删除旧密码列；「，」也会当分隔符，长文本请用双引号包起来）` });
      return;
    }

    const row = { __line: index + 1 };
    // 旧版 11 列文本仍兼容（密码列忽略）；新版文本按 19 列映射
    const headers = fields.length === LEGACY_HEADERS.length ? LEGACY_HEADERS : HEADERS;
    headers.forEach((label, i) => {
      // 只记录真正给了的列：旧模板少列时，planRecords 会沿用库里的值
      if (i < fields.length) row[label] = fields[i];
    });
    rows.push(row);
  });

  if (rows.length > MAX_ROWS) {
    return { rows: rows.slice(0, MAX_ROWS), errors: [...errors, { line: 0, message: `一次最多导入 ${MAX_ROWS} 行，超出部分已忽略` }] };
  }
  return { rows, errors };
}

/* ---------- 解析：Excel ---------- */

function parseExcelBuffer(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  if (book.SheetNames.length === 0) throw new Error('Excel 里没有可读的工作表');

  const sheetName = book.SheetNames.includes('students') ? 'students' : book.SheetNames[0];
  const raw = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: '' });
  const rows = raw.map((row, index) => ({ ...row, __line: index + 2 })); // Excel 第 1 行是表头

  if (rows.length > MAX_ROWS) throw new Error(`一次最多导入 ${MAX_ROWS} 行`);
  return { rows, sheetName };
}

function missingHeaders(rows) {
  if (rows.length === 0) return [...REQUIRED_HEADERS];
  const present = Object.keys(rows[0]);
  return REQUIRED_HEADERS.filter(header => !present.includes(header));
}

/* ---------- 校验与预演 ---------- */

// 纯字段映射与校验
function toRecord(row) {
  const studentId = text(row['学号']);
  if (!studentId) return { error: '缺少学号' };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(studentId)) return { error: '学号只能包含字母、数字、下划线、短横线（1–32 位）' };

  const name = text(row['姓名']);
  if (!name) return { error: '缺少姓名' };

  const provided = {};
  for (const [key, header] of RECORD_FIELDS) provided[key] = row[header] !== undefined;

  const bgDir = text(row['背景图目录']) || null;
  if (bgDir && !media.isSafeSegment(bgDir)) return { error: '背景图目录不合法（不能含斜杠、`..` 等字符）' };

  const bgMusic = text(row['背景音乐']) || null;
  if (bgMusic && !media.isSafeSegment(bgMusic)) return { error: '背景音乐文件名不合法（不能含斜杠、`..` 等字符）' };

  // 主题不放进 Excel 模板（会破坏按列位置粘贴），但面板/编辑可以显式给出
  const theme = text(row['主题']) || null;
  if (theme && !/^[A-Za-z0-9_-]{1,40}$/.test(theme)) return { error: '主题标识不合法' };

  const parsedDate = toDate(row['入会日期']);
  if (parsedDate.error) return { error: parsedDate.error };
  let joinDate = parsedDate.value;
  // 兼容旧模板：只填了「加入天数」时按导入当天往前折算（这是一次性折算，之后以日期为准）
  if (!joinDate && row['加入天数'] !== undefined && text(row['加入天数'])) {
    const days = toInt(text(row['加入天数']));
    if (days === null || days < 0) return { error: `加入天数不合法：${row['加入天数']}` };
    joinDate = dateFromDaysAgo(days);
  }

  const activity1Date = toDateList(row['活动一日期'], '活动一日期');
  if (activity1Date.error) return { error: activity1Date.error };
  const activity2Date = toDateList(row['活动二日期'], '活动二日期');
  if (activity2Date.error) return { error: activity2Date.error };

  const partnerCountText = text(row['伙伴人数']);
  let partnerCount = null;
  if (partnerCountText) {
    partnerCount = toInt(partnerCountText);
    if (partnerCount === null || partnerCount < 0) return { error: '伙伴人数需为非负整数' };
  }

  return {
    provided,
    value: {
      student_id: studentId,
      name,
      department: text(row['部门']),
      join_date: joinDate,
      volunteer_hours: toNumber(text(row['志愿时长'])),
      activity_count: toInt(text(row['活动次数'])),
      activities: text(row['活动记录']) || null,
      activity1_name: text(row['活动一名称']) || null,
      activity1_date: activity1Date.value,
      activity1_work: text(row['活动一工作']) || null,
      activity2_name: text(row['活动二名称']) || null,
      activity2_date: activity2Date.value,
      activity2_work: text(row['活动二工作']) || null,
      partner_count: partnerCount,
      keyword: text(row['年度关键词']) || null,
      keyword_reason: text(row['关键词依据']) || null,
      partner: text(row['年度伙伴']),
      message: text(row['部长寄语']),
      bg_dir: bgDir,
      bg_music: bgMusic,
      theme,
    },
  };
}

function sameValue(a, b) {
  const left = a === null || a === undefined ? '' : String(a);
  const right = b === null || b === undefined ? '' : String(b);
  return left === right;
}

// 只读预演：算出每行是新增/更新/无变化/错误。不写库。
function planRecords(db, rows) {
  const findStudent = db.prepare('SELECT * FROM students WHERE student_id = ?');
  const findTheme = db.prepare('SELECT 1 FROM themes WHERE id = ?');
  const items = [];
  const counts = { total: rows.length, insert: 0, update: 0, unchanged: 0, error: 0 };

  rows.forEach((row, index) => {
    const line = row.__line || index + 2;
    const parsed = toRecord(row);

    if (parsed.error) {
      counts.error += 1;
      items.push({ line, error: parsed.error, action: 'error' });
      return;
    }

    const { value, provided } = parsed;
    const existing = findStudent.get(value.student_id);

    // 缺列继承：旧模板/旧文本没有的列沿用库里的值，避免一次导入清空新字段
    if (existing) {
      for (const [key] of RECORD_FIELDS) {
        if (!provided[key]) value[key] = existing[key];
      }
    }

    // 活动记录留空时，默认用两条活动回忆的名称生成
    if (!value.activities) {
      const names = [value.activity1_name, value.activity2_name]
        .map(name => (name ? String(name).trim() : ''))
        .filter(Boolean);
      if (names.length > 0) value.activities = [...new Set(names)].join('、');
    }

    // 主题：显式给出但不存在时报错；继承出的悬空引用顺带自愈
    if (value.theme && !findTheme.get(value.theme)) {
      if (existing && value.theme === existing.theme) {
        value.theme = null;
      } else {
        counts.error += 1;
        items.push({ line, error: '主题不存在', action: 'error' });
        return;
      }
    }

    // 新增的行不需要逐个列字段（整行都是新的），只给更新行算变更字段
    const changedFields = !existing
      ? []
      : Object.keys(FIELD_LABELS).filter(key => !sameValue(value[key], existing[key]));

    let action;
    if (!existing) action = 'insert';
    else if (changedFields.length > 0) action = 'update';
    else action = 'unchanged';

    counts[action] += 1;
    items.push({
      line,
      studentId: value.student_id,
      name: value.name,
      action,
      changedFields: changedFields.map(key => FIELD_LABELS[key]),
      record: value,
      error: null,
    });
  });

  return { items, counts };
}

/* ---------- 写入 ---------- */

const UPSERT_SQL = `
  INSERT INTO students (
    student_id, name, department, join_date, volunteer_hours,
    activity_count, activities, activity1_name, activity1_date, activity1_work,
    activity2_name, activity2_date, activity2_work, partner_count, keyword, keyword_reason,
    partner, message, bg_dir, bg_music, theme
  ) VALUES (
    @student_id, @name, @department, @join_date, @volunteer_hours,
    @activity_count, @activities, @activity1_name, @activity1_date, @activity1_work,
    @activity2_name, @activity2_date, @activity2_work, @partner_count, @keyword, @keyword_reason,
    @partner, @message, @bg_dir, @bg_music, @theme
  )
  ON CONFLICT(student_id) DO UPDATE SET
    name = excluded.name,
    department = excluded.department,
    join_date = excluded.join_date,
    volunteer_hours = excluded.volunteer_hours,
    activity_count = excluded.activity_count,
    activities = excluded.activities,
    activity1_name = excluded.activity1_name,
    activity1_date = excluded.activity1_date,
    activity1_work = excluded.activity1_work,
    activity2_name = excluded.activity2_name,
    activity2_date = excluded.activity2_date,
    activity2_work = excluded.activity2_work,
    partner_count = excluded.partner_count,
    keyword = excluded.keyword,
    keyword_reason = excluded.keyword_reason,
    partner = excluded.partner,
    message = excluded.message,
    bg_dir = excluded.bg_dir,
    bg_music = excluded.bg_music,
    theme = excluded.theme
`;

// 一个事务里写完：要么全成功，要么全回滚
function applyRecords(db, items) {
  const upsert = db.prepare(UPSERT_SQL);
  const run = db.transaction(() => {
    let imported = 0;
    let unchanged = 0;
    const skipped = [];

    for (const item of items) {
      if (item.error) {
        skipped.push({ line: item.line, message: item.error });
        continue;
      }
      if (item.action === 'unchanged') {
        unchanged += 1;
        continue;
      }
      upsert.run(item.record);
      imported += 1;
    }

    return { imported, unchanged, skipped };
  });

  return run();
}

/* ---------- 导出 ---------- */

function toSheetRows(students) {
  return students.map(student => ({
    学号: student.student_id,
    姓名: student.name,
    部门: student.department ?? '',
    入会日期: student.join_date ?? '',
    志愿时长: student.volunteer_hours ?? '',
    活动次数: student.activity_count ?? '',
    活动记录: student.activities ?? '',
    活动一名称: student.activity1_name ?? '',
    活动一日期: student.activity1_date ?? '',
    活动一工作: student.activity1_work ?? '',
    活动二名称: student.activity2_name ?? '',
    活动二日期: student.activity2_date ?? '',
    活动二工作: student.activity2_work ?? '',
    伙伴人数: student.partner_count ?? '',
    年度关键词: student.keyword ?? '',
    关键词依据: student.keyword_reason ?? '',
    部长寄语: student.message ?? '',
    背景图目录: student.bg_dir ?? '',
    背景音乐: student.bg_music ?? '',
  }));
}

function buildWorkbook(sheetRows) {
  const sheet = XLSX.utils.json_to_sheet(sheetRows, { header: HEADERS, skipHeader: false });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'students');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function exportBuffer(students) {
  return buildWorkbook(toSheetRows(students));
}

function templateBuffer() {
  return buildWorkbook([
    {
      学号: '2021001', 姓名: '张三', 部门: '技术部', 入会日期: '2024-09-01',
      志愿时长: 120, 活动次数: 15, 活动记录: '迎新晚会、支教、校运会',
      活动一名称: '迎新晚会', 活动一日期: '2026-09-10', 活动一工作: '现场统筹',
      活动二名称: '支教', 活动二日期: '2026-07-15', 活动二工作: '课程设计',
      伙伴人数: 12, 年度关键词: '现场定心丸', 关键词依据: '每次大型活动都能稳住场面',
      部长寄语: '愿你保持热爱', 背景图目录: '', 背景音乐: '',
    },
    {
      学号: '2021002', 姓名: '王五', 部门: '宣传部', 入会日期: '2025-03-15',
      志愿时长: 85, 活动次数: 10, 活动记录: '海报设计、公众号运营',
      活动一名称: '海报设计', 活动一日期: '2026-05-20', 活动一工作: '视觉设计',
      活动二名称: '公众号运营', 活动二日期: '2026-06-01', 活动二工作: '内容编辑',
      伙伴人数: '', 年度关键词: '创意补给站', 关键词依据: '总能给出新鲜的视觉方案',
      部长寄语: '未来可期', 背景图目录: '', 背景音乐: '',
    },
  ]);
}

module.exports = {
  HEADERS,
  REQUIRED_HEADERS,
  MAX_ROWS,
  UPSERT_SQL,
  toDate,
  toDateList,
  formatDate,
  computeJoinDays,
  parseText,
  parseExcelBuffer,
  missingHeaders,
  planRecords,
  toRecord,
  applyRecords,
  exportBuffer,
  templateBuffer,
};
