# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队与保护区巡护队的纯前端单页应用：普查队按站位布设样带，逐条记录底质、珊瑚分类覆盖与鱼类计数并评定白化等级；巡护队管作业报备单、批准站位与禁入期。两边数据**各持一个 IndexedDB**，录完样带按站位编号 + 调查日期对账：没批准或落在禁入期的样带挂起（数据照录但不进对外白化汇总），补报通过或撤销禁入期后自动重判放行。数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore` / `patrolStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB） | 普查库 `gbcoralbelt` v3 + 巡护库 `gbcoralpatrol` v1，含 upgrade 迁移 / 历史报备回填 / liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord | 新建/编辑/删除礁区，按保护区状态与面积分档筛选，卡片汇总站位数、样带数与本礁区平均白化指数 |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验（纬度 ±90、经度 ±180）并显示度分秒，按水深区间筛选，展开样带 |
| `/sites/:id/belts` | 样带布设 | Belt、Site、CoralRecord、FishCount | 布设样带（编号、长度、朝向、调查日期、调查人），回显已录记录数、覆盖率与白化指数，朝向排序校验 |
| `/belts/:id/corals` | 底质与珊瑚分类计数 | CoralRecord、Belt | 按属名与形态逐条录入覆盖长度与白化等级，汇总覆盖率、白化指数、白化占比与等级分布，批量粘贴、批量改级 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt | 按科名与体长段录入数量，按类别筛选与批量改类别，按科名和体长段汇总并折算密度（尾/100 m²） |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 | 白化等级分布与按样带/按礁区汇总（**对外口径仅放行样带**，可切内部核对含挂起）、结构版本查看、全量 JSON 导入导出、全量对账、清空重建 |
| `/patrol/filings` | 巡护队 · 作业报备与批准站位 | Filing、ReconcileLedgerEntry、ReconcileOutboxTask | 登记报备 / 补报、核对待核（升级回填）报备、批准 / 拒绝（批准即自动重判挂起样带）、批准站位列表、巡护台账留底与单侧重试队列 |
| `/patrol/closures` | 巡护队 · 禁入期管理 | Closure | 发布 / 撤销禁入期（支持全礁区或指定站位、日期区间）；撤销后先前挂起样带自动重新判定 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开两库、回填 / 播种 / 首次对账
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚两库数据概览
        ├── env.d.ts
        ├── types/              # reef / site / belt / coralRecord / fishCount / filter / filing（报备）/ closure（禁入期）/ clearance（对账放行）
        ├── stores/             # reefStore / beltStore / surveyStore / patrolStore（巡护队）
        ├── components/common/  # BleachTag / ClearanceTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCoverage
        ├── pages/              # ReefList / SiteList / BeltBoard / CoralEntry / FishEntry / CoverageView / PatrolFilings / PatrolClosures
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── scripts/            # 对账规则冒烟测试（npm run test:smoke）
        ├── styles/main.css
        └── utils/              # bleach.ts（白化算法）/ id.ts（主键）/ db.ts（普查库 v3）/ patrolDb.ts（巡护库 v1）/ patrolSeed.ts（巡护演示数据）/ clearance.ts（对账判定纯逻辑）/ reconcile.ts（对账编排 / 历史回填 / 单侧重试）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev         # http://localhost:22813
npm run build       # 类型检查 + 生产构建
npm run test:smoke  # 对账判定纯逻辑 + fake-indexeddb 对账编排冒烟测试（35 条断言）
npm run preview     # 预览构建产物
```

## 六、数据存储与两队对账说明

- **两队各持一库（互不同步表结构）**：
  - 普查队库 `gbcoralbelt`（`utils/db.ts`，结构版本 `v3`）：`reefs` / `sites` / `belts` / `corals` / `fishes`，样带行内带对账结论 `clearance`（挂起 / 放行、原因、命中报备或禁入单号、对账时间与说明）。
  - 巡护队库 `gbcoralpatrol`（`utils/patrolDb.ts`，结构版本 `v1`）：`filings`（作业报备单）、`closures`（禁入期）、`reconcileLedger`（普查队同步过来的对账台账留底）、`outbox`（台账写失败的重试任务）。
- **对账规则**（`utils/clearance.ts` 纯判定 + `utils/reconcile.ts` 编排，按「礁区名 + 站位编号 + 调查日期」匹配，不同礁区重号站位不串批）：
  1. 调查日期落在生效禁入期（全礁区或指定站位、含起止日）→ 挂起 `closed`；
  2. 无报备记录 → 挂起 `unfiled`，等补报；
  3. 报备待核（历史回填）→ 挂起 `verifying`，等巡护核对；
  4. 报备被拒绝 → 挂起 `rejected`；
  5. 报备已批准且不在禁入期 → 放行。
  挂起样带的底质、覆盖长度等照样记录，但**不进对外白化 / 覆盖度 / 礁区结论**（内部核对时可在 `/coverage` 显式纳入）；补报批准或撤销禁入期后自动重判，符合条件立即放行。
- **对账时机**：布设 / 改期样带后按站位自动重判；样带布设页可手动「与巡护队对账」；报备批准、撤销禁入期由巡护页动作触发受影响样带重判；`/coverage` 提供全量对账；导入备份后自动全量重判。
- **单侧重试**：对账时普查侧判定先落库（权威结论，不回滚）；巡护台账 `put` 失败只把该条写入巡护库 `outbox`，巡护页可「重试同步」，全程不触碰普查库。页内提供「台账写入故障」注入开关用于演示该路径。
- **升级迁移与旧数据回填**：`db.version(3)` 为样带补 `clearance` 索引，v2→v3 升级时先把存量样带标成挂起待核并打 localStorage 标记；启动时 `backfillLegacyFilings()` 按每条样带的调查日期（礁区 + 站位 + 日期去重）向巡护库回填一版报备单，`source=legacy_backfill`、`status=verifying`（待核），随后全量重判。回填幂等。
- **首屏播种**：普查库为空时播种演示数据（3 个礁区 / 4 个站位 / 5 条样带 / 14 条珊瑚记录 / 12 条计数记录）；巡护库首次打开播种演示报备（含已批准、待核回填）与禁入期（含一条当天已撤销、一条次日生效），随后全量对账，开箱可见放行 / 无报备挂起 / 待核等状态。
- **实时同步**：`watchTable()` / `watchPatrolTable()` 基于 Dexie `liveQuery` 订阅两库表变化，Pinia store 自动刷新。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%；白化指数 = 按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4）；鱼类密度 = 计数 /（样带长度 × 1 m）× 100（尾/100 m²）。
- **备份与恢复**：`/coverage` 导出普查库五张表（含样带 `clearance`）的 JSON 快照，支持覆盖 / 追加导入并在导入后自动对账；「清空并重建演示数据」会把巡护库一并重置并重判。巡护库另有独立本地库，不随普查快照导出。
- **离线可用**：纯静态资源，无任何网络请求；两个库都只在当前浏览器，需分别备份 / 迁移。
- **测试**：`npm run test:smoke` 运行 13 条判定纯逻辑断言 + 22 条 `fake-indexeddb` 对账编排断言（挂起 / 放行、补报、禁入期撤销重判、单侧重试、历史回填幂等等）。
