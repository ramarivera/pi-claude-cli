import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "weather",
    label: "Weather",
    description: "Return a fixed demo weather result for a city",
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
