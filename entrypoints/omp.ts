import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOmpAdapter } from "../src/adapters/omp/index.js";

export default function ompExtension(api: ExtensionAPI): void {
  registerOmpAdapter(api);
}
export { registerOmpAdapter };
