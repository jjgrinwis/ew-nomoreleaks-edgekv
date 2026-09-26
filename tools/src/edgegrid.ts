/*
Thin promise wrapper around the akamai-edgegrid client, plus request pacing.

The EdgeKV Administrative API is rate limited to a burst of 24 hits/sec and an
average of 18 hits/sec over two minutes; exceeding it returns 403 and blocks the
client for ten minutes. Everything here therefore goes through one Pacer, and
the default is deliberately far below the cap - a refresh runs every few weeks,
so there is nothing to gain from running near the limit.
*/
import EdgeGrid from "akamai-edgegrid";
import { homedir } from "node:os";
import { join } from "node:path";

/** Base path of the EdgeKV Administrative API. */
export const EDGEKV_API = "/edgekv/v1";

/**
 * Resolve the ~/.edgerc section to use. Account-specific values are never
 * hardcoded here - they come from local-config.sh via the environment, or
 * from an explicit flag. There is deliberately no default: a wrong section
 * would authenticate against the wrong account.
 */
export function requireSection(flag?: string): string {
  const section = flag ?? process.env["AKAMAI_EDGERC_SECTION"];
  if (!section) {
    throw new Error(
      "no ~/.edgerc section given: source ./local-config.sh (sets " +
        "AKAMAI_EDGERC_SECTION) or pass --section",
    );
  }
  return section;
}

export function requireNamespace(flag?: string): string {
  const namespace = flag ?? process.env["EDGEKV_NAMESPACE"];
  if (!namespace) {
    throw new Error(
      "no EdgeKV namespace given: source ./local-config.sh (sets " +
        "EDGEKV_NAMESPACE) or pass --namespace",
    );
  }
  return namespace;
}

export type Network = "staging" | "production";

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Response headers, lowercased by axios. */
  headers: Record<string, string>;
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT";
  /** Path below EDGEKV_API, e.g. "/networks/staging/namespaces/<namespace>/upload". */
  path: string;
  query?: Record<string, string>;
  /**
   * Request body. Must be a string: the library JSON-stringifies any non-string
   * object body, which would silently corrupt a CSV or binary payload.
   */
  body?: string;
  contentType?: string;
  /**
   * Return the response body verbatim instead of letting axios parse it. Needed
   * for reading items back: a bucket value of nothing but digits would otherwise
   * be JSON-parsed into a number and lose precision.
   */
  raw?: boolean;
}

/** Enforces a minimum interval between requests. */
export class Pacer {
  private readonly intervalMs: number;
  private next = 0;

  constructor(requestsPerSecond: number) {
    this.intervalMs = 1000 / requestsPerSecond;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) {
      await new Promise((resolve) => setTimeout(resolve, at - now));
    }
  }
}

export class EdgeKvApi {
  private readonly client: EdgeGrid;
  private readonly switchKey: string | undefined;
  private readonly pacer: Pacer;

  constructor(options: {
    section: string;
    edgerc?: string;
    switchKey?: string;
    requestsPerSecond?: number;
  }) {
    this.client = new EdgeGrid({
      path: options.edgerc ?? join(homedir(), ".edgerc"),
      section: options.section,
    });
    this.switchKey = options.switchKey;
    this.pacer = new Pacer(options.requestsPerSecond ?? 5);
  }

  async send(request: ApiRequest): Promise<ApiResponse> {
    await this.pacer.wait();

    const query: Record<string, string> = { ...request.query };
    if (this.switchKey) {
      query.accountSwitchKey = this.switchKey;
    }

    const headers: Record<string, string> = {
      // extendHeaders() defaults this to application/json, which the CSV upload
      // endpoint rejects with 415, so always state it explicitly.
      "Content-Type": request.contentType ?? "application/json",
    };

    this.client.auth({
      path: EDGEKV_API + request.path,
      method: request.method,
      headers: headers,
      qs: Object.keys(query).length > 0 ? query : undefined,
      body: request.body,
    });

    // Accept every status and let the caller decide, so that a 404 or a 207 does
    // not arrive as a thrown axios error with the body buried inside it.
    const outgoing = this.client.request as Record<string, unknown>;
    outgoing.validateStatus = () => true;
    if (request.raw) {
      outgoing.transformResponse = [(data: unknown) => data];
    }

    return new Promise<ApiResponse>((resolve, reject) => {
      this.client.send((error, response) => {
        if (error && !response) {
          reject(error);
          return;
        }
        resolve({
          status: response!.status,
          body: response!.data,
          headers: (response!.headers ?? {}) as Record<string, string>,
        });
      });
    });
  }
}

/** A one-line description of an API error response, for a thrown Error. */
export function describeError(response: ApiResponse): string {
  const body = response.body;
  if (body && typeof body === "object") {
    const problem = body as { title?: string; detail?: string };
    const parts = [problem.title, problem.detail].filter(Boolean);
    if (parts.length > 0) {
      return `HTTP ${response.status}: ${parts.join(" - ")}`;
    }
  }
  if (typeof body === "string" && body.length > 0) {
    return `HTTP ${response.status}: ${body.substring(0, 300)}`;
  }
  return `HTTP ${response.status}`;
}

/** Parse `--flag value` style arguments into a map, plus the bare positionals. */
export function parseArgs(argv: string[]): {
  flags: Record<string, string>;
  bools: Set<string>;
  positionals: string[];
} {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.substring(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      bools.add(name);
    } else {
      flags[name] = value;
      i++;
    }
  }

  return { flags, bools, positionals };
}

/** The network to act on, validated. */
export function requireNetwork(value: string | undefined): Network {
  if (value !== "staging" && value !== "production") {
    throw new Error("--network must be 'staging' or 'production'");
  }
  return value;
}
