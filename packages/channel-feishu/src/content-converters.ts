import type { FeishuMessageEvent, FeishuResourceDescriptor, FeishuContentConversionResult } from "./types";

interface ConvertInput {
  messageType: string;
  content: string;
  messageId: string;
  mentions?: FeishuMessageEvent["message"]["mentions"];
  botOpenId?: string;
  stripBotMentions?: boolean;
}

export function hasFeishuInboundMedia(messageType: string, content: string): boolean {
  if (messageType === "text") return false;
  if (messageType !== "post") return true;
  const parsed = safeParse(content);
  if (!parsed || typeof parsed !== "object") return true;
  const hasMedia = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasMedia);
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return ["img", "image", "media", "file", "audio", "video"].includes(String(item.tag))
      || "image_key" in item || "file_key" in item || Object.values(item).some(hasMedia);
  };
  return hasMedia(parsed);
}

export async function convertFeishuMessageContent(input: ConvertInput): Promise<FeishuContentConversionResult> {
  const resources: FeishuResourceDescriptor[] = [];
  const skippedNotes: string[] = [];
  let text = "";

  switch (input.messageType) {
    case "text":
      text = parseText(input.content);
      break;
    case "image": {
      const key = readString(input.content, "image_key");
      if (key) {
        text = `![image](${key})`;
        resources.push({ kind: "image", fileKey: key });
      } else {
        text = "[image]";
        skippedNotes.push("Feishu image message did not include image_key.");
      }
      break;
    }
    case "file":
      text = convertFileLike(input.content, "file", resources, skippedNotes);
      break;
    case "audio":
      text = convertFileLike(input.content, "audio", resources, skippedNotes);
      break;
    case "video":
    case "media":
      text = convertFileLike(input.content, "video", resources, skippedNotes);
      break;
    case "post":
      text = convertPost(input.content, resources);
      break;
    default:
      text = `[unsupported Feishu message type: ${input.messageType}]`;
      skippedNotes.push(`Unsupported Feishu message type: ${input.messageType}`);
  }

  text = resolveMentions(text, input.mentions ?? [], input.botOpenId, Boolean(input.stripBotMentions)).trim();
  return { text, resources, skippedNotes };
}

function parseText(raw: string): string {
  const parsed = safeParse(raw) as { text?: string } | undefined;
  return parsed?.text ?? raw;
}

function convertFileLike(
  raw: string,
  kind: "file" | "audio" | "video",
  resources: FeishuResourceDescriptor[],
  skippedNotes: string[],
): string {
  const parsed = safeParse(raw) as { file_key?: string; file_name?: string } | undefined;
  if (!parsed?.file_key) {
    skippedNotes.push(`Feishu ${kind} message did not include file_key.`);
    return `[${kind}]`;
  }
  resources.push({ kind, fileKey: parsed.file_key, ...(parsed.file_name ? { fileName: parsed.file_name } : {}) });
  return kind === "file"
    ? `<file key="${parsed.file_key}"${parsed.file_name ? ` name="${parsed.file_name}"` : ""}/>`
    : `<${kind} key="${parsed.file_key}"/>`;
}

function convertPost(raw: string, resources: FeishuResourceDescriptor[]): string {
  const parsed = unwrapPost(safeParse(raw));
  if (!parsed) return "[rich text message]";
  const lines: string[] = [];
  if (parsed.title) lines.push(`**${parsed.title}**`, "");
  for (const paragraph of parsed.content ?? []) {
    if (!Array.isArray(paragraph)) continue;
    lines.push(paragraph.map((element) => renderPostElement(element, resources)).join(""));
  }
  return lines.join("\n").trim() || "[rich text message]";
}

function renderPostElement(element: Record<string, unknown>, resources: FeishuResourceDescriptor[]): string {
  const tag = String(element.tag ?? "");
  if (tag === "text") return String(element.text ?? "");
  if (tag === "a") return element.href ? `[${String(element.text ?? element.href)}](${String(element.href)})` : String(element.text ?? "");
  if (tag === "at") return element.user_name ? `@${String(element.user_name)}` : "";
  if (tag === "img" && typeof element.image_key === "string") {
    resources.push({ kind: "image", fileKey: element.image_key });
    return `![image](${element.image_key})`;
  }
  if (tag === "media" && typeof element.file_key === "string") {
    resources.push({ kind: "file", fileKey: element.file_key });
    return `<file key="${element.file_key}"/>`;
  }
  if (tag === "code_block") return `\n\`\`\`${String(element.language ?? "")}\n${String(element.text ?? "")}\n\`\`\`\n`;
  return typeof element.text === "string" ? element.text : "";
}

function unwrapPost(value: unknown): { title?: string; content?: Array<Array<Record<string, unknown>>> } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ("content" in record || "title" in record) return record as never;
  for (const locale of ["zh_cn", "en_us", "ja_jp", ...Object.keys(record)]) {
    const candidate = record[locale];
    if (candidate && typeof candidate === "object") return candidate as never;
  }
  return null;
}

function readString(raw: string, key: string): string | undefined {
  const parsed = safeParse(raw) as Record<string, unknown> | undefined;
  const value = parsed?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

function resolveMentions(
  text: string,
  mentions: NonNullable<FeishuMessageEvent["message"]["mentions"]>,
  botOpenId?: string,
  stripBotMentions = false,
): string {
  let result = text;
  for (const mention of mentions) {
    const openId = mention.id.open_id;
    if (stripBotMentions && botOpenId && openId === botOpenId) {
      result = result.replaceAll(mention.key, "").replaceAll(`@${mention.name}`, "").trim();
    } else {
      result = result.replaceAll(mention.key, `@${mention.name}`);
    }
  }
  return result;
}
