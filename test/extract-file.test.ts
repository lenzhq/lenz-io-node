import { describe, expect, it, vi } from "vitest";

import { Lenz, LenzRateLimitError, LenzValidationError } from "../src/index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockResponse {
  status?: number;
  body?: unknown;
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
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers,
    });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

const SAMPLE_CLAIMS = {
  status: "ready",
  claim: "Revenue grew 20% in 2025.",
  claims: [
    {
      claim: "Revenue grew 20% in 2025.",
      text: "Revenue grew 20% in 2025.",
    },
  ],
  identified_claims: ["Revenue grew 20% in 2025."],
  domain: "Business",
  original_input: "",
};

describe("extractFile()", () => {
  describe("client-side validation", () => {
    it("rejects non-binary input with LenzValidationError", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await expect(
        client.extractFile("not a binary" as unknown as Uint8Array, { filename: "test.pdf" }),
      ).rejects.toThrow(LenzValidationError);
    });

    it("rejects SharedArrayBuffer with LenzValidationError", async () => {
      if (typeof SharedArrayBuffer === "undefined") return;
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const sab = new SharedArrayBuffer(16);
      await expect(
        client.extractFile(sab as unknown as ArrayBuffer, { filename: "test.pdf" }),
      ).rejects.toThrow(LenzValidationError);
    });

    it("rejects 0-byte empty Uint8Array with LenzValidationError", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = await client
        .extractFile(new Uint8Array(0), { filename: "test.pdf" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_option");
      expect(err.param).toBe("file");
      expect(err.message).toBe("extractFile(): file is empty (0 bytes).");
    });

    it("rejects 0-byte empty Blob with LenzValidationError", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const emptyBlob = new Blob([]);
      const err = await client.extractFile(emptyBlob, { filename: "test.pdf" }).catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_option");
      expect(err.param).toBe("file");
      expect(err.message).toBe("extractFile(): file is empty (0 bytes).");
    });

    it("rejects missing filename for Uint8Array with LenzValidationError", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = await client.extractFile(new Uint8Array([1, 2, 3])).catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_argument");
      expect(err.param).toBe("filename");
      expect(err.message).toContain("filename is required");
    });

    it("rejects missing filename for Blob with LenzValidationError", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      const err = await client.extractFile(blob).catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_argument");
      expect(err.param).toBe("filename");
      expect(err.message).toContain("filename is required");
    });

    it("rejects unsupported file extensions with extraction-specific error message", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = await client
        .extractFile(new Uint8Array([1, 2, 3]), { filename: "notes.txt" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_argument");
      expect(err.param).toBe("filename");
      expect(err.message).toBe(
        "Unsupported file format for extraction: notes.txt. Only Word (.docx), PDF (.pdf), and image (.png, .jpg, .webp) files are supported.",
      );
    });

    it("rejects invalid options type with LenzValidationError", async () => {
      const { fetch } = makeFetch([]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const err = await client
        .extractFile(new Uint8Array([1, 2, 3]), "not-an-object" as never)
        .catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_option");
      expect(err.param).toBe("options");
    });
  });

  describe("supported file formats and MIME types", () => {
    const cases = [
      { filename: "document.pdf", mime: "application/pdf" },
      { filename: "DOCUMENT.PDF", mime: "application/pdf" },
      {
        filename: "report.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        filename: "REPORT.DOCX",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      { filename: "chart.png", mime: "image/png" },
      { filename: "CHART.PNG", mime: "image/png" },
      { filename: "photo.jpg", mime: "image/jpeg" },
      { filename: "photo.jpeg", mime: "image/jpeg" },
      { filename: "PHOTO.JPEG", mime: "image/jpeg" },
      { filename: "graphic.webp", mime: "image/webp" },
      { filename: "GRAPHIC.WEBP", mime: "image/webp" },
    ];

    for (const { filename, mime } of cases) {
      it(`accepts ${filename} with mime ${mime}`, async () => {
        const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
        const client = new Lenz({ apiKey: "lenz_t", fetch });
        const res = await client.extractFile(new Uint8Array([1, 2, 3]), { filename });
        expect(res.status).toBe("ready");
        expect(res.identified_claims).toEqual(["Revenue grew 20% in 2025."]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("https://lenz.io/api/v1/extract/file");
        expect(calls[0]!.init.method).toBe("POST");

        const body = calls[0]!.init.body as FormData;
        const file = body.get("file") as Blob;
        expect(file).toBeInstanceOf(Blob);
        expect(file.type).toBe(mime);
      });
    }
  });

  describe("input types", () => {
    it("accepts ArrayBuffer", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const ab = new ArrayBuffer(4);
      new Uint8Array(ab).set([1, 2, 3, 4]);
      const res = await client.extractFile(ab, { filename: "data.pdf" });
      expect(res.status).toBe("ready");
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      const file = body.get("file") as Blob;
      expect(file.size).toBe(4);
    });

    it("accepts Blob with filename in options", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
      const res = await client.extractFile(blob, { filename: "report.pdf" });
      expect(res.status).toBe("ready");
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      const file = body.get("file") as Blob;
      expect(file.size).toBe(5);
    });

    it("accepts File object and extracts its name", async () => {
      if (typeof File === "undefined") return;
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const fileObj = new File([new Uint8Array([10, 20])], "from-disk.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const res = await client.extractFile(fileObj);
      expect(res.status).toBe("ready");
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      const file = body.get("file") as File;
      expect(file.name).toBe("from-disk.docx");
      expect(file.type).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    });
  });

  describe("options handling", () => {
    it("appends language when given", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        language: "de",
      });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      expect(body.get("language")).toBe("de");
    });

    it("omits language when empty or undefined", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        language: "",
      });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      expect(body.get("language")).toBeNull();
    });

    it("appends focus when given", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        focus: "financial metrics",
      });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      expect(body.get("focus")).toBe("financial metrics");
    });

    it("omits focus when empty or undefined", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        focus: "",
      });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      expect(body.get("focus")).toBeNull();
    });

    it("appends locate: 'true' when locate is true", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        locate: true,
      });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      expect(body.get("locate")).toBe("true");
    });

    it("appends locate: 'false' when locate is false", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        locate: false,
      });
      expect(calls).toHaveLength(1);
      const body = calls[0]!.init.body as FormData;
      expect(body.get("locate")).toBe("false");
    });

    it("omits locate when locate is undefined or non-boolean", async () => {
      const { fetch, calls } = makeFetch([
        { status: 200, body: SAMPLE_CLAIMS },
        { status: 200, body: SAMPLE_CLAIMS },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
      });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        language: null as unknown as string,
        focus: null as unknown as string,
        locate: null as unknown as boolean,
      });
      expect(calls).toHaveLength(2);
      const body0 = calls[0]!.init.body as FormData;
      expect(body0.get("locate")).toBeNull();
      const body1 = calls[1]!.init.body as FormData;
      expect(body1.get("language")).toBeNull();
      expect(body1.get("focus")).toBeNull();
      expect(body1.get("locate")).toBeNull();
    });
  });

  describe("idempotency", () => {
    it("generates random Idempotency-Key by default", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), { filename: "test.pdf" });
      expect(calls).toHaveLength(1);
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("uses caller's explicit idempotencyKey", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        idempotencyKey: "custom-extract-key-123",
      });
      expect(calls).toHaveLength(1);
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("custom-extract-key-123");
    });

    it("omits Idempotency-Key when idempotency: false", async () => {
      const { fetch, calls } = makeFetch([{ status: 200, body: SAMPLE_CLAIMS }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        idempotency: false,
      });
      expect(calls).toHaveLength(1);
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBeUndefined();
    });
  });

  describe("response normalization and locate", () => {
    it("normalizes locations with start/end null when locate is true", async () => {
      const responseWithLocations = {
        status: "ready",
        claim: "Revenue grew 20%.",
        claims: [
          {
            claim: "Revenue grew 20%.",
            text: "Revenue grew 20%.",
            positions: [{ start: null, end: null, text: "Revenue grew 20%." }],
          },
        ],
        identified_claims: ["Revenue grew 20%."],
        domain: "Business",
        locations: [
          {
            claim: "Revenue grew 20%.",
            positions: [{ start: null, end: null, text: "Revenue grew 20%." }],
          },
        ],
      };
      const { fetch } = makeFetch([{ status: 200, body: responseWithLocations }]);
      const client = new Lenz({ apiKey: "lenz_t", fetch });
      const res = await client.extractFile(new Uint8Array([1, 2, 3]), {
        filename: "test.pdf",
        locate: true,
      });
      expect(res.locations).toBeDefined();
      expect(res.locations?.[0]?.positions?.[0]?.start).toBeNull();
      expect(res.locations?.[0]?.positions?.[0]?.end).toBeNull();
      expect(res.locations?.[0]?.positions?.[0]?.text).toBe("Revenue grew 20%.");
    });
  });

  describe("server error handling", () => {
    it("maps 422 invalid_file error to LenzValidationError", async () => {
      const { fetch } = makeFetch([
        {
          status: 422,
          body: {
            code: "invalid_file",
            detail: "The uploaded file could not be parsed.",
            errors: [
              {
                loc: ["file"],
                msg: "The uploaded file could not be parsed.",
                type: "invalid_file",
              },
            ],
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const err = await client
        .extractFile(new Uint8Array([1, 2, 3]), { filename: "test.pdf" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(LenzValidationError);
      expect(err.code).toBe("invalid_file");
      expect(err.statusCode).toBe(422);
    });

    it("preserves validation_error and unsupported_language codes on 422", async () => {
      const { fetch } = makeFetch([
        {
          status: 422,
          body: {
            code: "validation_error",
            detail: "focus is at most 300 characters.",
            errors: [
              { loc: ["focus"], msg: "focus is at most 300 characters.", type: "value_error" },
            ],
          },
        },
        {
          status: 422,
          body: {
            code: "unsupported_language",
            detail: "Unsupported language 'xx'.",
            errors: [
              {
                loc: ["language"],
                msg: "Unsupported language 'xx'.",
                type: "unsupported_language",
              },
            ],
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const err1 = await client
        .extractFile(new Uint8Array([1, 2, 3]), { filename: "test.pdf", focus: "x".repeat(301) })
        .catch((e) => e);
      expect(err1).toBeInstanceOf(LenzValidationError);
      expect(err1.code).toBe("validation_error");

      const err2 = await client
        .extractFile(new Uint8Array([1, 2, 3]), { filename: "test.pdf", language: "xx" })
        .catch((e) => e);
      expect(err2).toBeInstanceOf(LenzValidationError);
      expect(err2.code).toBe("unsupported_language");
    });

    it("maps 429 upload_limit error to LenzRateLimitError", async () => {
      const { fetch } = makeFetch([
        {
          status: 429,
          body: {
            code: "upload_limit",
            detail: "Daily upload limit reached.",
          },
        },
      ]);
      const client = new Lenz({ apiKey: "lenz_t", fetch, maxRetries: 0 });
      const err = await client
        .extractFile(new Uint8Array([1, 2, 3]), { filename: "test.pdf" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(LenzRateLimitError);
      expect(err.code).toBe("upload_limit");
      expect(err.statusCode).toBe(429);
    });
  });
});
