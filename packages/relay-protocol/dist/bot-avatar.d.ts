export declare const BOT_AVATAR_SHAPES: readonly ["cercle", "galet", "squircle", "capsule", "triangle", "hexagone", "nuage", "goutte"];
export declare const BOT_AVATAR_COLORS: readonly ["encre", "brun", "rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose", "gris", "creme"];
export declare const BOT_AVATAR_EXPRESSIONS: readonly ["neutre", "attentif", "surpris", "excite", "heureux", "hilare", "colere", "triste", "effraye", "mefiant", "confus", "curieux", "fier", "timide", "blase", "somnolent"];
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
export declare function isBotAvatarConfig(value: unknown): value is BotAvatarConfig;
export declare function isBotAvatarWriteConfig(value: unknown): value is BotAvatarConfig;
export declare function copyBotAvatar(avatar: BotAvatarConfig | undefined): BotAvatarConfig | undefined;
export declare function parseStoredBotAvatar(value: unknown): BotAvatarConfig | undefined | null;
export declare function sameBotAvatar(a: BotAvatarConfig | undefined, b: BotAvatarConfig | undefined): boolean;
