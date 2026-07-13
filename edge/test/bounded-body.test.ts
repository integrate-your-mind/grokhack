import { describe, expect, it } from "vitest";

import { BoundedBodyError, readBoundedBytes, readBoundedText } from "../src/bounded-body";

function requestWithBody(body: ReadableStream<Uint8Array>): Request {
  return new Request("https://edge.test/internal", { method: "POST", body });
}

describe("bounded request bodies", () => {
  it("decodes valid UTF-8 split across transport chunks", async () => {
    const encoded = new TextEncoder().encode("a🙂b");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 3));
        controller.enqueue(encoded.slice(3));
        controller.close();
      },
    });
    await expect(readBoundedText(requestWithBody(body), encoded.byteLength)).resolves.toBe("a🙂b");
  });

  it("cancels an oversized stream without pulling another chunk", async () => {
    let pulls = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new Uint8Array(5));
        else controller.error(new Error("reader pulled past the limit"));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    await expect(readBoundedBytes(requestWithBody(body), 4)).rejects.toMatchObject<BoundedBodyError>({
      code: "body_too_large",
    });
    expect(pulls).toBe(1);
    expect(cancelReason).toBe("body_too_large");
  });

  it("rejects malformed UTF-8 instead of replacing bytes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
      },
    });
    await expect(readBoundedText(requestWithBody(body), 2)).rejects.toMatchObject<BoundedBodyError>({
      code: "invalid_utf8",
    });
  });
});
