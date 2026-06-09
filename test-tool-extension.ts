import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "weather",
    label: "Weather",
    description: "Get the current weather for a city",
    parameters: Type.Object({
      city: Type.String({ description: "City name" }),
    }),
    async execute(_id, params) {
      return {
        content: [
          { type: "text", text: `Weather in ${params.city}: 72°F, sunny` },
        ],
        details: undefined,
      };
    },
  });
}
