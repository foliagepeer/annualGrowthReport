#!/usr/bin/env python3
"""把预置字体子集化成报告用的单文件 woff2。

用法（宿主机，需要 fonttools 与 brotli）：
    PYTHONPATH=/path/to/fontlibs python3 scripts/subset-font-presets.py --source /tmp/fonts-src

字集 = ASCII + 常用标点区间 + GB2312 一级汉字（3755 个，用标准库 gb2312 生成）
      + static/ 下 HTML/JS 里出现的中文字符。生僻字由浏览器的字体回退逐字兜底。
"""
import argparse
import pathlib
import re

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'static' / 'fonts' / 'presets'

# 源文件名: (源文件, 需要固定的可变字体字重)
SOURCES = {
    'smiley-sans': ('SmileySans-Oblique.ttf', None),
    'lxgw-wenkai': ('LXGWWenKai-Regular.ttf', None),
    'noto-sans-sc': ('NotoSansSC-VF.ttf', 400),
    'zcool-kuaile': ('ZCOOLKuaiLe-Regular.ttf', None),
    'ma-shan-zheng': ('MaShanZheng-Regular.ttf', None),
}


def build_charset():
    chars = {chr(code) for code in range(0x20, 0x7F)}
    for start, end in ((0x2000, 0x206F), (0x3000, 0x303F), (0xFF00, 0xFFEF)):
        chars.update(chr(code) for code in range(start, end + 1))

    # GB2312 一级汉字：区 0xB0–0xD7，位 0xA1–0xFE
    for lead in range(0xB0, 0xD8):
        for trail in range(0xA1, 0xFF):
            try:
                chars.add(bytes([lead, trail]).decode('gb2312'))
            except UnicodeDecodeError:
                continue

    static = ROOT / 'static'
    for pattern in ('*.html', '*.js', '*.md'):
        for path in static.rglob(pattern):
            try:
                text = path.read_text(encoding='utf-8')
            except (UnicodeDecodeError, OSError):
                continue
            chars.update(re.findall(r'[\u4e00-\u9fff]', text))
    return ''.join(sorted(chars))


def rename_family(font, label):
    # OFL 带保留字体名（RFN）时，子集化属于修改，按许可要求换掉族名；
    # 页面运行时用的是固定 family 名，不依赖文件内名称。
    family = f'ReportPreset {label}'
    name = font['name']
    for name_id, value in ((1, family), (4, family), (6, family.replace(' ', '')), (16, family)):
        name.setName(value, name_id, 3, 1, 0x409)


def subset_one(src, dst, charset, label, weight=None):
    font = TTFont(src)
    if weight is not None and 'fvar' in font:
        font = instancer.instantiateVariableFont(font, {'wght': weight})

    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern', 'liga']
    options.hinting = False
    options.desubroutinize = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=charset)
    subsetter.subset(font)

    rename_family(font, label)
    font.flavor = 'woff2'
    font.save(dst)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='/tmp/fonts-src', help='源字体目录')
    parser.add_argument('--only', help='只处理某个 id')
    args = parser.parse_args()

    source_dir = pathlib.Path(args.source)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    charset = build_charset()
    (OUT_DIR / 'charset.txt').write_text(charset, encoding='utf-8')
    print(f'charset: {len(charset)} chars')

    for preset_id, (filename, weight) in SOURCES.items():
        if args.only and args.only != preset_id:
            continue
        src = source_dir / filename
        if not src.exists():
            print(f'skip {preset_id}: {src} 不存在')
            continue
        dst = OUT_DIR / f'{preset_id}.woff2'
        subset_one(src, dst, charset, preset_id.replace('-', ' ').title(), weight)
        print(f'{preset_id}: {dst.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
