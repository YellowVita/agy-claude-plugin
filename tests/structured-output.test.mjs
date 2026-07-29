import test from "node:test";
import assert from "node:assert/strict";

import { createStreamJsonCollector } from "../plugins/agy/scripts/lib/structured-output.mjs";

test("progress dedupe keys include conversation ID for nested agents", () => {
  const collector = createStreamJsonCollector();
  const events = [
    {
      event: "init",
      conversation_id: "root-conversation",
      init: {}
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "root-conversation",
        step_index: 7,
        state: "DONE",
        step_type: "tool",
        tool_info: { canonical_name: "root_tool", parameters: {}, output: "root" }
      }
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "child-conversation",
        step_index: 7,
        state: "DONE",
        step_type: "tool",
        tool_info: { canonical_name: "child_tool", parameters: {}, output: "child" }
      }
    },
    {
      event: "result",
      result: {
        conversation_id: "root-conversation",
        status: "SUCCESS",
        response: "done"
      }
    }
  ];
  collector.push(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const result = collector.finish();

  assert.equal(result.toolCallCount, 2);
  assert.deepEqual(
    result.recentSteps.map((step) => [step.conversationId, step.stepIndex, step.toolName]),
    [
      ["root-conversation", 7, "root_tool"],
      ["child-conversation", 7, "child_tool"]
    ]
  );
  assert.equal(result.conversationId, "root-conversation");
});
