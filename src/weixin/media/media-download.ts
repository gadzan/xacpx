import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";
import { weixinLog } from "../util/weixin-log";
import { getMimeFromFilename } from "./mime.js";
import {
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
} from "../cdn/pic-decrypt.js";
import { silkToWav } from "./silk-transcode.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** Persist a buffer via the framework's unified media store. */
type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

/**
 * Download and decrypt media from a single MessageItem.
 * Returns the populated WeixinInboundMediaOpts fields; empty object on unsupported type or failure.
 */
export async function downloadMediaFromItem(
  item: WeixinMessage["item_list"] extends (infer T)[] | undefined ? T : never,
  deps: {
    cdnBaseUrl: string;
    saveMedia: SaveMediaFn;
    log: (msg: string) => void;
    errLog: (msg: string) => void;
    label: string;
  },
): Promise<WeixinInboundMediaOpts> {
  const { cdnBaseUrl, saveMedia, log, errLog, label } = deps;
  const result: WeixinInboundMediaOpts = {};

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return result;
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    weixinLog.debug("weixin.media.image_item", `${label} image`, {
      encryptQueryParamPrefix: (img.media.encrypt_query_param ?? "").slice(0, 40),
      hasAesKey: Boolean(aesKeyBase64),
      aeskeySource: img.aeskey ? "image_item.aeskey" : "media.aes_key",
      hasFullUrl: Boolean(img.media.full_url),
    });
    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            img.media.encrypt_query_param ?? "",
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
            img.media.full_url,
            WEIXIN_MEDIA_MAX_BYTES,
          )
        : await downloadPlainCdnBuffer(
            img.media.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            img.media.full_url,
            WEIXIN_MEDIA_MAX_BYTES,
          );
      const saved = await saveMedia(buf, undefined, "inbound", WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedPicPath = saved.path;
      weixinLog.debug("weixin.media.image_saved", `${label} image saved`, { path: saved.path });
    } catch (err) {
      weixinLog.error("weixin.media.image_failed", `${label} image download/decrypt failed`, {
        err: String(err),
      });
      errLog(`weixin ${label} image download/decrypt failed: ${String(err)}`);
      throw err;
    }
  } else if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key)
      return result;
    try {
      const silkBuf = await downloadAndDecryptBuffer(
        voice.media.encrypt_query_param ?? "",
        voice.media.aes_key,
        cdnBaseUrl,
        `${label} voice`,
        voice.media.full_url,
        WEIXIN_MEDIA_MAX_BYTES,
      );
      weixinLog.debug(
        "weixin.media.voice_decrypted",
        `${label} voice: decrypted, attempting silk transcode`,
        { bytes: silkBuf.length },
      );
      const wavBuf = await silkToWav(silkBuf);
      if (wavBuf) {
        const saved = await saveMedia(wavBuf, "audio/wav", "inbound", WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/wav";
        weixinLog.debug("weixin.media.voice_saved_wav", `${label} voice: saved WAV`, {
          path: saved.path,
        });
      } else {
        const saved = await saveMedia(silkBuf, "audio/silk", "inbound", WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/silk";
        weixinLog.debug(
          "weixin.media.voice_saved_silk",
          `${label} voice: silk transcode unavailable, saved raw SILK`,
          { path: saved.path },
        );
      }
    } catch (err) {
      weixinLog.error("weixin.media.voice_failed", `${label} voice download/transcode failed`, {
        err: String(err),
      });
      errLog(`weixin ${label} voice download/transcode failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key)
      return result;
    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param ?? "",
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
        fileItem.media.full_url,
        WEIXIN_MEDIA_MAX_BYTES,
      );
      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      const saved = await saveMedia(
        buf,
        mime,
        "inbound",
        WEIXIN_MEDIA_MAX_BYTES,
        fileItem.file_name ?? undefined,
      );
      result.decryptedFilePath = saved.path;
      result.fileMediaType = mime;
      weixinLog.debug("weixin.media.file_saved", `${label} file: saved`, {
        path: saved.path,
        mime,
      });
    } catch (err) {
      weixinLog.error("weixin.media.file_failed", `${label} file download failed`, {
        err: String(err),
      });
      errLog(`weixin ${label} file download failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) || !videoItem?.media?.aes_key)
      return result;
    try {
      const buf = await downloadAndDecryptBuffer(
        videoItem.media.encrypt_query_param ?? "",
        videoItem.media.aes_key,
        cdnBaseUrl,
        `${label} video`,
        videoItem.media.full_url,
        WEIXIN_MEDIA_MAX_BYTES,
      );
      const saved = await saveMedia(buf, "video/mp4", "inbound", WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedVideoPath = saved.path;
      weixinLog.debug("weixin.media.video_saved", `${label} video: saved`, { path: saved.path });
    } catch (err) {
      weixinLog.error("weixin.media.video_failed", `${label} video download failed`, {
        err: String(err),
      });
      errLog(`weixin ${label} video download failed: ${String(err)}`);
    }
  }

  return result;
}
