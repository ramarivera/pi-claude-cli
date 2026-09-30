import assert from "node:assert/strict";

/** Fixture-specific proof; native edit accepts paired wrappers or no wrappers. */
export function hashlineProof(events, fileBytes) {
  const matching = (type, toolName) =>
    events.filter(
      (event) => event.type === type && event.data.toolName === toolName,
    );
  const reads = matching("tool-end", "read");
  const starts = matching("tool-start", "edit");
  const ends = matching("tool-end", "edit");
  assert.equal(reads.length, 1, "Expected exactly one native read");
  assert.equal(reads[0].data.isError, false, "Native read failed");
  assert.equal(starts.length, 1, "Expected exactly one native hashline edit");
  assert.equal(ends.length, 1, "Expected exactly one completed native edit");
  assert.equal(ends[0].data.toolCallId, starts[0].data.toolCallId);
  assert.equal(ends[0].data.isError, false, "Native edit failed");
  assert.deepEqual(Object.keys(starts[0].data.args), ["input"]);
  const patch = starts[0].data.args.input;
  assert.equal(typeof patch, "string");
  let body = patch;
  if (body.startsWith("*** Begin Patch\n")) {
    assert.match(body, /\n\*\*\* End Patch\n?$/);
    body = body
      .slice("*** Begin Patch\n".length)
      .replace(/\n\*\*\* End Patch\n?$/, "");
  }
  const match = body.match(
    /^\[((?:[^#\]\n]*\/)?fixture\.txt)#([A-Fa-f0-9]{4})\]\nPUT 1\.=1:\n\+replacement\n?$/,
  );
  assert.ok(match, "Expected one fixture hashline replacement operation");
  const tag = match[2];
  const readText = reads[0].data.result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const readHeader = readText.match(
    /^\[(?:[^#\]\n]*\/)?fixture\.txt#([A-Fa-f0-9]{4})\]\n/,
  );
  assert.ok(readHeader, "Native read didn't provide a fixture snapshot tag");
  assert.equal(
    tag.toUpperCase(),
    readHeader[1].toUpperCase(),
    "Edit tag wasn't taken from actual native read result",
  );
  assert.equal(fileBytes, "replacement\n");
  return { args: starts[0].data.args, readTag: tag, fileBytes };
}
