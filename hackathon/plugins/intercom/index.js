import { resolve } from "node:path";

/**
 * intercom — 跨会话协作插件（Hackathon 阶段二）。
 *
 * 全程不改内核：所有能力都经 PilotDeckExtensionAPI 的窄动作接口代理 Gateway。
 * 两个工具只挂 General 会话（cwd === api.generalRoot），项目会话里不可见。
 */
export default function intercom(api) {
  const generalOnly = (context) =>
    resolve(context.cwd) === resolve(api.generalRoot)
      ? { ok: true }
      : {
          ok: false,
          code: "unavailable",
          reason: "intercom tools are only available in the General session.",
        };

  const summarize = (session) => ({
    sessionKey: session.sessionKey ?? session.sessionId,
    title: session.customTitle ?? session.aiTitle ?? session.summary,
    lastModified: session.lastModified,
  });

  api.registerTool({
    name: "session_list",
    description:
      "List sessions of a project so the General session can pick a target to talk to. " +
      "Pass projectKey (project root path); omit it to list General-workspace sessions.",
    kind: "session",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Project root path of the target project." },
        limit: { type: "number", description: "Max sessions to return (default 10)." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: generalOnly,
    async execute(input) {
      const result = await api.listSessions({
        projectKey: input.projectKey,
        limit: input.limit ?? 10,
      });
      const sessions = result.sessions.map(summarize);
      return {
        content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
        data: { sessions },
      };
    },
  });

  api.registerTool({
    name: "session_send",
    description:
      "Send a message to a project session, wait for it to execute, and return its reply " +
      "as a receipt. Omit sessionKey to use the project's most recent session (a new one " +
      "is created when the project has none).",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        projectKey: { type: "string", description: "Project root path of the target project." },
        sessionKey: { type: "string", description: "Target session; defaults to the project's latest session." },
        message: { type: "string", description: "Instruction for the target session to execute." },
        timeoutMs: { type: "number", description: "Hard limit for the remote turn (default 300000)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkAvailability: generalOnly,
    async execute(input) {
      // 1. 定位目标会话：显式 sessionKey > 项目最近会话 > 让 Gateway 新建
      let sessionKey = input.sessionKey;
      if (!sessionKey) {
        const list = await api.listSessions({ projectKey: input.projectKey, limit: 1 });
        sessionKey = list.sessions[0]?.sessionKey ?? list.sessions[0]?.sessionId;
      }
      const target = sessionKey ?? `intercom-${Date.now()}`;
      const targetLabel = `${input.projectKey ?? "general"}/${target}`;

      // 2. 转发指令（submitTurn 的 getOrCreate 会自动恢复/新建会话）
      api.emitStatus(target, "doing", `General → ${targetLabel}`);
      let reply = "";
      let finishReason = "unknown";
      let errorMessage;
      let turns = 0;
      for await (const event of api.submitTurn({
        sessionKey: target,
        projectKey: input.projectKey,
        channelKey: "api_server",
        message: input.message,
        canPrompt: false,
        timeoutMs: input.timeoutMs ?? 300_000,
      })) {
        if (event.type === "turn_started") {
          turns += 1;
        } else if (event.type === "assistant_text_delta") {
          reply += event.text;
        } else if (event.type === "turn_completed") {
          finishReason = String(event.finishReason);
        } else if (event.type === "error") {
          errorMessage = event.message;
          break;
        }
      }

      // 3. 回执回流：状态翻转 + 回复文本带回 General
      const failed = errorMessage !== undefined;
      api.emitStatus(target, failed ? "needs_human" : "done", failed ? errorMessage : `finish=${finishReason}`);

      const receipt = {
        target: targetLabel,
        ok: !failed,
        finishReason,
        turns,
        reply,
        ...(failed ? { error: errorMessage } : {}),
      };
      return {
        content: [
          {
            type: "text",
            text:
              `## 回执 ${failed ? "❌" : "✅"} ${targetLabel}\n\n` +
              (failed ? `执行失败：${errorMessage}` : `完成（finish=${finishReason}）。回复：\n\n${reply}`),
          },
        ],
        data: receipt,
      };
    },
  });
}
