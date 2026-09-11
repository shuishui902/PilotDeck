# Hackathon 插件

阶段二起，所有新能力都以**插件**形态交付，不改内核。这里的目录就是插件本体：
把某个子目录整个复制（或软链）到 `~/.pilotdeck/plugins/` 即完成安装，重启/刷新后生效。

```bash
cp -r hackathon/plugins/intercom ~/.pilotdeck/plugins/
```

| 插件 | 阶段 | 说明 |
|------|------|------|
| `hello/` | 一 | 阶段一验收插件：注册 `hello_sessions` 工具并调用 `api.listSessions()` |
| `intercom/` | 二 | 跨会话协作：`session_list` / `session_send`，仅挂 General 会话（cwd = pilot home），回执随工具结果回流 |

## 插件形态（插件即代码）

`plugin.json` 里多一个 `entry` 字段即是代码插件；没有则保持声明式（向后兼容）：

```json
{ "name": "intercom", "entry": "index.js" }
```

`index.js` 默认导出一个工厂函数，拿到 `PilotDeckExtensionAPI`：

```js
export default function (api) {
  api.registerTool({ name: "session_send", /* ... */ });
  api.onHook("PostToolUse", async (event) => { /* ... */ });
  // 运行期动作（全部代理 Gateway）：api.listSessions / submitTurn / steerTurn
  // 自报状态（activity 视图用）：api.emitStatus(sessionKey, "doing" | "needs_human" | "done")
}
```
