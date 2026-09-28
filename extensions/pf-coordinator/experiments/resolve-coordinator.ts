// PromiseFlow wiring for the resolve loop. The segment identity stays
// `segmentKey(grammar, prefix)` (M15); the resolve computation is the held
// detect→extend→reparse loop, so PromiseFlow coordinates the WHOLE loop —
// N sessions at the same ambiguous prefix share one disambiguation execution.
import type { CoordinatorLike } from "../promiseflow/index.ts";
import { segmentKey } from "./segment-key.ts";
import { GRAMMAR_VERSION } from "./grammars.ts";
import { resolvePrefix, type ParseOnceClient, type ResolveOptions, type ResolveOutcome } from "./resolvable-parse.ts";

export async function coordinatedResolve(
  coordinator: CoordinatorLike,
  client: ParseOnceClient,
  grammar: string,
  prefix: string[],
  options?: ResolveOptions,
): Promise<ResolveOutcome> {
  const key = segmentKey({ version: GRAMMAR_VERSION, grammar, fragments: prefix });
  return coordinator.getOrRun(key, () => resolvePrefix(client, grammar, prefix, options));
}