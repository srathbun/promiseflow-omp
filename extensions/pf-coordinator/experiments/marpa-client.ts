// Minimal JSONL client for the Marpa worker's stateless `parse_once` op.
//
// This is the "Marpa worker performs the actual parse" compute client for the
// M15 experiment. It speaks the worker's JSONL protocol and understands nothing
// about Marpa grammars; the worker itself is reached as an external process
// (path overridable via MARP_WORKER / MARP_PERL, defaulting to the Aristotle
// repo's Strawberry-Perl worker).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

export type ParseStatus = "VALID" | "AMBIGUOUS" | "INVALID";

export interface ParseOnceResult {
  status: ParseStatus;
  valueCount: number;
  values: string[];
  fragmentCount: number;
  error?: string;
  progress?: string;
}

interface Pending {
  resolve: (r: ParseOnceResult) => void;
  reject: (e: Error) => void;
}

function perlPath(): string {
  if (process.env.MARP_PERL) return process.env.MARP_PERL;
  const strawberry = "C:/Strawberry/perl/bin/perl.exe";
  if (existsSync(strawberry)) return strawberry;
  return "perl";
}

function workerScript(): string {
  return process.env.MARP_WORKER ?? "F:/aristotle/worker/marpa-worker.pl";
}

const REQUEST_TIMEOUT_MS = 30_000;

export class MarpaParseClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<void> = Promise.resolve();

  private ensureStarted(): void {
    if (this.proc) return;
    this.proc = spawn(perlPath(), [workerScript()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => {
      this.failAll(err);
      this.proc = null;
    });
    this.proc.on("exit", () => {
      this.failAll(new Error("Marpa worker exited"));
      this.proc = null;
    });
  }

  /** Serialized request: one JSON object out, exactly one response matched back. */
  parseOnce(grammar: string, fragments: string[]): Promise<ParseOnceResult> {
    const req = { op: "parse_once", grammar, fragments };
    const run = (): Promise<ParseOnceResult> => this.doRequest(req);
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  terminate(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        p.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    this.failAll(new Error("Marpa worker terminated"));
  }

  private doRequest(req: { op: string; grammar: string; fragments: string[] }): Promise<ParseOnceResult> {
    this.ensureStarted();
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("Marpa worker unavailable"));
    const id = this.nextId++;
    return new Promise<ParseOnceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Marpa worker parse_once timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r: ParseOnceResult) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      proc.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    });
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString("utf8");
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let resp: unknown;
      try {
        resp = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof resp !== "object" || resp === null) continue;
      const r = resp as { id?: unknown; ok?: unknown; error?: unknown };
      if (typeof r.id !== "number") continue;
      const p = this.pending.get(r.id);
      if (!p) continue;
      this.pending.delete(r.id);
      if (r.ok === true) {
        p.resolve(normalize(resp));
      } else {
        p.reject(new Error(describeError(r.error)));
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.buffer = "";
  }
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return typeof error === "string" ? error : "parse_once failed";
}

function normalize(resp: unknown): ParseOnceResult {
  const r = resp as Record<string, unknown>;
  const status: ParseStatus = r.status === "AMBIGUOUS" || r.status === "INVALID" ? r.status : "VALID";
  const rawValues = Array.isArray(r.values) ? r.values : [];
  const values = rawValues.filter((v): v is string => typeof v === "string");
  const valueCount = typeof r.value_count === "number" ? r.value_count : values.length;
  const fragmentCount = typeof r.fragment_count === "number" ? r.fragment_count : 0;
  const out: ParseOnceResult = { status, valueCount, values, fragmentCount };
  if (typeof r.error === "string") out.error = r.error;
  if (typeof r.progress === "string") out.progress = r.progress;
  return out;
}