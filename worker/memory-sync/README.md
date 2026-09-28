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
4. 在旧设备点“同步本地向量到远程”；新设备点“接收远程记忆到本机”。

原有 Supabase 地址和 anon key 仍可使用。Cloudflare Worker 模拟的是项目已经使用的那一小部分 PostgREST 接口，所以无需切换数据格式。

## 数据迁移

如果旧浏览器里仍有完整本地记忆，部署后直接点击“同步本地向量到远程”即可。这个操作会按 `memory_id` 覆盖写入，重复执行不会产生重复项。

如果本地数据已经丢失，只能先从仍可访问的 Supabase 拉回本机，再把配置改成 Cloudflare 后重新上传；Worker 无法读取已经失联的 Supabase 项目。

Vectorize 的写入存在短暂的最终一致性。首次批量上传后，D1 中的数据会立即可下载，但向量搜索可能要稍等片刻才全部可见。
