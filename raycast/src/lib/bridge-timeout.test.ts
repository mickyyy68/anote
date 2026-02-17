import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_TIMEOUT_MS, CARGO_BRIDGE_TIMEOUT_MS, bridgeTimeoutMs, type BridgeCommandSource } from "./bridge-timeout";

test("bridgeTimeoutMs uses the default timeout for prebuilt bridge paths", () => {
  const prebuiltSources: BridgeCommandSource[] = ["env", "pref_bin", "app_bridge", "app_main_cli", "local"];
  for (const source of prebuiltSources) {
    assert.equal(bridgeTimeoutMs(source), BRIDGE_TIMEOUT_MS);
  }
});

test("bridgeTimeoutMs uses an extended timeout for cargo fallback", () => {
  assert.equal(bridgeTimeoutMs("cargo"), CARGO_BRIDGE_TIMEOUT_MS);
});
