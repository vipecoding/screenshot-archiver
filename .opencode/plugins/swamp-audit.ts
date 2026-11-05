// Swamp audit plugin for OpenCode
// Records shell tool invocations for the swamp audit timeline.
// Supports OpenCode 1.3.4 or later and OpenCode 2.
// This is a managed file — it will be overwritten on swamp upgrade.

import type { Plugin } from "@opencode-ai/plugin";

const pendingCommands = new Map();

async function record(command, cwd, sessionID) {
  try {
    const payload = JSON.stringify({
      tool_name: "bash",
      tool_input: { command },
      cwd,
      session_id: sessionID,
    });
    const proc = Bun.spawn(
      ["swamp", "audit", "record", "--from-hook", "--tool", "opencode"],
      { stdin: new Blob([payload]) },
    );
    await proc.exited;
  } catch {
    // Must never throw — this is a hook
  }
}

// OpenCode 1
export const SwampAudit: Plugin = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      const command = output.args?.command;
      if (command && input.sessionID) {
        pendingCommands.set(input.sessionID, command);
      }
    },
    "tool.execute.after": async (input) => {
      if (input.tool !== "bash") return;
      const command = pendingCommands.get(input.sessionID);
      pendingCommands.delete(input.sessionID);
      if (!command) return;
      await record(command, directory, input.sessionID);
    },
  };
};

export default {
  id: "swamp.audit",
  // OpenCode 1.3.4+
  server: SwampAudit,
  // OpenCode 2, which names the tool "shell"
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "shell" && event.tool !== "bash") return;
      const command = event.input?.command;
      if (typeof command !== "string" || !command) return;
      await record(command, ctx.location.directory, event.sessionID);
    });
  },
};
