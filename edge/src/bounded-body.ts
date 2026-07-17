export type BoundedBodyErrorCode = "body_too_large" | "invalid_utf8";

export class BoundedBodyError extends Error {
  readonly code: BoundedBodyErrorCode;

  constructor(code: BoundedBodyErrorCode) {
    super(code);
    this.name = "BoundedBodyError";
    this.code = code;
  }
}

function validateDeclaredLength(request: Request, maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("invalid body byte limit");
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new BoundedBodyError("body_too_large");
  }
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>, code: BoundedBodyErrorCode): Promise<never> {
  try {
    await reader.cancel(code);
  } catch {
    // Preserve the validation failure even if the peer has already broken the stream.
  }
  throw new BoundedBodyError(code);
}

export async function readBoundedText(request: Request, maximumBytes: number): Promise<string> {
  validateDeclaredLength(request, maximumBytes);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) return await cancel(reader, "body_too_large");
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        return await cancel(reader, "invalid_utf8");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new BoundedBodyError("invalid_utf8");
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  validateDeclaredLength(request, maximumBytes);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) return await cancel(reader, "body_too_large");
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
