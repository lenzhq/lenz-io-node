import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  Lenz,
  LenzError,
  LenzGoneError,
  LenzInvalidResponseError,
  LenzNotFoundError,
  LenzValidationError,
  ReviewTimeoutError,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "contract", name), "utf-8")) as T;
}

const COMPLETED = fixture("review_completed.json");
const VERIFYING = fixture("review_verifying.json");

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

function makeFetch(responses: Iterable<MockResponse>) {
  const queue = Array.from(responses);
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    const headers = new Headers(next.headers ?? {});
    if (next.bytes !== undefined) {
      if (!headers.has("content-type")) {
        headers.set(
          "content-type",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
      }
      return new Response(next.bytes, {
        status: next.status ?? 200,
        headers,
      });
    }
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers,
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

describe("reviewFile()", () => {
  it("rejects non-binary input with LenzValidationError", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(
      client.reviewFile("not a binary" as unknown as Uint8Array, { filename: "test.docx" }),
    ).rejects.toThrow(LenzValidationError);
  });

  it("rejects SharedArrayBuffer with LenzValidationError", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const sab = new SharedArrayBuffer(16);
    await expect(
      client.reviewFile(sab as unknown as ArrayBuffer, { filename: "test.docx" }),
    ).rejects.toThrow(LenzValidationError);
  });

  it("rejects 0-byte empty file with LenzValidationError", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await client
      .reviewFile(new Uint8Array(0), { filename: "test.docx" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.code).toBe("invalid_option");
    expect(err.param).toBe("file");
    expect(err.message).toContain("file must not be empty.");
  });

  it("rejects missing filename for Uint8Array with LenzValidationError", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.reviewFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(LenzValidationError);
  });

  it("rejects unsupported file extensions with the updated error message", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const err = await client
      .reviewFile(new Uint8Array([1, 2, 3]), { filename: "notes.txt" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LenzValidationError);
    expect(err.code).toBe("invalid_argument");
    expect(err.param).toBe("filename");
    expect(err.message).toBe(
      "Unsupported file format for review: notes.txt. Only Word (.docx), PDF (.pdf), and image (.png, .jpg, .webp) files are supported.",
    );
  });

  it("accepts supported image formats (.png, .jpg, .jpeg, .webp) with correct mime types", async () => {
    const cases = [
      { filename: "chart.png", mime: "image/png" },
      { filename: "photo.jpg", mime: "image/jpeg" },
      { filename: "photo.jpeg", mime: "image/jpeg" },
      { filename: "graphic.webp", mime: "image/webp" },
      { filename: "DOCUMENT.PDF", mime: "application/pdf" },
      {
        filename: "REPORT.DOCX",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ];

    for (const { filename, mime } of cases) {
      const { fetch, calls } = makeFetch([
        { status: 202, body: { review_id: "r-img", status: "queued" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const res = await client.reviewFile(new Uint8Array([1, 2, 3]), { filename });
      expect(res).toEqual({ review_id: "r-img", status: "queued" });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      const file = body.get("file") as Blob;
      expect(file).toBeDefined();
      expect(file.type).toBe(mime);
    }
  });

  it("submits multipart/form-data with file and filename", async () => {
    const { fetch, calls } = makeFetch([
      { status: 202, body: { review_id: "r123", status: "queued" } },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const res = await client.reviewFile(new Uint8Array([1, 2, 3]), {
      filename: "test.docx",
      language: "en",
      visibility: "private",
      webhookUrl: "https://example.com/hook",
      escalate: {
        verdicts: ["False", "Mixed"],
        confidence: ["high"],
        maxAssessments: 5,
        depth: "standard",
        suggestEdits: true,
      },
      suppliedSources: [{ text: "https://example.com/source", title: "Source" }],
    });

    expect(res).toEqual({ review_id: "r123", status: "queued" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("/review");
    expect(call.init.method).toBe("POST");

    const body = call.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("file")).toBeDefined();
    expect(body.get("language")).toBe("en");
    expect(body.get("visibility")).toBe("private");
    expect(body.get("webhook_url")).toBe("https://example.com/hook");
    expect(JSON.parse(String(body.get("escalate")))).toEqual({
      verdicts: ["False", "Mixed"],
      confidence: ["high"],
      max_assessments: 5,
      depth: "standard",
      suggest_edits: true,
    });
    expect(JSON.parse(String(body.get("supplied_sources")))).toEqual([
      { text: "https://example.com/source", title: "Source" },
    ]);
  });

  it("handles 409 conflict receipts cleanly", async () => {
    const { fetch } = makeFetch([
      {
        status: 409,
        body: {
          detail: "A review with this Idempotency-Key is still being created. Retry shortly.",
          code: "idempotency_conflict",
          review_id: "r-conflict",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const res = await client.reviewFile(new Uint8Array([1, 2, 3]), {
      filename: "test.docx",
      idempotencyKey: "k",
    });
    expect(res).toEqual({ review_id: "r-conflict", status: "queued" });
  });

  it("throws LenzError if 409 lacks review_id", async () => {
    const conflict = {
      status: 409,
      body: {
        detail: "Still being created.",
        code: "idempotency_conflict",
        review_id: null,
      },
    };
    const { fetch } = makeFetch([conflict, conflict, conflict, conflict]);
    vi.useFakeTimers();
    try {
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = client
        .reviewFile(new Uint8Array([1, 2, 3]), { filename: "test.docx", idempotencyKey: "k" })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(20_000);
      const err = await pending;
      expect(err).toBeInstanceOf(LenzError);
      expect((err as LenzError).statusCode).toBe(409);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reviewFileAndWait()", () => {
  it("submits file and polls to completion", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = makeFetch([
        { status: 202, body: { review_id: "442b6aa9", status: "queued" } },
        { status: 200, body: COMPLETED },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const onProgress = vi.fn();
      const pending = client.reviewFileAndWait(new Uint8Array([1, 2, 3]), {
        filename: "test.docx",
        onProgress,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.review_id).toBe("442b6aa9");
      expect(result.status).toBe("completed");
      expect(onProgress).toHaveBeenCalled();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toContain("/reviews/442b6aa9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels review on timeout when cancelOnTimeout: true", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = makeFetch([
        { status: 202, body: { review_id: "442b6aa9", status: "queued" } },
        { status: 200, body: VERIFYING },
        { status: 200, body: { review_id: "442b6aa9", status: "cancelled" } },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = client
        .reviewFileAndWait(new Uint8Array([1, 2, 3]), {
          filename: "test.docx",
          timeoutMs: 1_000,
          cancelOnTimeout: true,
        })
        .catch((e) => e);

      await vi.advanceTimersByTimeAsync(2_000);
      const err = await pending;
      expect(err).toBeInstanceOf(ReviewTimeoutError);

      const cancelCall = calls.find((c) => c.url.includes("/cancel"));
      expect(cancelCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not forward wait-only options (cancelOnAbort, timeoutMs) to reviewFile", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = makeFetch([
        { status: 202, body: { review_id: "442b6aa9", status: "queued" } },
        { status: 200, body: COMPLETED },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const pending = client.reviewFileAndWait(new Uint8Array([1, 2, 3]), {
        filename: "test.docx",
        cancelOnAbort: true,
        timeoutMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.review_id).toBe("442b6aa9");
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waitForReview()", () => {
  it("polls an existing review to completion", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = makeFetch([
        { status: 200, body: { ...VERIFYING, poll_after_seconds: 5 } },
        { status: 200, body: COMPLETED },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const updates: string[] = [];
      const pending = client.waitForReview("442b6aa9", {
        timeoutMs: 30_000,
        onUpdate: (r) => updates.push(r.status),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe("completed");
      expect(calls).toHaveLength(2);
      expect(updates).toContain("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("exportReview()", () => {
  it("rejects empty reviewId with LenzValidationError", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.exportReview("")).rejects.toThrow(LenzValidationError);
  });

  it("rejects invalid format with LenzValidationError", async () => {
    const { fetch } = makeFetch([]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.exportReview("r123", { format: "" })).rejects.toThrow(LenzValidationError);
    await expect(client.exportReview("r123", { format: "   " })).rejects.toThrow(
      LenzValidationError,
    );
    await expect(client.exportReview("r123", { format: 123 as any })).rejects.toThrow(
      LenzValidationError,
    );
  });

  it("returns binary ReviewExport and parses content-disposition header", async () => {
    const fakeBytes = new Uint8Array([80, 75, 3, 4, 1, 2]);
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        bytes: fakeBytes,
        headers: {
          "content-disposition": "attachment; filename=review_r123.docx",
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "x-lenz-export-source": "rebuilt",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const exported = await client.exportReview("r123");

    expect(exported.data).toEqual(fakeBytes);
    expect(exported.filename).toBe("review_r123.docx");
    expect(exported.format).toBe("docx");
    expect(exported.content_type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(exported.source).toBe("rebuilt");
    expect(exported.httpStatus).toBe(200);

    const call = calls[0]!;
    expect(call.url).toContain("/reviews/r123/export?format=docx");
    expect(call.init.method).toBe("GET");
    const reqHeaders = call.init.headers as Record<string, string>;
    expect(reqHeaders["Accept"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("parses RFC 5987 filename* in Content-Disposition and handles custom format", async () => {
    const fakeBytes = new Uint8Array([1, 2, 3, 4]);
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        bytes: fakeBytes,
        headers: {
          "content-disposition":
            "attachment; filename*=UTF-8''my%20report%20%28final%29.pdf; filename=fallback.pdf",
          "content-type": "application/pdf",
          "x-lenz-export-source": "original",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    const exported = await client.exportReview("r123", { format: "pdf" });

    expect(exported.filename).toBe("my report (final).pdf");
    expect(exported.source).toBe("original");
    expect(exported.format).toBe("pdf");
    expect(exported.content_type).toBe("application/pdf");
    expect(calls[0]!.url).toContain("/reviews/r123/export?format=pdf");
  });

  it("maps 404 to LenzNotFoundError", async () => {
    const { fetch } = makeFetch([
      {
        status: 404,
        body: { code: "not_found", message: "Review not found" },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.exportReview("r-missing")).rejects.toThrow(LenzNotFoundError);
  });

  it("maps 410 to LenzGoneError when code is purged, gone, or review_expired", async () => {
    for (const code of ["purged", "gone", "review_expired"]) {
      const { fetch } = makeFetch([
        {
          status: 410,
          body: { code, message: `Review ${code}` },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await expect(client.exportReview("r-expired")).rejects.toThrow(LenzGoneError);
    }
  });

  it("maps server error codes from 400/409/422 responses cleanly", async () => {
    const errorCodes = [
      { status: 400, code: "unsupported_file_type" },
      { status: 400, code: "invalid_file" },
      { status: 422, code: "encrypted_file" },
      { status: 422, code: "empty_file" },
      { status: 422, code: "no_readable_text" },
      { status: 422, code: "image_animated" },
      { status: 413, code: "file_too_large" },
      { status: 400, code: "unsupported_format" },
      { status: 409, code: "not_exportable" },
      { status: 500, code: "export_failed" },
      { status: 429, code: "export_limit" },
    ];

    for (const { status, code } of errorCodes) {
      const { fetch } = makeFetch([
        {
          status,
          body: { code, message: `Error with code ${code}` },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const err = await client.exportReview("r-err").catch((e) => e);
      expect(err.code).toBe(code);
    }
  });

  it("throws LenzInvalidResponseError when docx payload lacks PK zip signature", async () => {
    const invalidBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { fetch } = makeFetch([
      {
        status: 200,
        bytes: invalidBytes,
        headers: {
          "content-disposition": "attachment; filename=corrupt.docx",
        },
      },
    ]);
    const client = new Lenz({ apiKey: "lenz_t", fetch });
    await expect(client.exportReview("r-corrupt")).rejects.toThrow(LenzInvalidResponseError);
  });

  it("sanitizes path traversal in Content-Disposition filenames", async () => {
    const fakeBytes = new Uint8Array([80, 75, 3, 4]);
    const testCases = [
      { header: 'attachment; filename="../../evil.docx"', expected: "evil.docx" },
      { header: 'attachment; filename="/etc/passwd"', expected: "passwd" },
      { header: 'attachment; filename=".."', expected: "lenz-check-r-trav.docx" },
      { header: 'attachment; filename="."', expected: "lenz-check-r-trav.docx" },
      {
        header: "attachment; filename*=UTF-8''bad%00file.docx",
        expected: "lenz-check-r-trav.docx",
      },
      {
        header: "attachment; filename*=UTF-8''bad%1Ffile.docx",
        expected: "lenz-check-r-trav.docx",
      },
      {
        header: "attachment; filename*=UTF-8''bad%7Ffile.docx",
        expected: "lenz-check-r-trav.docx",
      },
    ];

    for (const tc of testCases) {
      const { fetch } = makeFetch([
        {
          status: 200,
          bytes: fakeBytes,
          headers: {
            "content-disposition": tc.header,
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const res = await client.exportReview("r-trav");
      expect(res.filename).toBe(tc.expected);
    }
  });
});
