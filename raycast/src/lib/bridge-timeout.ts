export type BridgeCommandSource = "env" | "pref_bin" | "app_bridge" | "app_main_cli" | "local" | "cargo";

export const BRIDGE_TIMEOUT_MS = 10_000;
export const CARGO_BRIDGE_TIMEOUT_MS = 120_000;

const BRIDGE_TIMEOUT_BY_SOURCE: Record<BridgeCommandSource, number> = {
  env: BRIDGE_TIMEOUT_MS,
  pref_bin: BRIDGE_TIMEOUT_MS,
  app_bridge: BRIDGE_TIMEOUT_MS,
  app_main_cli: BRIDGE_TIMEOUT_MS,
  local: BRIDGE_TIMEOUT_MS,
  cargo: CARGO_BRIDGE_TIMEOUT_MS,
};

export function bridgeTimeoutMs(source: BridgeCommandSource): number {
  return BRIDGE_TIMEOUT_BY_SOURCE[source] ?? BRIDGE_TIMEOUT_MS;
}
