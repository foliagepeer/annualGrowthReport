#!/usr/bin/env node
// 命令行导入成员数据（规则与面板完全一致，都来自 lib/student-records）
const fs = require('fs');
const path = require('path');
const db = require('../db');
const records = require('../lib/student-records');

function usage() {
  console.log(`用法：
  node scripts/import-excel.js <数据文件.xlsx>     按学号导入或更新成员数据
  node scripts/import-excel.js --template [路径]   生成空白模板（默认 import/students-template.xlsx）

Excel 首行为表头，列名：${records.HEADERS.join('、')}`);
}

function writeTemplate(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, records.templateBuffer());
  console.log(`模板已生成：${target}`);
  console.log('提示：示例行仅供参照，正式使用时请删掉。');
  console.log('「背景图目录」「背景音乐」可留空：留空时自动用 images/学号/ 目录与 music/学号.mp3。');
}

function importFile(file) {
  const { rows, sheetName } = records.parseExcelBuffer(fs.readFileSync(file));
  console.log(`读取工作表「${sheetName}」，共 ${rows.length} 行数据`);
  if (rows.length === 0) throw new Error('没有读到数据行，请检查表头是否在第 1 行');

  const missing = records.missingHeaders(rows);
  if (missing.length > 0) throw new Error(`缺少必需的列：${missing.join('、')}`);

  const plan = records.planRecords(db, rows);
  const result = records.applyRecords(db, plan.items);

  console.log(`导入完成：成功 ${result.imported} 条，跳过 ${result.skipped.length} 条`);
  if (result.unchanged > 0) console.log(`（另有 ${result.unchanged} 条与库中数据一致，未做改动）`);
  result.skipped.forEach(item => console.log(`  - 第 ${item.line} 行：${item.message}`));
  console.log(`数据库：${db.name}`);
}

function main() {
  const args = process.argv.slice(2);

  const templateFlag = args.indexOf('--template');
  if (templateFlag !== -1) {
    writeTemplate(args[templateFlag + 1] || 'import/students-template.xlsx');
    return;
  }

  const file = args[0];
  if (!file) {
    usage();
    process.exit(1);
  }
  importFile(file);
}

try {
  main();
} catch (err) {
  console.error(`导入失败：${err.message}`);
  process.exit(1);
}
