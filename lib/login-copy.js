const pages = require('./pages');

const MAX_PREFACE = 500;
const DEFAULT_PREFACE = '输入学号与密码，打开属于你的这一年';

function normalizePreface(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  if (value.length > MAX_PREFACE) return { error: `前言最多 ${MAX_PREFACE} 个字符` };
  return { value };
}

function getPreface(db) {
  const stored = pages.getSetting(db, 'login_preface', null);
  return stored === null ? DEFAULT_PREFACE : stored;
}

function setPreface(db, raw) {
  const result = normalizePreface(raw);
  if (result.error) return result;
  pages.setSetting(db, 'login_preface', result.value);
  return { preface: result.value };
}

function getLoginCopy(db) {
  return {
    preface: getPreface(db),
    defaultPreface: DEFAULT_PREFACE,
    maxLength: MAX_PREFACE,
  };
}

module.exports = { MAX_PREFACE, DEFAULT_PREFACE, normalizePreface, getPreface, setPreface, getLoginCopy };
