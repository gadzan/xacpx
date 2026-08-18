export function renderAgentMessageEnvelope(input: {
  id: string;
  from: string;
  replyable: boolean;
  replyTo?: string;
  content: string;
}): string {
  const attributePairs: Array<[string, string]> = [
    ["id", input.id],
    ["from", input.from],
    ["replyable", String(input.replyable)],
    ...(input.replyTo ? [["reply-to", input.replyTo] as [string, string]] : []),
  ];
  const attributes = attributePairs
    .map(([name, value]) => name + '="' + escapeXml(value) + '"')
    .join(" ");

  return (
    "<xacpx-message " +
    attributes +
    ">\n" +
    escapeXml(input.content) +
    "\n</xacpx-message>"
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
