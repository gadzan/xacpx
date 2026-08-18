import { expect, test } from "bun:test";

import { renderAgentMessageEnvelope } from "../../../src/orchestration/agent-message-envelope";

test("renders an escaped peer message envelope with reply metadata", () => {
  expect(
    renderAgentMessageEnvelope({
      id: "msg_1",
      from: "agent:node_a:endpoint_a",
      replyable: true,
      replyTo: "msg_0",
      content: "Use <new> & keep </xacpx-message> literal.",
    }),
  ).toBe(
    '<xacpx-message id="msg_1" from="agent:node_a:endpoint_a" replyable="true" reply-to="msg_0">\n' +
      "Use &lt;new&gt; &amp; keep &lt;/xacpx-message&gt; literal.\n" +
      "</xacpx-message>",
  );
});

test("omits reply-to when absent and marks one-way senders as not replyable", () => {
  expect(
    renderAgentMessageEnvelope({
      id: "msg_1",
      from: "agent:node_a:endpoint_a",
      replyable: false,
      content: "hello",
    }),
  ).toBe(
    '<xacpx-message id="msg_1" from="agent:node_a:endpoint_a" replyable="false">\nhello\n</xacpx-message>',
  );
});
