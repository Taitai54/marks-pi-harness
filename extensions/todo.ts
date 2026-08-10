import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Todo { text: string; status: "pending" | "in_progress" | "done"; }
let todos: Todo[] = [];

const MARK = { pending: "[ ]", in_progress: "[~]", done: "[x]" } as const;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo_write",
    label: "Todo list",
    description:
      "Replace the task todo list. Use for any task with 3+ steps: write the plan first, " +
      "mark exactly one item in_progress, update immediately after finishing each step. " +
      "Passing an empty list clears it.",
    parameters: Type.Object({
      todos: Type.Array(Type.Object({
        text: Type.String(),
        status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]),
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      todos = params.todos;
      ctx.ui.setWidget("todo", todos.length ? todos.map((t) => `${MARK[t.status]} ${t.text}`) : []);
      const open = todos.filter((t) => t.status !== "done").length;
      return {
        content: [{ type: "text", text: todos.length ? `Todo list updated (${open} open of ${todos.length}).` : "Todo list cleared." }],
        details: {},
      };
    },
  });

  // nudge the model if it goes quiet on an open list
  pi.on("agent_settled", async (_event, ctx) => {
    const open = todos.filter((t) => t.status !== "done");
    if (open.length) ctx.ui.setStatus("todo", `${todos.length - open.length}/${todos.length} done`);
    else ctx.ui.setStatus("todo", "");
  });

  pi.on("session_start", async () => { todos = []; });
}
