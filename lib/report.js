// 成员端报告数据的唯一组装点：成员接口与管理端预览共用
const media = require('./media');
const pages = require('./pages');
const records = require('./student-records');
const themes = require('./themes');

function splitActivities(value) {
  return String(value ?? '')
    .split(/[、，,;；|\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function partnerInfo(db, row) {
  const own = Number.isInteger(row.partner_count) && row.partner_count >= 0 ? row.partner_count : null;
  if (own !== null) {
    return {
      partnerCount: own,
      partnerDepartment: false,
      partnerLine: `这一年，你与 ${own} 位伙伴并肩同行。`,
      partnerCaption: '这一年，你与伙伴并肩同行。',
    };
  }

  const department = String(row.department || '').trim();
  if (department) {
    const total = db.prepare('SELECT count(*) AS c FROM students WHERE department = ?').get(department).c;
    if (total > 0) {
      return {
        partnerCount: total,
        partnerDepartment: true,
        partnerLine: `这一年，部门的 ${total} 位伙伴与你一路同行。`,
        partnerCaption: '这一年，部门的伙伴与你一路同行。',
      };
    }
  }

  return {
    partnerCount: null,
    partnerDepartment: false,
    partnerLine: '这一年，你和伙伴们并肩同行。',
    partnerCaption: '这一年，你和伙伴们并肩同行。',
  };
}

function buildReport(db, row, themeId) {
  const pageList = pages.enabledPages(db);
  const partner = partnerInfo(db, row);
  const backgrounds = media.withBackgroundAliases(
    pageList,
    media.buildBackgroundMap(row.student_id, row.bg_dir)
  );
  const reportYear = pages.getSetting(db, 'report_year', String(new Date().getFullYear()));
  const theme = themes.resolveForReport(db, themeId || row.theme);

  return {
    studentId: row.student_id,
    name: row.name,
    department: row.department,
    joinDate: row.join_date,
    joinDays: records.computeJoinDays(row.join_date),
    volunteerHours: row.volunteer_hours,
    activityCount: row.activity_count,
    bgDir: row.bg_dir,
    bgMusic: row.bg_music,
    activities: splitActivities(row.activities),
    activity1: {
      name: row.activity1_name || '',
      date: row.activity1_date || '',
      work: row.activity1_work || '',
    },
    activity2: {
      name: row.activity2_name || '',
      date: row.activity2_date || '',
      work: row.activity2_work || '',
    },
    activity1Name: row.activity1_name || '',
    activity1Date: row.activity1_date || '',
    activity1Work: row.activity1_work || '',
    activity2Name: row.activity2_name || '',
    activity2Date: row.activity2_date || '',
    activity2Work: row.activity2_work || '',
    partnerCount: partner.partnerCount,
    partnerDepartment: partner.partnerDepartment,
    partnerLine: partner.partnerLine,
    partnerCaption: partner.partnerCaption,
    keyword: row.keyword || '',
    keywordReason: row.keyword_reason || '',
    message: row.message || '',
    reportYear: String(reportYear),
    pages: pageList,
    backgrounds,
    extras: media.extraPhotoGroups(row.student_id, pageList.map(page => page.key)),
    music: media.resolveMusicUrl(row.student_id, row.bg_music),
    themeId: theme.id,
    theme,
  };
}

module.exports = { buildReport, splitActivities, partnerInfo };
