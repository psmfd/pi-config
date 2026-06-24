/**
 * indexing/state.ts — persisted toggle + output caps for the indexing extension.
 *
 * Delegates to shared/state.ts (schema-versioned JSON under
 * ~/.pi/agent/extensions/indexing/state.json, ADR-0019/ADR-0030). `enabled`
 * governs ONLY the agent_end background re-index — the search_codebase tool is
 * always available regardless, querying whatever index exists. Hand-edited
 * nonsensical caps are repaired to defaults on load.
 */

import { loadState, saveState } from "../shared/state.ts";

const NAMESPACE = "indexing";

export interface IndexingState {
  /** Whether agent_end triggers a background `ccc index` (the `--index` flag also enables). */
  readonly enabled: boolean;
  /** Default number of search hits requested + rendered. */
  readonly maxResults: number;
  /** Per-result character cap applied when framing hits for the model. */
  readonly maxResultChars: number;
}

export const DEFAULT_STATE: IndexingState = {
  enabled: true,
  maxResults: 8,
  maxResultChars: 2000,
};

export async function load(agentDir?: string): Promise<IndexingState> {
  const loaded = await loadState<IndexingState>(NAMESPACE, DEFAULT_STATE, agentDir);
  const maxResults =
    typeof loaded.maxResults === "number" && loaded.maxResults > 0
      ? Math.trunc(loaded.maxResults)
      : DEFAULT_STATE.maxResults;
  const maxResultChars =
    typeof loaded.maxResultChars === "number" && loaded.maxResultChars > 0
      ? Math.trunc(loaded.maxResultChars)
      : DEFAULT_STATE.maxResultChars;
  return { enabled: loaded.enabled === true, maxResults, maxResultChars };
}

export async function save(state: IndexingState, agentDir?: string): Promise<void> {
  await saveState<IndexingState>(NAMESPACE, state, agentDir);
}
