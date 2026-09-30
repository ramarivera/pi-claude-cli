import type {
  AuthConfig,
  DriverFactoryOptions,
} from "../../contracts/index.js";

const credentialOverrides = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/** The official runtime reads the selected login directory itself. */
export function sdkEnvironment(
  auth: AuthConfig,
  environment: DriverFactoryOptions["environment"],
): Record<string, string | undefined> {
  const env = { ...process.env, ...environment };
  if (auth.mode === "claude-login") {
    const conflicts = credentialOverrides.filter((name) => env[name]);
    if (conflicts.length) {
      throw new Error(
        `Claude login conflicts with environment overrides: ${conflicts.join(", ")}`,
      );
    }
  } else {
    if (!auth.apiKey.trim()) throw new Error("Explicit API key is empty");
    for (const name of credentialOverrides) delete env[name];
    env.ANTHROPIC_API_KEY = auth.apiKey;
    if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl;
  }
  return env;
}
