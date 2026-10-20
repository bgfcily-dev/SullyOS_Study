# SullyOS Cloudflare 个人记忆同步

这个 Worker 替代 Supabase 的记忆存储接口，供 SullyOS 原版和 Lite 共用。它使用：

- **D1**：保存记忆正文、元数据、可恢复到本地的向量副本，以及最近 30 条跨设备语境。
- **Vectorize**：执行向量相似度检索。
- **SYNC_TOKEN**：保护整套私人接口。不要把这个密钥写进仓库。

原版仍会把记忆保存在浏览器 IndexedDB 中。开启远程后是本地与云端双写；“接收远程记忆到本机”可以在新设备恢复一份本地副本。完整聊天记录不会上传，只有你手动发布的最近 30 条语境会进入 D1。

## 部署

需要一个 Cloudflare 账号，并在本机安装 Node.js 与 pnpm。以下命令在仓库根目录运行：

```powershell
pnpm dlx wrangler login
pnpm dlx wrangler d1 create sullyos-memory-sync
pnpm dlx wrangler vectorize create sullyos-memory-vectors --dimensions=1024 --metric=cosine
```

把第一条创建命令返回的 `database_id` 填进 `worker/memory-sync/wrangler.toml`，然后设置一个只属于你的长随机密钥：

```powershell
pnpm dlx wrangler secret put SYNC_TOKEN --config worker/memory-sync/wrangler.toml
pnpm dlx wrangler deploy --config worker/memory-sync/wrangler.toml
```

表结构会在第一次成功请求时自动创建，不需要手工执行 SQL。也可以显式初始化：

```powershell
pnpm dlx wrangler d1 execute sullyos-memory-sync --remote --file worker/memory-sync/schema.sql
```

部署结束后，Wrangler 会显示类似 `https://sullyos-memory-sync.<你的子域>.workers.dev` 的地址。

## 在 SullyOS 中填写

进入“记忆宫殿 → 设置 → 云端记忆同步”：

1. “同步服务 URL”填写 Worker 地址，末尾不要加 `/rest/v1`。
2. “访问密钥”填写刚才设置的 `SYNC_TOKEN`。
3. 点“测试连接”，成功后保存。
4. 在旧设备点“只补传云端缺少的向量”；新设备点“接收远程记忆到本机”。

原有 Supabase 地址和 anon key 仍可使用。Cloudflare Worker 模拟的是项目已经使用的那一小部分 PostgREST 接口，所以无需切换数据格式。

## 数据迁移

如果旧浏览器里仍有完整本地记忆，部署后直接点击“只补传云端缺少的向量”即可。它会按 `memory_id` 检查并跳过已有记录，重复执行不会产生重复项。若旧版上传曾出现 D1 已写入而 Vectorize 未索引的半成功数据，可点“全量覆盖修复”重建远端索引。

如果本地数据已经丢失，只能先从仍可访问的 Supabase 拉回本机，再把配置改成 Cloudflare 后重新上传；Worker 无法读取已经失联的 Supabase 项目。

Vectorize 的写入存在短暂的最终一致性。首次批量上传后，D1 中的数据会立即可下载，但向量搜索可能要稍等片刻才全部可见。

## 云端全库浏览（memory_library_search_v1）

`GET /rest/v1/memory_vectors` 支持 `q`（正文或记忆 ID 的字面关键词，最多 200 字）、已有的角色/metadata 分类筛选、排序、`limit` 和 `offset`。`Content-Range` 返回当前偏移及筛选后的总数。提供 `select` 时仅返回指定字段，浏览正文可省去向量；未提供时仍返回完整记录，兼容旧客户端恢复数据。创建时间及分类索引在兼容升级 metadata 列后建立，不改旧正文或向量。

Cookie 的云端记忆库默认浏览所有角色、所有设备的记录，每页 50 条；搜索和翻页均只读取当前页，不调用 LLM、不自动分类旧记录。未分类记录仍可浏览；原版记忆与身份记录暂只读，Cookie 上传的普通记忆保留已有手动编辑/删除入口。

## 新记忆结构的 metadata（memory_metadata_v1）

同一个库继续保存旧字段，新增可选 JSON 对象 `metadata`，用于逐步引入事实、认知和身份记录。旧记录读取时返回 `{}`，不自动分类、不改正文、不重建向量。现有数据库在首次认证请求时自动补充 `metadata_json` 列；`schema.sql` 只负责新建，单独执行 CREATE 不会升级已有表。

建议内容：

```json
{
  "kind": "reflection",
  "event_id": "evt_123",
  "previous_id": "ref_001",
  "status": "active",
  "confidence": 0.45
}
```

- `kind` 建议使用 `event`、`reflection`、`identity`；事件可用 `current_reflection_id` 指向当前认知。允许其他 JSON 字段，整个对象上限 16 KiB（UTF-8）。
- POST 单条或批量上传可带 `metadata`；省略时保留云端原值，保证旧客户端上传不会清空新字段。明确传对象时**整体替换**，`{}` 清空，`null`/数组/字符串返回 400。新客户端更新前应保留需要继续使用的字段。
- PATCH 可只传 `metadata`，不需要向量、不调用 Vectorize。其他旧字段 PATCH 不影响 metadata。
- GET、POST/PATCH 的 `return=representation` 和向量召回结果均返回 metadata。
- 列表/计数支持 `metadata.kind=eq.reflection`、`metadata.event_id=eq.evt_123`，可与 `char_id=eq.<角色ID>` 组合；还支持 `previous_id`、`current_reflection_id`、`status`。`metadata.kind=is.null` 可定位尚未分类的旧记录。未知 metadata 筛选字段或操作符返回 400，避免误操作整库。
- `/health` 的 `capabilities` 包含 `memory_metadata_v1`。

普通向量匹配排除归档、总结和非 active 状态。前端再按明确的当前感想指针加载有效状态，身份按话题过滤。身份等无向量记录的独立新增入口尚未提供，POST 仍要求向量。

## 修改提案与用户确认（confirmed_memory_changes_v1）

三个新端点沿用同一访问密钥和角色 ID：

- `GET /memory/change-proposals?char_id=...&status=pending&offset=0`，每页最多 50 条，返回 `proposals` 和筛选后 `total`；也支持 approved/rejected 历史。
- `POST /memory/change-proposals`：`char_id,target_id,action,content,reason,evidence,base:{content,metadata},sources:[{role,content}]`，可选 confidence/mood。action 为 correct_fact 或 revise_reflection；校验本轮原句、目标角色及有效记录。新增仅保存提案，不改正文、不调用 Vectorize。
- `POST /memory/change-proposals/:id/reject`：`{char_id}`，只标记忽略。
- `POST /memory/change-proposals/:id/approve`：`{char_id,confirmed:true,vector,model}`，要求匹配原记忆的向量模型和维度。事实原 ID 纠正，感想追加历史并切换指针；完整版本校验与原子提交避免覆盖并发变化。已确认的同一提案重试不重复追加。

提案的原记录、来源、修改内容和决策保存在 D1 `memory_change_proposals`；页面加载不下载原向量。修正后的 `metadata.review_revision` 防止旧客户端普通上传/PATCH 再覆盖正文、分类及当前感想状态。用户自己的服务访问密钥是权限边界，`confirmed:true` 是客户端明确操作约定，不是对持有密钥的程序做身份认证。

新增表在认证请求时兼容创建，不改已有记忆。事件盒恢复策略需要单独写入 policy 行才执行，本次确认流程不会启用恢复、批量删盒或删除旧总结。

验证：`pnpm vitest run worker/memory-sync/src/index.test.ts worker/memory-sync/src/metadata.test.ts`。metadata 集成测试使用 Node 22.13+ 的内置 SQLite，覆盖旧表升级、旧客户端保留新字段、读取/筛选和非法输入。

事件日期查询：GET /rest/v1/memory_vectors?char_id=eq.ID&event_date=2026-10-20&archived=eq.false。event_date 支持年/月/日精度，优先 metadata.event_date，兼容正文开头的规范 [日期] 换行；不使用 created_at。前端更新后须部署新版 Worker。
