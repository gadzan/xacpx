export const BOT_AVATAR_SHAPES = ["cercle", "galet", "squircle", "capsule", "triangle", "hexagone", "nuage", "goutte"] as const;
export const BOT_AVATAR_COLORS = ["encre", "brun", "rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose", "gris", "creme"] as const;
export const BOT_AVATAR_EXPRESSIONS = ["neutre", "attentif", "surpris", "excite", "heureux", "hilare", "colere", "triste", "effraye", "mefiant", "confus", "curieux", "fier", "timide", "blase", "somnolent"] as const;

export type ShapeId = typeof BOT_AVATAR_SHAPES[number];
export type ColorId = typeof BOT_AVATAR_COLORS[number];
export type ExpressionId = typeof BOT_AVATAR_EXPRESSIONS[number];

export interface CharacterAvatarConfig {
  version: 1;
  kind: "character";
  shape: ShapeId;
  color: ColorId;
  expression: ExpressionId;
  motion: "auto" | "off";
}

export interface TextAvatarConfig {
  version: 1;
  kind: "text";
  value: string;
}

export type BotAvatarConfig = CharacterAvatarConfig | TextAvatarConfig;

export function isBotAvatarConfig(value: unknown): value is BotAvatarConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const avatar = value as Record<string, unknown>;
  if (avatar.version !== 1) return false;
  if (avatar.kind === "text") {
    return Object.keys(avatar).length === 3 && typeof avatar.value === "string"
      && avatar.value.trim().length > 0;
  }
  return avatar.kind === "character" && Object.keys(avatar).length === 6
    && BOT_AVATAR_SHAPES.some((id) => id === avatar.shape)
    && BOT_AVATAR_COLORS.some((id) => id === avatar.color)
    && BOT_AVATAR_EXPRESSIONS.some((id) => id === avatar.expression)
    && (avatar.motion === "auto" || avatar.motion === "off");
}

export function isBotAvatarWriteConfig(value: unknown): value is BotAvatarConfig {
  return isBotAvatarConfig(value) && (value.kind === "character" || value.value.length <= 512);
}

export function copyBotAvatar(avatar: BotAvatarConfig | undefined): BotAvatarConfig | undefined {
  if (!avatar) return undefined;
  return avatar.kind === "text"
    ? { version: 1, kind: "text", value: avatar.value }
    : { version: 1, kind: "character", shape: avatar.shape, color: avatar.color, expression: avatar.expression, motion: avatar.motion };
}

// null denotes malformed data; undefined denotes an absent historical avatar.
export function parseStoredBotAvatar(value: unknown): BotAvatarConfig | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    return { version: 1, kind: "text", value };
  }
  return isBotAvatarConfig(value) ? copyBotAvatar(value) : null;
}

export function sameBotAvatar(a: BotAvatarConfig | undefined, b: BotAvatarConfig | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "text") return b.kind === "text" && a.value === b.value;
  return b.kind === "character" && a.shape === b.shape && a.color === b.color
    && a.expression === b.expression && a.motion === b.motion;
}
