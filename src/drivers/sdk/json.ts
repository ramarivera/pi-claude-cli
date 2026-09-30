import type { JsonObject, JsonValue } from "../../contracts/index.js";

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  throw new Error("SDK protocol value is not JSON");
}

export function jsonObject(value: unknown): JsonObject {
  const json = jsonValue(value);
  if (!json || Array.isArray(json) || typeof json !== "object")
    throw new Error("SDK protocol value must be a JSON object");
  return json;
}

/** Object-key order does not make equivalent callbacks conflict. */
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
