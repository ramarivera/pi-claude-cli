import type { ClaudeRuntime } from "../src/contracts/index.js";
import {
  readRuntimeConfiguration,
  type RuntimeConfiguration,
} from "./config.js";

export { readRuntimeConfiguration } from "./config.js";
export type { RuntimeConfiguration } from "./config.js";

/** Dynamic driver imports keep the Pi CLI entrypoint free of OMP and SDK setup. */
export async function createConfiguredRuntime(
  configuration: RuntimeConfiguration = readRuntimeConfiguration(),
): Promise<ClaudeRuntime> {
  const { createClaudeRuntime, createClaudeEventNormalizer } =
    await import("../src/core/index.js");
  const options = {
    ...configuration.driverOptions,
    normalizerFactory: createClaudeEventNormalizer,
  };
  const driver =
    configuration.driver === "cli"
      ? (await import("../src/drivers/cli/index.js")).createCliDriver(options)
      : (await import("../src/drivers/sdk/index.js")).createSdkDriver(options);
  return createClaudeRuntime({ driver });
}
