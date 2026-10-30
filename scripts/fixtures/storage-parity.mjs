import assert from "node:assert/strict";
import { createMemoryStorage } from "../../dist/opencode-model-discovery.js";

// Runs against the actual plugin storage domain, including its namespace wrapper.
export async function checkStorageParity(host) {
  const memory = createMemoryStorage();
  let scans = 0;
  const set = async (key) => {
    await host.set(key, { id: key });
    await memory.set(key, { id: key });
  };
  const remove = async (key) => {
    await host.remove(key);
    await memory.remove(key);
  };
  const scan = async (options) => {
    const actual = await host.scan(options);
    assert.deepEqual(await memory.scan(options), actual, `Storage parity: ${JSON.stringify(options)}`);
    scans++;
    return actual;
  };
  const traverse = async (prefix, limit, expected) => {
    const seen = [];
    let after;
    for (let count = 0; count <= expected.length; count++) {
      const page = await scan({ prefix, after, ...(limit === undefined ? {} : { limit }) });
      seen.push(...page.entries.map(({ key }) => key));
      assert.equal(page.next, seen.length < expected.length ? seen.at(-1) : undefined);
      if (page.next === undefined) break;
      after = page.next;
    }
    assert.deepEqual(seen, expected);
  };

  // Literal prefixes (not LIKE patterns), empty keys/cursors, and Unicode beyond
  // the BMP verify SQLite ordering rather than assuming JS string order.
  const unicode = ["", "%", "_", "a", "á", "\uE000", "😀", "😀a", "\u{10FFFF}", "\u{10FFFF}a"];
  for (const key of [...unicode].reverse()) await set(key);
  await traverse("", 1, unicode);
  for (const prefix of ["%", "_", "😀", "\u{10FFFF}", "missing"])
    await traverse(prefix, 1, unicode.filter((key) => key.startsWith(prefix)));
  await scan({ prefix: "", after: "", limit: 1 });
  await scan({ prefix: "", after: "\uFFFF", limit: 1 });
  await remove("\uE000");
  await scan({ prefix: "", after: "\uE000", limit: 1 });
  for (const key of unicode) await remove(key);

  const keys = Array.from({ length: 1105 }, (_, i) => `scan-probe:${String(i).padStart(4, "0")}`);
  for (const key of [...keys].reverse()) await set(key);
  await set("outside-prefix");
  for (const [limit, size] of [[undefined, 100], [0, 1], [-1, 1], [0.5, 1], [2.9, 2],
    [NaN, 100], [Infinity, 1000], [-Infinity, 1], [1001, 1000], [1000, 1000]]) {
    const page = await scan({ prefix: "scan-probe:", ...(limit === undefined ? {} : { limit }) });
    assert.equal(page.entries.length, size, `Host limit ${limit}`);
    assert.equal(page.next, keys[size - 1]);
  }
  for (const limit of [undefined, 2.9, Infinity]) await traverse("scan-probe:", limit, keys);
  for (const after of ["outside-prefix", "scan-probe:0000a", "scan-probe:1104", "z"])
    await scan({ prefix: "scan-probe:", after, limit: 1 });
  await remove(keys[0]);
  await scan({ prefix: "scan-probe:", after: keys[0], limit: 1 });
  for (const key of keys) await remove(key);
  await remove("outside-prefix");
  await scan({ prefix: "" });
  return { scans };
}
