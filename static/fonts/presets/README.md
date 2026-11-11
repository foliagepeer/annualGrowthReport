# 预置字体

这些是报告「外观/主题」里可选的字体，全部为 SIL Open Font License 1.1（可免费商用），
已子集化为单文件 woff2，只保留常用字集（ASCII + 常用标点 + GB2312 一级汉字 + 界面用字，约 4200 字）。
生僻字由浏览器按 CSS 字体回退逐字兜底，不会乱码。

| 文件 | 字体 | 适用 | 来源 |
|---|---|---|---|
| `smiley-sans.woff2` | 得意黑 Smiley Sans | 标题、大数字 | https://github.com/atelier-anchor/smiley-sans （v2.0.1） |
| `lxgw-wenkai.woff2` | 霞鹜文楷 LXGW WenKai | 正文、寄语 | https://github.com/lxgw/LxgwWenKai （v1.530） |
| `noto-sans-sc.woff2` | 思源黑体 Noto Sans SC（Regular 400） | 正文 | https://github.com/google/fonts/tree/main/ofl/notosanssc |
| `zcool-kuaile.woff2` | 站酷快乐体 ZCOOL KuaiLe | 活泼标题 | https://github.com/google/fonts/tree/main/ofl/zcoolkuaile |
| `ma-shan-zheng.woff2` | 马善政毛笔楷书 Ma Shan Zheng | 点题标题 | https://github.com/google/fonts/tree/main/ofl/mashanzheng |

许可证原文在 `licenses/`。子集化属于对字体的修改：脚本会把内部族名统一改成
`ReportPreset <名称>`，页面运行时使用的 family 名则是固定的 `ReportDisplay` / `ReportBody`。

## 重新生成

需要 Python 3 + `fonttools` + `brotli`。把上表的源文件（ttf/otf）放到一个目录，
例如 `/tmp/fonts-src`，文件名与 `scripts/subset-font-presets.py` 的 `SOURCES` 对应，然后：

```bash
PYTHONPATH=/path/to/fontlibs python3 scripts/subset-font-presets.py --source /tmp/fonts-src
```

脚本会重写 `charset.txt` 与全部 `*.woff2`。`static/fonts/custom/` 是后台「外观」页签上传的
自定义字体，不进版本库。
