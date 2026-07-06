import path from "node:path";
import type { WeixinApiOptions } from "../api/api.js";
import { weixinLog } from "../util/weixin-log";
import { getMimeFromFilename } from "../media/mime.js";
import { sendFileMessageWeixin, sendImageMessageWeixin, sendVideoMessageWeixin } from "./send.js";
import { uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "../cdn/upload.js";
import type { OutboundChannelMedia } from "../../channels/media-types.js";

/**
 * Upload a local file and send it as a weixin message, routing by MIME type:
 *   video/*  → uploadVideoToWeixin        + sendVideoMessageWeixin
 *   image/*  → uploadFileToWeixin         + sendImageMessageWeixin
 *   else     → uploadFileAttachmentToWeixin + sendFileMessageWeixin
 *
 * Used by both the auto-reply deliver path (monitor.ts) and the outbound
 * sendMedia path (channel.ts) so they stay in sync.
 */
export async function sendWeixinMediaFile(params: {
  media?: OutboundChannelMedia;
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { media, filePath, to, text, opts, cdnBaseUrl } = params;
  const mime = media?.mimeType ?? getMimeFromFilename(filePath);
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };

  if (mime.startsWith("video/")) {
    weixinLog.info("weixin.send.video_upload_start", "sendWeixinMediaFile: uploading video", {
      filePath,
      to,
    });
    const uploaded = await uploadVideoToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    weixinLog.info("weixin.send.video_upload_done", "sendWeixinMediaFile: video upload done", {
      filekey: uploaded.filekey,
      size: uploaded.fileSize,
    });
    return sendVideoMessageWeixin({ to, text, uploaded, opts });
  }

  if (mime.startsWith("image/")) {
    weixinLog.info("weixin.send.image_upload_start", "sendWeixinMediaFile: uploading image", {
      filePath,
      to,
    });
    const uploaded = await uploadFileToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    weixinLog.info("weixin.send.image_upload_done", "sendWeixinMediaFile: image upload done", {
      filekey: uploaded.filekey,
      size: uploaded.fileSize,
    });
    return sendImageMessageWeixin({ to, text, uploaded, opts });
  }

  // File attachment: pdf, doc, zip, etc.
  const fileName = media?.fileName ?? path.basename(filePath);
  weixinLog.info(
    "weixin.send.file_upload_start",
    "sendWeixinMediaFile: uploading file attachment",
    { filePath, fileName, to },
  );
  const uploaded = await uploadFileAttachmentToWeixin({
    filePath,
    fileName,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
  });
  weixinLog.info("weixin.send.file_upload_done", "sendWeixinMediaFile: file upload done", {
    filekey: uploaded.filekey,
    size: uploaded.fileSize,
  });
  return sendFileMessageWeixin({ to, text, fileName, uploaded, opts });
}
