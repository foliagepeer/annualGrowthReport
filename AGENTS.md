# 年度成长报告（annualGrowthReport）

## 1. 项目概览

手机端「个人年度成长报告」：姓名 + 学号登录，查看本人年度回顾（默认 8 页：封面 → 志愿时长 → 活动足迹 → 活动回忆① → 活动回忆② → 同行伙伴 → 年度关键词 → 部长寄语），整屏上下翻页；页面数量/顺序/启用由「页面注册表」配置；支持每位成员独立背景图/音乐、全站主题（配色/字体/光效）与页面排版。使用说明见 `docs/使用说明.md`。

技术栈：Node 24.22.1-alpine + Express 5 + better-sqlite3 13 + express-session（自写 SQLite Store）+ bcryptjs（仅管理员密码）；前端原生 JS + Swiper 11.2.10 + Animate.css 4.1.1（本地化，不走 CDN）；SheetJS 0.20.3 仅用于导入；Docker Compose 部署，nginx 负责静态托管与 `/api` 反代。

## 2. 数据模型与迁移

```sql
students(student_id PK, name, department, join_date, volunteer_hours, activity_count,
         activities, activity1_name, activity1_date, activity1_work,
         activity2_name, activity2_date, activity2_work,
         partner_count, keyword, keyword_reason, partner, message,
         bg_dir, bg_music, theme)
themes(id PK, name, config TEXT JSON, is_default, created_at, updated_at)
pages(key PK, type, title, position, enabled, config TEXT JSON, created_at)
settings(key PK, value)
sessions(sid PK, sess, expire)
admins(username PK, password_hash, created_at, password_changed_at, last_login_at)
```

- 成员端不再保存/校验密码；`students.password_hash` 已在启动迁移中删除。
- `students.theme` 指向 `themes.id`，NULL = 使用默认主题；`join_date` 存 `YYYY-MM-DD`（新的 8 页报告不展示加入天数，但数据保留）。
- `db.js` 启动时自动补 `bg_dir/bg_music/join_date/theme` 与活动/关键词等列（`partner_count` 为 INTEGER）；旧 `join_days` 折算后删列；没有默认主题时 seed `default`；没有页面时 seed 默认 8 页与 `report_year`；另执行一次性排版居中迁移（`lib/layout-migrate.js`，仅移动与旧默认模板完全一致的页面，settings 键 `layout_center_v1`）。
- `partner` 是旧版「年度伙伴」字段，保留在 UPSERT/撤销里，但不导入/导出/展示；新人数用 `partner_count`（留空按同部门成员数回退）。
- `settings.login_preface` 存登录页前言（纯文本，最多 500 字，`\n` 保留换行）；未设置时用 `lib/login-copy.js` 的默认文案，存空串表示登录页不显示前言。
- 主题配置形状：`{ base:{...}, fonts:{display,body}, motion:{notes,ambient}, pages:{[pageKey]:{...}}, layout:{[pageKey]:{elements:[...]}} }`；页面 key 不再硬编码，校验只检查形状（`/^[A-Za-z0-9_-]{1,40}$/`），由 `lib/themes.js` 负责。

## 3. 成员端接口与行为（`server.js`）

| 接口 | 说明 |
|---|---|
| `GET /api/login-copy` | 公开文案，返回 `{preface}`；登录页用它填充标题下方前言（`textContent`，支持换行） |
| `POST /api/login` | 姓名 + 学号；失败统一 `401 姓名或学号不正确`；成功后 `session.regenerate()` |
| `GET /api/report` | 需 Session；返回 `name/department/joinDate/joinDays/volunteerHours/activityCount`、活动列表/两条活动回忆/`partnerCount`/`partnerLine`/`partnerCaption`/`keyword`/`keywordReason`/`message`、`reportYear`、`pages`（启用顺序的 key/type/title/config）、`backgrounds`（含新 key 的旧图回退）、`extras`（按页面分组的附加图片）+ `music` + `theme` |
| `POST /api/logout` | 销毁成员会话（管理员会话独立，不受影响） |

- 防暴力破解：同学号 5 次失败锁 10 分钟，同 IP 30 次锁 10 分钟（校园网共用出口，故意放宽）；命中返回 429；计数在内存（`rate-limit.js`），重启即清空。
- 未知 `/api/*` → JSON 404；`OPTIONS` 统一 404；所有 `/api` 响应带 `Cache-Control: no-store`；方法不匹配也按 404 处理（有意简化）。
- 主题缺失/被删/JSON 损坏时，`/api/report` 一律回落默认主题，绝不让报告 500。

## 4. 前端实现（`static/`）

登录页 + 动态报告页，文件 `index.html` / `style.css` / `app.js`；管理面板 `admin.html` / `admin.js` / `admin.css`，入口 `/admin.html`。

- **动态页面**：`index.html` 只保留空的 `.swiper-wrapper`；`app.js` 的 `buildSlides(pages, data)` 按 `type/config` 生成 7 类模板（封面/数字/活动列表/活动回忆/伙伴/关键词/寄语）；进入时先销毁旧 Swiper 再建新；结尾按钮是静态节点，移到最后一个 slide；`data-bg` 使用页面 key。
- **附加图片**：`data.extras[pageKey]` 是一组按文件名自然排序的照片；有排版的页面通过 `type:'extra'` 元素（`slot` 从 1 开始）嵌在页面内，可拖动/缩放。排版没有引用到的照片在页面底部用 `.page-extra-gallery` 兜底显示（最多 6 张），不再生成单独照片页。
- **登录页前言**：`app.js` 启动时请求 `/api/login-copy`，把 `preface` 用 `textContent` 写入 `#loginPreface`（`white-space: pre-line`）；空串则隐藏；接口失败保留 HTML 默认文案。预览模式不请求。

- **翻页**：Swiper 垂直、`speed: 800`、`mousewheel`、可点击分页；`slideChangeTransitionStart` 触发当前屏动画。
- **入场动画**：自实现（不用 `swiper.animate`）。元素写 `data-animate="fadeInUp"`（可加 `data-delay` / `data-duration`），进入时移除并重挂 `animate__animated animate__<效果>`，配合 `void offsetWidth` 保证重播。
- **数字滚动**：`data-count="字段名"`，`requestAnimationFrame` 从 0 滚到目标值（整数 0 位、REAL 1 位）；空值显示破折号。
- **数据填充**：`data-field="字段名"`，一律 `textContent`；寄语用 `pre-wrap` 保留换行。
- **背景图**：页面 key（默认 `01-cover`…`08-message`）就是槽位名；查找顺序 `static/images/<bgDir 或学号>/` → `static/images/`；同名格式优先级 jpg → jpeg → png → webp；有图时自动加暗层。个人照片/活动照片/合照都作为对应页背景；旧 key（`01-opening` 等）通过 `media.BACKGROUND_ALIASES` 自动回退。`static/images/`、`static/music/` 不入库。
- **背景音乐**：右上角圆形开关（播放呼吸、暂停斜杠）；登录后自动尝试播放，被自动播放策略拦下时等用户点；偏好记在 `localStorage['report.bgm']`；查找优先级 mp3 → m4a → ogg → wav，Excel 留空时找与学号同名的文件。
- **主题**：`base` 写到 `#reportScreen` 的 `--accent` / `--accent-2` / `--accent-rgb` / `--accent-2-rgb` / `--scrim-rgb` / `--scrim-alpha`；`pages` 覆盖写到对应 slide 的内联变量；`motion` 切换 `.decor-notes-off` / `.decor-ambient-off`。
- **字体**：后端解析 URL 后，前端 FontFace API 注册 `ReportDisplay` / `ReportBody`，2 秒超时静默回退系统字体；`.huge`/`.number` 用 `--font-display`，`.line`/`.sub`/`.message` 用 `--font-body`。
- **边缘与光效**：`.decor-layer` 内联 SVG 音符 + 8 颗光点；`.entry-ring` 切页光圈（`playPage` 重挂 class，有附加图片的页面不创建）；`prefers-reduced-motion` 下全部隐藏。不要给整页加会持续动画的大面积光晕层——部分预览器/合成器会在图层接缝处渲染出横向亮带，登录页没有该层可作对照。
- **自由排版**：主题的 `layout` 有某页时，渲染 390×844 设计稿（`.layout-canvas`，按视口等比缩放，背景由页面 cover 铺满），隐藏默认文字、只保留结尾页按钮行；支持文字占位符 `{{name}}` 等与图片；字体从主题字体/预设解析；无 layout 的页面走原版式。
- **预览模式**：`/index.html?preview=1&student=<学号>&themeId=<主题 id>`，先校验管理员会话，再走管理端预览接口；隐藏退出按钮，不写音乐偏好，**绝不调用 `/api/logout`**。
- 登录页不套主题；未登录或 Session 过期时自动停在登录页。

## 5. 管理面板（`/admin.html`）

管理员用 CLI 创建，密码只存 bcrypt 哈希：

```bash
printf '你的密码\n' | docker compose exec -T app node scripts/set-admin.js admin
docker compose exec -T app node scripts/set-admin.js --list
docker compose exec -T app node scripts/set-admin.js admin --delete
```

用户名限字母/数字/下划线/点/短横线（1–32 位），密码 8–64 位；改密/删号会立即注销该管理员的会话。

**功能**：成员搜索/编辑/删除；行内「主题」单独设置主题；勾选批量操作（批量编辑字段、批量媒体、批量应用主题、导出所选、批量删除）；单条新增；文本批量与 Excel 导入/导出；背景图/音乐/字体上传与指派、按成员按页上传附加图片（嵌入页面排版）；「外观」页签（基础样式 + 页面排版）；「页面」页签（页面注册表、年度与登录页前言）。写操作都先确认；删除与批量编辑类操作带 10 秒「撤销」。

**批量媒体操作**：指派音乐（清空=回到「与学号同名」）、设置背景图目录（留空=学号目录）、把同一张图写入每名成员实际使用的图目录、删除某槽位专属图（回落共享图）；逐个成员顺序执行并显示进度。

**批量上传命名规则**：

| 文件名 / 目录 | 归属 | 落盘位置 |
|---|---|---|
| `01-cover.jpg` | 全体共享图 | `images/01-cover.jpg` |
| `2021001-01-cover.jpg` 或 `2021001_01-cover.jpg` | 该成员专属图 | `images/2021001/01-cover.jpg` |
| 文件夹内 `2021001/01-cover.jpg` | 该成员专属图 | 同上 |
| `2021001__04-memory-1__01.jpg` 或文件夹 `2021001/04-memory-1/01.jpg` | 该成员该页附加图片 | `images/extras/2021001/04-memory-1/01.jpg` |
| `2021001.mp3` | 该成员背景音乐（自动生效） | `music/2021001.mp3` |

槽位名就是页面 key；旧版 `01-opening` 等仍识别，并通过 `BACKGROUND_ALIASES` 回退显示。无法识别归属、学号不存在、超限的文件会在上传前拦下；同名默认跳过（可勾选覆盖）。批量上传不改数据库，只放文件。

**接口一览**（均在 `/api/admin`，未登录 `401 {"error":"管理员未登录"}`）：

| 方法 路径 | 作用 |
|---|---|
| `POST /login`、`POST /logout`、`GET /session` | 登录（用户名 5 次/15 分钟、IP 10 次/15 分钟）、退出（仅退面板）、查登录态 |
| `GET /meta` | 表头、页面注册表（`pages`/`pageKeys`）、年度、登录页前言（`loginCopy`）、大小上限、扩展名、字体预设、`media.writable` |
| `GET /pages`、`POST /pages`、`PUT /pages/:key`、`DELETE /pages/:key` | 页面注册表列表 / 新增 / 更新（标题/类型/配置/启用）/ 删除；`POST /pages/:key/move` 调整顺序；`PUT /settings` 改年度或登录页前言（`loginPreface`） |
| `GET /students?q=&limit=` | 成员列表，搜索用 `instr()` |
| `POST /students` / `PUT /students/:id` / `DELETE /students/:id` | 新增 / 局部更新 / 删除（并清会话） |
| `POST /students/batch` | 批量编辑 `set`（部门/入会日期/志愿时长/活动次数/活动记录/两次回忆/伙伴人数/年度关键词/关键词依据/部长寄语/背景图目录/背景音乐/主题）、`autoActivities`（按各人回忆名称生成活动记录）；最多 500 人 |
| `POST /students/batch-delete`、`POST /students/undo` | 批量删除、按一次性 token 撤销上一次改动 |
| `GET /students/:id/report?themeId=` | 预览报告与资源解析（可覆盖主题） |
| `GET/POST/DELETE /students/:id/photos?pageKey=&name=` | 成员附加图片：按页面列出 / 上传（raw 字节，5MB，可 `overwrite=1`）/ 删除；文件存 `static/images/extras/<学号>/<pageKey>/`，通过排版 `extra` 元素嵌入页面 |
| `GET /themes`、`POST /themes`、`PUT /themes/:id`、`DELETE /themes/:id` | 主题列表（含使用人数）/ 新建 / 更新 / 删除（默认或被引用 → 400/409） |
| `POST /themes/:id/default`、`POST /themes/:id/duplicate`、`GET /themes/fonts` | 设默认 / 复制 / 字体预设与自定义槽位（**必须先于 `/themes/:id` 注册**） |
| `POST /import/text/preview`、`/import/text`、`/import/xlsx/preview`、`/import/xlsx` | 文本 / Excel 预览与执行（Excel 用原始字节 + `X-File-Name`，不用 multipart） |
| `GET /export/xlsx`、`GET /export/template.xlsx`、`POST /export/xlsx` | 导出全部 / 模板 / 导出勾选（`{studentIds}`） |
| `GET /media`、`POST /media/upload`、`DELETE /media` | 媒体全景、上传（`kind=image|music|font|decor`）、删除；音乐上限 10MB，字体仅两槽位且校验 woff magic、8MB；装饰图存 `static/images/decor/` |

**交互约定**：成功/信息用右下角轻提示（默认 4.5 秒、带撤销 10 秒，提示本身不可点关闭，只能点小叉）；错误/校验用页面内对话框；危险操作红色确认按钮。不用原生 `confirm/alert/prompt`。

## 6. Excel / 文本导入与学年维护

```bash
docker compose exec app node scripts/import-excel.js --template     # 生成模板
docker compose exec app node scripts/import-excel.js import/x.xlsx  # 导入
```

表头：`学号、姓名、部门、入会日期、志愿时长、活动次数、活动记录、活动一名称/日期/工作、活动二名称/日期/工作、伙伴人数、年度关键词、关键词依据、部长寄语、背景图目录、背景音乐`。入会日期认 `2024-09-01`、`2024/9/1`、`2024.9.1`、`2024年9月1日`、`20240901`、Excel 日期/序列号；活动一/二日期同样认这些写法，且可填多个（用 `、` 分隔，展示用）；「活动记录」留空时由两条活动回忆名称自动生成；写错逐行报错跳过。

不再有密码列；按学号 upsert。旧 Excel 里的密码列会被忽略，旧 11 列文本仍兼容。

- **主题不受导入影响**：主题不进 Excel/文本字段顺序（防破坏按列粘贴），未提供时继承库里的值；「导出 → 再导入」不会清空主题。
- **缺列继承**：旧 11 列模板/文本缺少的活动/关键词等新列会沿用库里的原值；新版 19 列留空才会清空。文本导入 11 列按旧表头映射，19 列按新表头映射；含密码列的旧 20 列文本需删除密码列。
- 背景图/音乐留空即回到默认规则（学号目录 / 同学号音频）；文件放好即生效，无需重启。
- 库内测试账号：2021001 张三、2021002 李四、2021003 王五（用姓名 + 学号登录）；投放前删除。

## 7. 部署与运维

**Compose**：`report-app`（容器内 3000，不映射端口）+ `report-nginx`（`${HTTP_PORT}:80`，当前 80）。`app` 挂载数据卷 `sqlite_data:/app/data`、`./import`、`./static`（**读写**）；`nginx` 挂载 `./nginx`（目录）与 `./static`（只读）。上传文件属主是 root，宿主机原地覆盖会 EACCES，先删/`mv` 或 `sudo chown`。`app.build.network: host`（容器 bridge 无 IPv6 路由，构建期借用宿主机网络）。

**镜像**：`node:24.22.1-alpine` 多阶段构建，`npm ci --omit=dev --ignore-scripts`，运行阶段只拷贝依赖与代码。Docker Hub 直连不可达，用 `docker.m.daocloud.io` 拉取后 retag；npm 走 `registry.npmmirror.com`；better-sqlite3 自带 musl 预编译，无需编译工具链；SheetJS 用 `vendor/xlsx-0.20.3.tgz` 的 `file:` 依赖。

**nginx**（`nginx/default.conf` + `snippets/security-headers.conf`）：

- 静态托管 + `/api` 反代（`proxy_read_timeout 300s`）；**不做 SPA 回退**（`try_files ... =404`），避免把漏文件伪装成 200 HTML。入口文件（`/`、`app.js`、`style.css`）带 `Cache-Control: no-cache`，避免成员端拿旧脚本。
- `/admin`、`/admin/` → 301 `/admin.html`；面板三文件 `no-cache`。
- `/images/`、`/music/`、`/fonts/` 30 天缓存；`/fonts/` 无需 types 块（nginx 自带 woff/woff2）。**location 里写了 `add_header` 就不再继承上层，必须 include 安全头片段**。
- 安全头：nosniff、X-Frame-Options、Referrer-Policy、CSP（`default-src 'self'`，`script-src 'self'`，样式允许内联）。
- `keepalive_timeout 300s`；`client_max_body_size 12m` + JSON 413（音乐 10MB 需留余量）；gzip 仅文本类，`/api` 与图片显式关闭；HSTS 等 HTTPS 落地再加。

**常用命令**：部署/重建 `docker compose up -d --build`；看日志 `docker compose logs -f app`；改 nginx 后 `docker compose exec nginx nginx -s reload`；改前端静态文件直接刷新，无需重启；停止 `docker compose down`；备份数据库 `docker run --rm -v sqlite_data:/data -v $(pwd):/backup alpine tar cvf /backup/backup.tar /data`。

**目录**：`server.js`（入口）/ `db.js`（建库迁移）/ `session-store.js` / `rate-limit.js` / `lib/student-records.js`（成员规则）/ `lib/media.js`（资源解析与写入）/ `lib/themes.js`（主题）/ `lib/undo-buffer.js` / `routes/admin.js` / `scripts/*`；`static/` 含页面、`vendor/`、`images/`（不入库）、`music/`（不入库）、`fonts/presets/`（入库）与 `fonts/custom/`（不入库）。

**当前环境**：Debian 13，内网 `10.129.246.40`，站点 HTTP 80；frpc 隧道不通，暂无公网入口；HTTPS 未启用。

## 8. 关键实现约束（改动时勿破坏）

- **成员规则只有一处**：`lib/student-records.js` 被 CLI、文本/Excel 导入、面板增改共用，不要另写校验；导入"先异步算 bcrypt，再单事务写入"，避免阻塞事件循环。
- **主题三处同步**：`UPSERT_SQL` 列清单与 `DO UPDATE SET`、`planRecords` 的「未提供则继承」；少一处会导致导入/编辑清空主题或撤销丢主题。悬空主题引用在下次编辑时自愈为 null。
- **主题不进** `records.HEADERS`/导出列；批量赋主题走 `batch.set.theme`（空串=默认主题），可撤销；主题配置修改即时生效且不在撤销快照内。
- **路由顺序**：`GET /themes/fonts` 必须在 `/themes/:id` 之前；管理路由挂在全局 `express.json()` 之前（自带 2MB 上限）。
- **上传安全**：扩展名白名单 + 文件名白名单 + `path.resolve` 前缀断言 + 临时文件 rename；同名默认 409，`overwrite=1` 才覆盖；同基名高优先级格式会遮蔽，响应 `shadows` 指出；资源 URL 一律带 `?v=<mtime>-<size>`。
- **字体**：预设 5 款 OFL 子集字（ASCII + 常用标点 + GB2312 一级字 3755 + 界面文案，约 4200 字；生僻字逐字回退系统字体）入库，重新生成用 `scripts/subset-font-presets.py`（需 fonttools + brotli）；自定义 `fonts/custom/display|body.(woff2|woff)` 不入库，单文件 8MB，一槽一文件。
- **会话**：管理员与成员使用**独立 cookie**（`report.admin.sid` / `report.sid`），登录/退出互不影响；`/api/admin/logout` 只销毁管理会话，`/api/logout` 只销毁成员会话。预览窗口不得调用 `/api/logout`、不得写音乐偏好；非管理员带预览参数回落登录页。
- **撤销**：`lib/undo-buffer.js` 内存快照，15 分钟 / 20 条上限，重启清空；媒体文件删除不可撤销。
- **页面注册表**：`pages` 表是唯一页面来源（`lib/pages.js`）；`media.PAGE_KEYS` 已移除，`/meta`/`/media`/`/api/report`/主题排版页下拉都从注册表取；页面 key 就是背景槽位名，旧 key 通过 `media.BACKGROUND_ALIASES` 回退；主题 `pages`/`layout` 的 key 只校验形状，不因旧 key 报 400。
- **照片即页面背景**：封面个人照片、活动回忆照片、伙伴/寄语合照都走 per-member 图片目录（`<key>.jpg`），不是 DB 字段；排版里的 image 元素只用于 `/images/decor/` 装饰图。
- **附加图片与排版关联**：存 `static/images/extras/<学号>/<pageKey>/`，不写数据库；报告按 `pages` 的启用 key 扫描。排版用 `type:'extra'` + `slot`（1 起）取第 N 张，可拖动/缩放；未引用的照片走底部兜底画廊。上传/删除走 `/students/:id/photos`，文件名即顺序；页面/成员删除不清理磁盘文件。
- **动态页面**：`app.js buildSlides` 按页面类型生成 slide；重新登录先 `swiper.destroy(true,false)` 再重建；结尾按钮是静态节点 `#endingActions`，移动到最后一个 slide，不丢事件。
- **响应约定**：`/api` 全部 `no-store`；`OPTIONS` 与方法不匹配统一 404；错误 JSON `{error}`。
- **性能**：约 400 rps，并发 25 以上延迟上升但不报错；扩容方向是多实例 + nginx，而不是改业务代码。

## 9. 验证清单

- 旧库启动：补列、`themes`/`pages`/`settings` seed、登录/报告/导入导出/媒体无回归；旧主题不报 400。
- 接口：`POST /api/login` 需姓名+学号，旧密码字段返回 400，`/api/password` 为 404；`/api/report` 含 pages/新字段/backgrounds/music/theme；页面注册表 CRUD/排序/启停/年度；主题 CRUD、默认/复制、删除保护；`/themes/fonts` 不被 `:id` 吞；字体上传 magic/8MB/覆盖清理；音乐 10MB；请求体 >12MB 413。
- 数据链路：赋主题 → 编辑 → 文本导入（19 列/旧 11 列）→ Excel 导入 → 删除后撤销，主题与新字段不丢；导出再导入不丢；缺列继承生效。
- 成员端：姓名+学号登录/退出；8 页动态渲染/翻页/动画/数字滚动；照片背景与暗层；音乐开关；页面注册表顺序/启停；附加图片按页插入且顺序正确；最后一个 slide 的按钮；主题颜色/字体/排版；`prefers-reduced-motion` 降级；预览模式无退出。
- 页面排版：8 类默认模板、拖动/缩放/属性/加文字/加图片/恢复默认/保存；新占位符；结尾按钮保留。
- 管理端：页面注册表、批量操作与撤销、批量媒体、按文件名归属、外观编辑与真实预览、提示/对话框样式。
- 移动端手测：iPhone/Android 字体加载无跳动、自动播放被拦、动画帧率正常。

## 10. 页面排版

主题 config 增加 `layout: { [pageKey]: { elements: [...] } }`，元素坐标与字号按 **390×844 设计稿像素**，渲染时按视口等比缩放、背景由页面 cover 铺满。

- **text**：`{ id, type:'text', x, y, w, text, unit, font, size, weight, color, align, lineHeight, opacity, z }`
  - `font`：`null`（系统）/ `'display'` / `'body'`（跟随主题字体）/ 预设 id
  - 占位符：`{{name}}`、`{{department}}`、`{{joinDays}}`、`{{volunteerHours}}`、`{{activityCount}}`、`{{activities}}`、`{{activity1Name}}`、`{{activity1Date}}`、`{{activity1Work}}`、`{{activity2Name}}`、`{{activity2Date}}`、`{{activity2Work}}`、`{{partnerCount}}`、`{{partnerLine}}`、`{{partnerCaption}}`、`{{keyword}}`、`{{keywordReason}}`、`{{reportYear}}`、`{{message}}`
- **image**：`{ id, type:'image', x, y, w, h, src, fit, radius, opacity, z }`，`src` 只允许 `/images/decor/<安全文件名>`
- **extra**：`{ id, type:'extra', x, y, w, h, slot, fit, radius, opacity, z }`，`slot` 1–12，取该成员在该页附加图片的第 N 张；成员没有这张时不渲染。编辑器「补齐图片槽位」按类型补默认数量（回忆 2，放在居中工作下方；伙伴 1，放在伙伴文案下方），未引用的照片底部兜底展示
- 校验（`lib/themes.js`）：每页 ≤40 个元素、文字 ≤2000 字，坐标/尺寸/字号/颜色/字重/层级均有范围；未知字段剔除，非法值 400。
- 编辑：外观页「页面排版」模式，画布 390×844 等比缩放；按页面 type/config 分派默认模板（封面/数字/活动列表/回忆/伙伴/关键词/寄语）；拖动移动、右下角手柄调宽（图片/图片槽位可调高）；右侧分「元素」「属性」两个页签（选中元素自动切到属性，可返回元素列表）；属性面板可直接输入 X/Y/宽/高，并改文字/单位/字体/字号/字重/颜色/对齐/透明度/层级，或图片槽位的序号/填充/高度/圆角；进入排版页时默认按现有版式生成可编辑元素，「补齐图片槽位」补默认数量，「恢复默认排版」把该页重置为默认模板。
- 装饰图：`POST /media/upload?kind=decor`，存 `static/images/decor/`，5MB；编辑器上传后插入元素。
- 渲染：有 layout 的页面隐藏 `.page-inner` 默认文字、只保留结尾页按钮行，`renderLayout` 生成 `.layout-canvas` 并解析 `extra` 照片；无 layout 的页面走原版式，附加图片在底部 `.page-extra-gallery` 兜底。`playPage` 重播布局入场动画；`prefers-reduced-motion` 下关闭。
- 约束：排版属于主题，随「应用主题」分配；修改即时生效且不可撤销；结尾页按钮固定底部；不同手机比例按设计稿等比缩放，上下/左右可能有背景留白。
