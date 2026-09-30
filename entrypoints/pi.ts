import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiAdapter } from "../src/adapters/pi/index.js";

export default function piClaudeExtension(pi: ExtensionAPI): void {
  registerPiAdapter(pi);
}
export { registerPiAdapter };
