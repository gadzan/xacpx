export type ChannelId = string;
export type ChannelMediaKind = "image" | "file" | "audio" | "video";

export interface ChannelMediaAttachment {
  kind: ChannelMediaKind;
  type?: string;
  filePath: string;
  mimeType: string;
  fileName?: string;
  sizeBytes: number;
  source: {
    channelId: ChannelId;
    accountId: string;
    chatKey: string;
    messageId: string;
    resourceId?: string;
  };
}

export interface OutboundChannelMedia {
  kind: ChannelMediaKind;
  filePath: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
}

export type MaybeArray<T> = T | T[] | undefined;

export function normalizeMediaArray<T>(media: MaybeArray<T>): T[] {
  if (!media) return [];
  return Array.isArray(media) ? media : [media];
}

export function firstMediaOrUndefined<T>(media: T[]): T | undefined {
  return media.length > 0 ? media[0] : undefined;
}
