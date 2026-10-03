// marpa-state-client.ts — minimal stateful client for the Marpa worker's create/add/parse/
// extend surface (used by the integrated grammar-authoring loop). Speaks the same JSONL
// protocol as MarpaParseClient, but against the stateful `%STATES` ops.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function perlPath(): string {
  if (process.env.MARP_PERL) return process.env.MARP_PERL;
  const strawberry = "C:/Strawberry/perl/bin/perl.exe";
  if (existsSync(strawberry)) return strawberry;
  return "perl";
}

function workerScript(): string {
  if (process.env.MARP_WORKER) return process.env.MARP_WORKER;
  return join(repoRoot, "..", "aristotle", "worker", "marpa-worker.pl");
}

export interface MarpaOutcome {
  status: "VALID" | "AMBIGUOUS" | "INVALID";
  valueCount: number;
  values: string[];
  fragmentCount: number;
  grammarVersion: number;
  error?: string;
  progress?: string;
}

interface WorkerMessage {
  id: number;
  ok: boolean;
  error?: { message?: string } | string;
  state_id?: string;
  grammar_version?: number;
  fragment_id?: string;
  fragment_count?: number;
  status?: MarpaOutcome["status"];
  values?: string[];
  value_count?: number;
  progress?: string;
}

type Pending = { resolve: (m: WorkerMessage) => void; reject: (e: Error) => void };

export class MarpaStateClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  private ensureStarted(): void {
    if (this.proc) return;
    const child = spawn(perlPath(), [workerScript()], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = child;
    child.stdout.on("data", (d: Buffer) => this.onData(d));
    child.stderr.on("data", () => {});
    child.on("exit", () => this.failAll(new Error("marpa worker exited")));
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: WorkerMessage;
      try {
        msg = JSON.parse(line) as WorkerMessage;
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.ok === false) p.reject(new Error(typeof msg.error === "string" ? msg.error : msg.error?.message ?? "worker error"));
        else p.resolve(msg);
      }
    }
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private request(op: string, params: Record<string, unknown>): Promise<WorkerMessage> {
    this.ensureStarted();
    const id = this.nextId++;
    const run = (): Promise<WorkerMessage> =>
      new Promise<WorkerMessage>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.proc!.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
      });
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private static outcome(m: WorkerMessage): MarpaOutcome {
    return {
      status: m.status ?? "INVALID",
      valueCount: typeof m.value_count === "number" ? m.value_count : (m.values?.length ?? 0),
      values: (m.values ?? []).filter((v): v is string => typeof v === "string"),
      fragmentCount: typeof m.fragment_count === "number" ? m.fragment_count : 0,
      grammarVersion: typeof m.grammar_version === "number" ? m.grammar_version : 0,
      ...(typeof m.error === "string" ? { error: m.error } : {}),
      ...(typeof m.progress === "string" ? { progress: m.progress } : {}),
    };
  }

  async create(grammar: string): Promise<string> {
    const m = await this.request("create", { grammar });
    if (typeof m.state_id !== "string") throw new Error("create: no state_id");
    return m.state_id;
  }

  async add(stateId: string, fragment: string): Promise<void> {
    await this.request("add", { state_id: stateId, fragment });
  }

  async parse(stateId: string): Promise<MarpaOutcome> {
    return MarpaStateClient.outcome(await this.request("parse", { state_id: stateId }));
  }

  async extend(stateId: string, grammar: string): Promise<MarpaOutcome> {
    return MarpaStateClient.outcome(await this.request("extend", { state_id: stateId, grammar }));
  }

  terminate(): void {
    this.proc?.kill();
    this.proc = null;
  }
}