/**
 * A recording `fetch` for the request-options tests: it records what each
 * request sent (and when, on the test's clock), and answers from a queue.
 * A reply can hang until the request's signal aborts, stall its body, or
 * fail as a network error.
 */

import { expect } from "vitest";

import { VERSION } from "../../src/index.js";

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Never answer: the request hangs until its signal aborts. */
  hang?: true;
  /** Send the headers, then stall the body until the signal aborts. */
  stallBody?: true;
  /** Reject the fetch itself (a network error). */
  networkError?: true;
}

export interface Sent {
  at: number;
  method: string;
  url: string;
  body: string | undefined;
  headers: Array<[string, string]>;
  signal: AbortSignal | undefined;
}

export function recorder(replies: Iterable<Reply>, fallback?: Reply) {
  const queue = Array.from(replies);
  const sent: Sent[] = [];
  const aborts: number[] = [];
  const t0 = Date.now();
  const impl = (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const at = Date.now() - t0;
    const signal = init.signal ?? undefined;
    sent.push({
      at,
      method: String(init.method),
      url: String(url),
      body: init.body === undefined ? undefined : String(init.body),
      headers: Object.entries(init.headers as Record<string, string>),
      signal,
    });
    signal?.addEventListener("abort", () => aborts.push(Date.now() - t0));
    const next = queue.shift() ?? fallback;
    if (!next) return Promise.reject(new Error("no more mocked responses"));
    if (next.networkError) return Promise.reject(new TypeError("fetch failed"));
    if (next.hang) {
      return new Promise<Response>((_res, rej) => {
        if (signal?.aborted) rej(new DOMException("This operation was aborted", "AbortError"));
        signal?.addEventListener("abort", () =>
          rej(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }
    const headers = new Headers(next.headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (next.stallBody) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          signal?.addEventListener("abort", () =>
            controller.error(new DOMException("This operation was aborted", "AbortError")),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: next.status ?? 200, headers }));
    }
    return Promise.resolve(
      new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers,
      }),
    );
  };
  return { fetch: impl as unknown as typeof fetch, sent, aborts };
}

const RANDOM_KEY = /^[0-9a-f]{32}$/;

/** A request as lines: the request, the body, then one per header (random keys masked). */
export function wire(s: Sent): string[] {
  return [
    `${s.method} ${s.url}`,
    `body: ${s.body === undefined ? "<none>" : s.body}`,
    ...s.headers.map(([name, value]) => {
      if (name === "User-Agent" && value === `lenz-io-node/${VERSION}`) {
        return `${name}: lenz-io-node/<VERSION>`;
      }
      if (name === "Idempotency-Key" && RANDOM_KEY.test(value)) return `${name}: <random>`;
      return `${name}: ${value}`;
    }),
  ];
}

/** The value of a header in a sent request, by exact name. */
export function header(s: Sent, name: string): string | undefined {
  return s.headers.find(([n]) => n === name)?.[1];
}

export async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

export function expectNoRequest(sent: Sent[]): void {
  expect(sent).toHaveLength(0);
}

/**
 * An AbortController whose signal counts the listeners added to it and not
 * yet removed: `live()` is 0 once a call has cleaned up after itself.
 */
export function countedController(): { controller: AbortController; live: () => number } {
  const controller = new AbortController();
  const signal = controller.signal;
  type Listener = Parameters<AbortSignal["addEventListener"]>[1];
  type ListenerOptions = Parameters<AbortSignal["addEventListener"]>[2];
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const added = new Set<unknown>();
  signal.addEventListener = ((type: "abort", fn: Listener, o?: ListenerOptions) => {
    added.add(fn);
    add(type, fn, o);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: "abort", fn: Listener) => {
    added.delete(fn);
    remove(type, fn);
  }) as typeof signal.removeEventListener;
  return { controller, live: () => added.size };
}
