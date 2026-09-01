import type { DiscordTableMode } from "./types.js";

const TABLE_ROW_RE = /^\|.*\|$/;

function isTableBlock(lines: string[], start: number): { end: number } | null {
  if (!TABLE_ROW_RE.test(lines[start]!.trim())) return null;
  let end = start;
  while (end + 1 < lines.length && TABLE_ROW_RE.test(lines[end + 1]!.trim())) {
    end++;
  }
  if (end - start < 1) return null;
  return { end };
}

function tableToCodeBlock(rows: string[]): string {
  const content = rows.join("\n");
  return "```\n" + content + "\n```";
}

function tableToBullets(rows: string[]): string {
  if (rows.length === 0) return "";
  const parseRow = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const headers = parseRow(rows[0]!);
  let dataStart = 1;
  if (rows.length > 1 && /^[\s|:-]+$/.test(rows[1]!)) dataStart = 2;
  const lines: string[] = [];
  for (let i = dataStart; i < rows.length; i++) {
    const cells = parseRow(rows[i]!);
    const parts: string[] = [];
    for (let c = 0; c < Math.min(headers.length, cells.length); c++) {
      const h = headers[c]!;
      const v = cells[c]!;
      if (!h && !v) continue;
      if (h) parts.push(`${h}: ${v}`);
      else parts.push(v);
    }
    if (parts.length === 0) lines.push(`- ${cells.join(" \u00b7 ")}`);
    else lines.push(`- ${parts.join(" \u00b7 ")}`);
  }
  return lines.join("\n");
}

function downgradeH1(line: string): string {
  return line.replace(/^# (.*)$/, "## $1");
}

export function renderDiscordMarkdown(text: string, tableMode: DiscordTableMode): string {
  try {
    if (!text) return text;
    if (tableMode === "off") {
      const lines = text.split("\n");
      const out: string[] = [];
      let inFence = false;
      for (const line of lines) {
        if (line.trimStart().startsWith("```")) {
          inFence = !inFence;
          out.push(line);
          continue;
        }
        if (inFence) out.push(line);
        else out.push(downgradeH1(line));
      }
      return out.join("\n");
    }
    const lines = text.split("\n");
    const out: string[] = [];
    let i = 0;
    let inFence = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        out.push(line);
        i++;
        continue;
      }
      if (inFence) {
        out.push(line);
        i++;
        continue;
      }
      const block = isTableBlock(lines, i);
      if (block) {
        const rows = lines.slice(i, block.end + 1);
        let converted: string;
        if (tableMode === "code") converted = tableToCodeBlock(rows);
        else converted = tableToBullets(rows);
        out.push(converted);
        i = block.end + 1;
        continue;
      }
      out.push(downgradeH1(line));
      i++;
    }
    return out.join("\n");
  } catch {
    return text;
  }
}
