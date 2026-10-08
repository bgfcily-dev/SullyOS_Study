# 跨设备近期上下文接力

原版聊天的「跨设备接力」与 Lite / Cookie 的「同步近期上下文」使用同一份云端 JSON。云端仅保存最新接力包，不生成回复、不自动写长期记忆。设备名称用于区分来源；内部 revision 仅用于去重，界面显示「已发布来自 设备名」。

SullyOS 可从聊天加号菜单第一页「同步上下文」、顶栏「跨设备接力」，或记忆宫殿云端配置「同步上下文 · 角色总结与预览」进入。生成后切到独立的预览弹窗，取消和确认按钮固定在底部。记忆向量同步仅在接力表为空时初始化角色 ID，已有接力包（包括来源设备和总结）保持原样。

上传时使用当前设备的近期对话生成一段角色第一人称（“我”指角色本人）的迁移总结，包含角色当地年月日时分（未配置时区时跟随设备）、刚才的活动和迁移意图。原版总结的 AI 输入遵守角色可读范围，并通过 ContextBuilder 和角色对话 API；Lite / Cookie 使用当前聊天 API。生成失败不上传。预览弹窗允许编辑或取消，只有确认后才发布快照。

总结随一个 `role: system`、`handoffKind: upload` 的信封保存在 `messages` JSON 中，带 `handoffSummary` 与 `handoffLabel`。接力包最多 30 项，其中 1 项为信封、29 项为对话。这兼容现有 Supabase 与 Worker 的 JSON 存储，无需升级表或重新部署记忆 Worker。解析同时兼容旧行的 `prompt`；没有总结的旧包仍可以接收。

接收按 `sourceDeviceId` 判断，来自当前设备的包不重复导入。接收设备将总结转成一次本地 `system` 消息，正文顺序为「以下消息接收自 A · 接收于 B」、迁移总结、「现在已迁移至 B 继续对话」。界面只显示居中的设备胶囊；模型从正常本地聊天历史读取总结，随上下文范围自然退出，不在每轮重新拉取或额外注入云端包。

Lite / Cookie 将接收消息和设备标签保存到本地，单独保存接收标识以避免旧包在消息窗口滑出后重新导入；刷新或暂时离线仍可继续聊天。原版按云端消息 ID 去重，不再仅接受 `origin: lite`，支持不同原版设备之间接力。上传胶囊不进入模型请求；上传、接收胶囊均排除在记忆语义计数和提取输入之外。

回归检查：`pnpm vitest run utils/recentContextHandoff.test.ts lite/context.test.ts lite/chatApi.test.ts lite/memoryTools.test.ts lite/storage.test.ts utils/chatRequestPayload.test.ts`。Cookie 有独立仓库，协议和前端修改需同步提交并推送两边。
