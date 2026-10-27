// The one error the WebP codec (webp.ts and the modules it uses) throws.

export type WebpErrorCode = "NOT_WEBP" | "CORRUPT" | "UNSUPPORTED" | "TOO_LARGE";

export class WebpError extends Error {
  code: WebpErrorCode;
  constructor(code: WebpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const corrupt = (message: string) => new WebpError("CORRUPT", message);
