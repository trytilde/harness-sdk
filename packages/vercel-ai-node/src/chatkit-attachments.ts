import { configHeaders } from "@tilde/harness-sdk";
import type { JsonObject } from "@tilde/harness-sdk";
import type { UIMessage } from "ai";
import type {
  ChatKitUiFilePart,
  ConvertToAiSdkFileUploadHandler,
} from "./chatkit-message";
import type { ChatKitEndpointContext } from "./handler";

export type ChatKitAttachmentFilePartHandlerOptions = {
  fetch?: typeof fetch;
};

/** Create a file-part handler that downloads ChatKit attachments for AI SDK models. */
export function createChatKitAttachmentFilePartHandler(
  context: ChatKitEndpointContext,
  options: ChatKitAttachmentFilePartHandlerOptions = {},
): ConvertToAiSdkFileUploadHandler {
  const fetchImpl = options.fetch ?? fetch;
  return async ({ part }) => {
    const attachment = chatKitAttachmentMetadata(part);
    if (!attachment?.attachmentId) {
      return modelSafeFilePart(part);
    }

    const download = await context.client.chatkit.getAttachmentDownloadUrl({
      sessionId: context.sessionId,
      attachmentId: attachment.attachmentId,
    });
    const downloadUrl = absoluteDownloadUrl(
      download.downloadUrl,
      context.client.config.baseUrl,
    );
    const response = await fetchImpl(downloadUrl, {
      headers: configHeaders(context.client.config),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download ChatKit attachment ${attachment.attachmentId} (${response.status})`,
      );
    }

    const filename = attachment.filename ?? part.filename ?? undefined;
    const mediaType = normalizeMediaType(
      attachment.mediaType ??
        part.media_type ??
        part.mediaType ??
        part.mimeType ??
        response.headers.get("content-type"),
      filename,
    );
    if (!isModelSupportedFileMediaType(mediaType)) {
      return attachedFileTextPart(
        filename ?? attachment.attachmentId,
        mediaType,
        downloadUrl,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      type: "file",
      mediaType,
      filename,
      url: `data:${mediaType};base64,${bytes.toString("base64")}`,
    } as UIMessage["parts"][number];
  };
}

function absoluteDownloadUrl(downloadUrl: string, baseUrl: string): string {
  return new URL(downloadUrl, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function modelSafeFilePart(
  part: ChatKitUiFilePart,
): UIMessage["parts"][number] | null {
  const filename = part.filename ?? undefined;
  const mediaType = normalizeMediaType(
    part.media_type ?? part.mediaType ?? part.mimeType,
    filename,
  );
  if (!isModelSupportedFileMediaType(mediaType)) {
    return attachedFileTextPart(filename ?? "unnamed file", mediaType);
  }
  return {
    type: "file",
    mediaType,
    filename,
    url: part.url,
  } as UIMessage["parts"][number];
}

function attachedFileTextPart(
  label: string,
  mediaType: string,
  downloadUrl?: string,
): UIMessage["parts"][number] {
  const suffix = downloadUrl ? ` Download URL: ${downloadUrl}` : "";
  return {
    type: "text",
    text: `Attached file: ${label} (${mediaType}).${suffix}`,
  } as UIMessage["parts"][number];
}

function chatKitAttachmentMetadata(part: ChatKitUiFilePart): {
  attachmentId: string;
  mediaType?: string;
  filename?: string;
} | null {
  if (part.attachment_id) {
    const metadata: {
      attachmentId: string;
      mediaType?: string;
      filename?: string;
    } = {
      attachmentId: part.attachment_id,
      mediaType: normalizeMediaType(
        part.media_type ?? part.mediaType ?? part.mimeType,
        part.filename ?? undefined,
      ),
    };
    if (part.filename) metadata.filename = part.filename;
    return metadata;
  }

  const chatkit =
    part.provider_metadata?.chatkit ?? part.providerMetadata?.chatkit;
  if (!isRecord(chatkit)) return null;
  const attachmentId =
    stringField(chatkit, "attachmentId") ?? stringField(chatkit, "id");
  if (!attachmentId) return null;
  const filename = stringField(chatkit, "filename");
  const metadata: {
    attachmentId: string;
    mediaType?: string;
    filename?: string;
  } = {
    attachmentId,
    mediaType: normalizeMediaType(
      stringField(chatkit, "mediaType") ?? stringField(chatkit, "mimeType"),
      filename,
    ),
  };
  if (filename) metadata.filename = filename;
  return metadata;
}

function normalizeMediaType(
  mediaType?: string | null,
  filename?: string,
): string {
  const trimmed = mediaType?.split(";")[0]?.trim().toLowerCase();
  if (trimmed && trimmed !== "application/octet-stream") return trimmed;
  return mediaTypeFromFilename(filename) ?? "application/octet-stream";
}

function mediaTypeFromFilename(filename?: string): string | null {
  const extension = filename?.split(".").pop()?.toLowerCase();
  if (!extension) return null;
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
    case "md":
    case "csv":
    case "log":
      return "text/plain";
    case "json":
      return "application/json";
    default:
      return null;
  }
}

function isModelSupportedFileMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function stringField(
  value: JsonObject,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
