# ShelfPass 本地运行说明

> 本文件由本地适配时生成，仓库原有的 `README.md` 未改动。

## 访问地址

| 服务 | 地址 |
|---|---|
| 应用 | http://localhost:3005 |
| 演示账号 | `demo@local.test` / `demo123456` |
| 数据库 | SQLite 文件 `prisma/dev.db` |

## 启动

```bash
cd "D:/AI commerce/nono"
npm run dev -- --port 3005
```

首次在新机器上还需要：

```bash
npm install
npx prisma generate
npx prisma db push
```

## 为什么用 3005 而不是 3000

本机 3000 端口被 Grafana 占用（PID 9208），未终止该进程。`.env` 里的 `AUTH_URL` 已同步改为 `http://localhost:3005`。

## 本地配置改动（仅 `.env`，未改任何业务代码）

```
DATABASE_URL="file:./prisma/dev.db"     # 原为 Turso，改本地 SQLite
AUTH_SECRET=<随机生成>
AUTH_URL="http://localhost:3005"
DEEPSEEK_API_KEY=<复用 ecom-agent 的 DeepSeek key>
ADMIN_EMAILS="admin@local.test"          # 管理员账号不限额度
MONTHLY_QUOTA=200                        # 默认 50，本地调高
```

模型 key 的解析顺序是 `User.apiKey -> process.env.DEEPSEEK_API_KEY`，所以不填环境变量也能在「个人设置」里逐用户填 key。

## 已验证可用的功能

- 注册 / 登录（NextAuth v5 JWT）
- 新建项目 → AI 生成标题 / 五点描述（真实调用 `deepseek-chat`，非模板）
- Listing 质量检查（纯前端规则引擎）
- 导出中心（文案导出，服务端 `/api/generate/export?type=copy`）
- 平台格式导出（Amazon Flat File TSV / Shopify CSV，纯前端 Blob 下载）

## 已知问题（实测）

1. **登录页有 CSRF 竞态**：`csrfToken` 在 `useEffect` 里异步获取，加载后立刻提交会返回 `?error=MissingCSRF`。等输入框可用后再点登录即可。
2. **规则引擎只覆盖 3 个平台**：`src/lib/listing-checker.ts` 的 `PLATFORM_RULES` 只有 amazon / shopify / tiktok，其余走 `_default`（标题 30–200）。而 API 允许 7 个平台。**全仓库没有任何 Mercado Livre / Shopee 相关代码。**
3. **要点数量只判少不判多**：`checkBulletPoints` 用 `points.length < expectedCount` 才警告，实测生成 9 条要点被判「通过」，而 Amazon 上限是 5 条。
4. **规则不参与生成**：违禁词只在生成后检测（实测抓出 `100%`、`perfect`），prompt 里没有注入禁用词约束，所以模型会先违规再由检查器扣分。
5. **AI 失败静默降级**：`/api/generate` 调用失败时 `catch` 里直接返回模板文案 `sampleContents`，HTTP 仍是 200，前端无法区分"真 AI"与"模板"。
6. **页面有 React hydration 报错**（`<a>` 嵌套 `<a>`、Base UI 按钮告警），页面左下角显示 5 Issues。
7. **导出中心卡片重复**：「文案导出」「数据表格」各出现两次。

## 目录速查

```
src/app/dashboard/          25 个页面（项目/文案/图片/批量/竞品/质量/税务/导出/模板）
src/lib/listing-checker.ts  规则引擎，484 行，7 个检查函数
src/lib/platform-export.ts  平台格式导出，277 行，纯前端
src/lib/competitor-analysis.ts  竞品分析规则，276 行
src/app/api/generate/route.ts   生成接口，409 行（prompt 组装在这里）
prisma/schema.prisma        9 张表（User / Project / GenerationRecord / AnalysisRecord / InviteCode…）
```
