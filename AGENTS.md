# 年度成长报告（annualGrowthReport）

## 1. 项目概览

手机端「个人年度成长报告」：学号 + 密码登录，查看本人 7 屏回顾（开场 → 加入天数 → 志愿时长 → 活动次数 → 年度伙伴 → 部长寄语 → 结尾），整屏上下翻页；支持每学员独立背景图/音乐、全站主题（配色/字体/光效）与管理控制台。使用说明见 `docs/使用说明.md`。

技术栈：Node 24.22.1-alpine + Express 5 + better-sqlite3 13 + express-session（自写 SQLite Store）+ bcryptjs；前端原生 JS + Swiper 11.2.10 + Animate.css 4.1.1（本地化，不走 CDN）；SheetJS 0.20.3 仅用于导入；Docker Compose 部署，nginx 负责静态托管与 `/api` 反代。

## 2. 数据模型与迁移

```sql
students(student_id PK, name, department, join_date, volunteer_hours, activity_count,
         partner, message, password_hash, bg_dir, bg_music, theme)
themes(id PK, name, config TEXT JSON, is_default, created_at, updated_at)
sessions(sid PK, sess, expire)
admins(username PK, password_hash, created_at, password_changed_at, last_login_at)
```

- `students.theme` 指向 `themes.id`，NULL = 使用默认主题；`join_date` 存 `YYYY-MM-DD`，加入天数由 `computeJoinDays()` 实时算，不落库。
- `db.js` 启动时自动补 `bg_dir/bg_music/join_date/theme` 列；旧 `join_days` 按「今天往前推 N 天」折算成 `join_date` 后删列；没有默认主题时自动 seed `default`。
- 主题配置形状：`{ base:{accent,accent2,scrim,scrimColor}, fonts:{display,body}, motion:{notes,ambient}, pages:{[pageKey]:{accent?,accent2?,scrim?,scrimColor?}} }`，校验唯一来源 `lib/themes.js`。

## 3. 学员端接口与行为（`server.js`）

| 接口 | 说明 |
|---|---|
| `POST /api/login` | 学号 + 密码；失败统一 `401 学号或密码错误`，不区分学号是否存在；成功后 `session.regenerate()` |
| `GET /api/report` | 需 Session；返回 `name/department/joinDate/joinDays/volunteerHours/activityCount/partner/message` + `backgrounds`（基名→URL，只含磁盘真实存在的图）+ `music`（URL 或 null）+ `theme`（颜色/动效/按页覆盖 + 解析后的字体 URL，带 `?v=`） |
| `POST /api/password` | 校验旧密码；新密码 6–64 位且不同于旧密码；成功后注销该学员其他设备的会话 |
| `POST /api/logout` | 销毁整个会话（连管理面板一起退） |

- 防暴力破解：同学号 5 次失败锁 10 分钟，同 IP 30 次锁 10 分钟（校园网共用出口，故意放宽）；命中返回 429；计数在内存（`rate-limit.js`），重启即清空。
- 未知 `/api/*` → JSON 404；`OPTIONS` 统一 404；所有 `/api` 响应带 `Cache-Control: no-store`；方法不匹配也按 404 处理（有意简化）。
- 主题缺失/被删/JSON 损坏时，`/api/report` 一律回落默认主题，绝不让报告 500。

## 4. 前端实现（`static/`）

登录页 + 7 屏报告 + 修改密码页，文件 `index.html` / `style.css` / `app.js`；管理面板 `admin.html` / `admin.js` / `admin.css`，入口 `/admin.html`。

- **翻页**：Swiper 垂直、`speed: 800`、`mousewheel`、可点击分页；`slideChangeTransitionStart` 触发当前屏动画。
- **入场动画**：自实现（不用 `swiper.animate`）。元素写 `data-animate="fadeInUp"`（可加 `data-delay` / `data-duration`），进入时移除并重挂 `animate__animated animate__<效果>`，配合 `void offsetWidth` 保证重播。
- **数字滚动**：`data-count="字段名"`，`requestAnimationFrame` 从 0 滚到目标值（整数 0 位、REAL 1 位）；空值显示破折号。
- **数据填充**：`data-field="字段名"`，一律 `textContent`；寄语用 `pre-wrap` 保留换行。
- **背景图**：`data-bg="01-opening"` 等 7 个键；查找顺序 `static/images/<bgDir 或学号>/` → `static/images/`；同名格式优先级 jpg → jpeg → png → webp；有图时自动加暗层（颜色/强度走主题变量）。`static/images/`、`static/music/` 不入库。
- **背景音乐**：右上角圆形开关（播放呼吸、暂停斜杠）；登录后自动尝试播放，被自动播放策略拦下时等用户点；偏好记在 `localStorage['report.bgm']`；查找优先级 mp3 → m4a → ogg → wav，Excel 留空时找与学号同名的文件。
- **主题**：`base` 写到 `#reportScreen` 的 `--accent` / `--accent-2` / `--accent-rgb` / `--accent-2-rgb` / `--scrim-rgb` / `--scrim-alpha`；`pages` 覆盖写到对应 slide 的内联变量；`motion` 切换 `.decor-notes-off` / `.decor-ambient-off`。
- **字体**：后端解析 URL 后，前端 FontFace API 注册 `ReportDisplay` / `ReportBody`，2 秒超时静默回退系统字体；`.huge`/`.number` 用 `--font-display`，`.line`/`.sub`/`.message` 用 `--font-body`。
- **边缘与光效**：`.decor-layer` 内联 SVG 音符 + 8 颗光点；`.page::before` 环境柔光（上半屏，遮罩向下渐隐）；`.entry-ring` 切页光圈（`playPage` 重挂 class）；`prefers-reduced-motion` 下全部隐藏。
- **预览模式**：`/index.html?preview=1&student=<学号>&themeId=<主题 id>`，先校验管理员会话，再走管理端预览接口；隐藏改密/退出，不写音乐偏好，**绝不调用 `/api/logout`**。
- 登录/改密页不套主题；未登录或 Session 过期时自动停在登录页。

## 5. 管理面板（`/admin.html`）

管理员用 CLI 创建，密码只存 bcrypt 哈希：

```bash
printf '你的密码\n' | docker compose exec -T app node scripts/set-admin.js admin
docker compose exec -T app node scripts/set-admin.js --list
docker compose exec -T app node scripts/set-admin.js admin --delete
```

用户名限字母/数字/下划线/点/短横线（1–32 位），密码 8–64 位；改密/删号会立即注销该管理员的会话。

**功能**：成员搜索/编辑/删除；勾选批量操作（批量改字段、重置密码为学号后六位、批量媒体、批量应用主题、导出所选、批量删除）；单条新增；文本批量与 Excel 导入/导出；背景图/音乐/字体上传与指派；「外观」页签（主题 CRUD、颜色/暗层/字体/动效、按页覆盖、草稿预览、真实报告预览）。写操作都先确认；删除与批量修改类操作带 10 秒「撤销」。

**批量媒体操作**：指派音乐（清空=回到「与学号同名」）、设置背景图目录（留空=学号目录）、把同一张图写入每名学员实际使用的图目录、删除某槽位专属图（回落共享图）；逐个学员顺序执行并显示进度。

**批量上传命名规则**：

| 文件名 / 目录 | 归属 | 落盘位置 |
|---|---|---|
| `01-opening.jpg` | 全体共享图 | `images/01-opening.jpg` |
| `2021001-01-opening.jpg` 或 `2021001_01-opening.jpg` | 该学员专属图 | `images/2021001/01-opening.jpg` |
| 文件夹内 `2021001/01-opening.jpg` | 该学员专属图 | 同上 |
| `2021001.mp3` | 该学员背景音乐（自动生效） | `music/2021001.mp3` |

无法识别归属、学号不存在、超限的文件会在上传前拦下；同名默认跳过（可勾选覆盖）。批量上传不改数据库，只放文件。

**接口一览**（均在 `/api/admin`，未登录 `401 {"error":"管理员未登录"}`）：

| 方法 路径 | 作用 |
|---|---|
| `POST /login`、`POST /logout`、`GET /session` | 登录（用户名 5 次/15 分钟、IP 10 次/15 分钟）、退出（仅退面板）、查登录态 |
| `GET /meta` | 表头、7 个图片槽位、大小上限、扩展名、字体预设、`media.writable` |
| `GET /students?q=&limit=` | 成员列表（不含 password_hash），搜索用 `instr()` |
| `POST /students` / `PUT /students/:id` / `DELETE /students/:id` | 新增 / 局部更新（改了密码会踢其他设备）/ 删除（并清会话） |
| `POST /students/batch` | 批量修改 `set`（部门/入会日期/志愿时长/活动次数/年度伙伴/部长寄语/背景图目录/背景音乐/主题）或 `resetPasswordToDefault`；最多 500 人 |
| `POST /students/batch-delete`、`POST /students/undo` | 批量删除、按一次性 token 撤销上一次改动 |
| `GET /students/:id/report?themeId=` | 预览报告与资源解析（可覆盖主题） |
| `GET /themes`、`POST /themes`、`PUT /themes/:id`、`DELETE /themes/:id` | 主题列表（含使用人数）/ 新建 / 更新 / 删除（默认或被引用 → 400/409） |
| `POST /themes/:id/default`、`POST /themes/:id/duplicate`、`GET /themes/fonts` | 设默认 / 复制 / 字体预设与自定义槽位（**必须先于 `/themes/:id` 注册**） |
| `POST /import/text/preview`、`/import/text`、`/import/xlsx/preview`、`/import/xlsx` | 文本 / Excel 预览与执行（Excel 用原始字节 + `X-File-Name`，不用 multipart） |
| `GET /export/xlsx`、`GET /export/template.xlsx`、`POST /export/xlsx` | 导出全部 / 模板 / 导出勾选（`{studentIds}`） |
| `GET /media`、`POST /media/upload`、`DELETE /media` | 媒体全景、上传（`kind=image|music|font`）、删除；字体仅两槽位且校验 woff magic、8MB |

**交互约定**：成功/信息用右下角轻提示（默认 4.5 秒、带撤销 10 秒，提示本身不可点关闭，只能点小叉）；错误/校验用页面内对话框；危险操作红色确认按钮。不用原生 `confirm/alert/prompt`。

## 6. Excel / 文本导入与学年维护

```bash
docker compose exec app node scripts/import-excel.js --template     # 生成模板
docker compose exec app node scripts/import-excel.js import/x.xlsx  # 导入
```

表头：`学号、密码、姓名、部门、入会日期、志愿时长、活动次数、年度伙伴、部长寄语、背景图目录、背景音乐`（后两列可选）。入会日期认 `2024-09-01`、`2024/9/1`、`2024.9.1`、`2024年9月1日`、`20240901`、Excel 日期/序列号；写错逐行报错跳过。

密码三规则：填了值 → 重设；留空且已存在 → 保留原密码；留空且新学员 → 用学号后六位。按学号 upsert。

- **主题不受导入影响**：主题不进 Excel/文本字段顺序（防破坏按列粘贴），未提供时继承库里的值；「导出 → 再导入」不会清空主题。
- 背景图/音乐留空即回到默认规则（学号目录 / 同学号音频）；文件放好即生效，无需重启。
- 库内测试账号：2021001 张三、2021002 李四（`init123456`），2021003 王五（`021003`）；投放前删除。

## 7. 部署与运维

**Compose**：`report-app`（容器内 3000，不映射端口）+ `report-nginx`（`${HTTP_PORT}:80`，当前 80）。`app` 挂载数据卷 `sqlite_data:/app/data`、`./import`、`./static`（**读写**）；`nginx` 挂载 `./nginx`（目录）与 `./static`（只读）。上传文件属主是 root，宿主机原地覆盖会 EACCES，先删/`mv` 或 `sudo chown`。`app.build.network: host`（容器 bridge 无 IPv6 路由，构建期借用宿主机网络）。

**镜像**：`node:24.22.1-alpine` 多阶段构建，`npm ci --omit=dev --ignore-scripts`，运行阶段只拷贝依赖与代码。Docker Hub 直连不可达，用 `docker.m.daocloud.io` 拉取后 retag；npm 走 `registry.npmmirror.com`；better-sqlite3 自带 musl 预编译，无需编译工具链；SheetJS 用 `vendor/xlsx-0.20.3.tgz` 的 `file:` 依赖。

**nginx**（`nginx/default.conf` + `snippets/security-headers.conf`）：

- 静态托管 + `/api` 反代（`proxy_read_timeout 300s`）；**不做 SPA 回退**（`try_files ... =404`），避免把漏文件伪装成 200 HTML。
- `/admin`、`/admin/` → 301 `/admin.html`；面板三文件 `no-cache`。
- `/images/`、`/music/`、`/fonts/` 30 天缓存；`/fonts/` 无需 types 块（nginx 自带 woff/woff2）。**location 里写了 `add_header` 就不再继承上层，必须 include 安全头片段**。
- 安全头：nosniff、X-Frame-Options、Referrer-Policy、CSP（`default-src 'self'`，`script-src 'self'`，样式允许内联）。
- `keepalive_timeout 300s`；`client_max_body_size 8m` + JSON 413；gzip 仅文本类，`/api` 与图片显式关闭；HSTS 等 HTTPS 落地再加。

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
- **会话**：管理员与学员共用 cookie；`/api/admin/logout` 只退面板，`/api/logout` 销毁全部；预览窗口不得调用 `/api/logout`、不得写音乐偏好；非管理员带预览参数回落登录页。
- **撤销**：`lib/undo-buffer.js` 内存快照（含密码哈希），15 分钟 / 20 条上限，重启清空；媒体文件删除不可撤销。
- **响应约定**：`/api` 全部 `no-store`；`OPTIONS` 与方法不匹配统一 404；错误 JSON `{error}`。
- **性能**：约 400 rps，并发 25 以上延迟上升但不报错；扩容方向是多实例 + nginx，而不是改业务代码。

## 9. 验证清单

- 旧库启动：补列、`themes` seed、登录/报告/导入导出/媒体无回归。
- 接口：`/api/report` 含 backgrounds/music/theme；主题 CRUD、默认/复制、删除保护；`/themes/fonts` 不被 `:id` 吞；字体上传 magic/8MB/覆盖清理；>8MB 413。
- 数据链路：赋主题 → 编辑 → 文本导入 → Excel 导入 → 删除后撤销，主题不丢；导出再导入不丢。
- 社员端：7 屏翻页/动画/数字滚动；背景图与暗层；音乐开关与偏好；主题颜色/字体/按页覆盖；音符、光点、柔光、切页光圈；`prefers-reduced-motion` 降级；预览模式无改密/退出。
- 管理端：批量操作与撤销、批量媒体、按文件名归属、外观编辑与真实预览、提示/对话框样式。
- 移动端手测：iPhone/Android 字体加载无跳动、自动播放被拦、动画帧率正常。
