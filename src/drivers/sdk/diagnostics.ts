import type { AuthConfig, RuntimeError } from "../../contracts/index.js";

export function sdkError(
  error: unknown,
  auth: AuthConfig,
  env: Readonly<Record<string, string | undefined>>,
  fallback: string,
): RuntimeError {
  let message =
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : fallback;
  const secrets = [
    auth.mode === "api-key" ? auth.apiKey : undefined,
    ...Object.entries(env)
      .filter(([name]) =>
        /key|token|secret|password|credential|authorization/i.test(name),
      )
      .map(([, value]) => value),
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets)
    message = message.split(secret).join("[redacted]");
  message = message
    .replace(/\b(?:Bearer\s+\S+|sk-(?:ant-)?[A-Za-z0-9_-]+)/gi, "[redacted]")
    .replace(
      /\b((?:api[_-]?key|auth[_-]?token|oauth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
      "$1[redacted]",
    )
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "[redacted-url]";
      }
    });
  message = Array.from(message, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .slice(0, 1000);
  const subtype =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[\w-]{1,64}$/.test(error.code) &&
    !secrets.some((secret) => error.code === secret)
      ? error.code
      : undefined;
  return { code: "transport", message: message || fallback, subtype };
}
