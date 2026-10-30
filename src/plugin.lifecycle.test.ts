import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import { createMemoryStorage } from "./cache.js";
import { ModelDiscoveryPlugin } from "./plugin.js";

type Transform = Parameters<Context["model"]["transform"]>[0];
type Source = {
  provider: { id: string; name: string; settings: Record<string, unknown>; headers?: Record<string, string> };
  models: Map<string, never>;
  sourceConnection?: { id: string };
};

type Harness = {
  source: Source;
  replay: () => Map<string, Record<string, unknown>>;
  reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
  cleanup: () => void;
  output: () => Map<string, Record<string, unknown>>;
  setSources: (value: Source[]) => void;
};

async function harness(): Promise<Harness> {
  let transform: Transform | undefined;
  const source: Source = {
    provider: { id: "gateway", name: "Gateway", settings: {
      baseURL: "https://old.example/v1", apiKey: "old-key",
      "opencode-model-discovery": { discovery: true, discoveryCache: "PT1H" },
    } },
    models: new Map(),
  };
  let sources = [source];
  let output = new Map<string, Record<string, unknown>>();
  const replay = (): Map<string, Record<string, unknown>> => {
    // The host replays onto fresh drafts, not the last transform's output.
    output = new Map();
    transform?.({
      provider: { list: () => sources, get: (id: string) => sources.find((s) => s.provider.id === id) },
      update: (providerID: string, id: string, update: (draft: Record<string, unknown>) => void) => {
        const draft = {};
        update(draft);
        output.set(`${providerID}/${id}`, draft);
      },
    } as never);
    return output;
  };
  const reload = vi.fn(async () => { replay(); });
  const cleanup = await ModelDiscoveryPlugin({
    provider: { transform: vi.fn() },
    model: { transform: vi.fn(async (cb: Transform) => { transform = cb; }), reload },
    storage: createMemoryStorage(),
  } as unknown as Context);
  return { source, replay, reload, cleanup, output: () => output, setSources: (value: Source[]) => { sources = value; } };
}

function inventory(id: string): Response {
  return Response.json({ data: [{ id }] });
}

// Drain promise-based discovery without advancing retry/cache clocks.
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("V2 discovery lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["endpoint", "discovery endpoint", "auth", "options", "headers", "source connection"])(
    "invalidates completed inventory and its cache when %s changes", async (change) => {
      let id = "old";
      const fetchMock = vi.fn(async (url: string) => url.includes("/models") ? inventory(id) : Response.json({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const h = await harness();
      h.replay();
      await settle();
      expect([...h.output().keys()]).toEqual(["gateway/old"]);
      const settings = h.source.provider.settings;
      id = "new";
      switch (change) {
        case "endpoint": settings.baseURL = "https://new.example/v1"; break;
        case "discovery endpoint": settings["opencode-model-discovery"] = { discovery: true, discoveryCache: "PT1H", discoveryBaseURL: "https://discovery.example" }; break;
        case "auth": settings.apiKey = "new-key"; break;
        case "options": settings["opencode-model-discovery"] = { discovery: true, discoveryCache: "PT1H", enrichExistingModels: true }; break;
        case "headers": h.source.provider.headers = { "X-Tenant": "new" }; break;
        case "source connection": h.source.sourceConnection = { id: "new-connection" }; break;
      }
      expect(h.replay().size).toBe(0);
      h.replay(); // An in-flight replay must not duplicate requests.
      await settle();
      expect([...h.output().keys()]).toEqual(["gateway/new"]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(h.reload).toHaveBeenCalledTimes(2);
      if (change === "endpoint") expect(fetchMock.mock.calls[2][0]).toContain("https://new.example/");
      if (change === "discovery endpoint") expect(fetchMock.mock.calls[2][0]).toContain("https://discovery.example/");
      h.cleanup();
    },
  );

  it("reuses inventory for equivalent settings regardless of object identity/key order", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("/models") ? inventory("old") : Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.replay();
    await settle();
    h.source.provider.settings = {
      "opencode-model-discovery": { discoveryCache: "PT1H", discovery: true },
      apiKey: "old-key", baseURL: "https://old.example/v1",
    };
    expect([...h.replay().keys()]).toEqual(["gateway/old"]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.reload).toHaveBeenCalledOnce();
    h.cleanup();
  });

  it("supports callable adapter settings and detects replacement by identity", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("/models") ? inventory("model") : Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.source.provider.settings.fetch = () => "first";
    h.replay();
    await settle();
    h.replay();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    h.source.provider.settings.fetch = () => "second";
    expect(h.replay().size).toBe(0);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    h.cleanup();
  });

  it.each(["disable", "remove"])("drops completed inventory on %s and discovers again when restored", async (change) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/models") ? inventory("old") : Response.json({ data: [] })));
    const h = await harness();
    h.replay();
    await settle();
    if (change === "disable") h.source.provider.settings["opencode-model-discovery"] = { discovery: false };
    else h.setSources([]);
    expect(h.replay().size).toBe(0);
    await settle();
    expect(h.reload).toHaveBeenCalledOnce();
    h.source.provider.settings["opencode-model-discovery"] = { discovery: true };
    h.setSources([h.source]);
    h.replay();
    await settle();
    expect([...h.output().keys()]).toEqual(["gateway/old"]);
    expect(h.reload).toHaveBeenCalledTimes(2);
    h.cleanup();
  });

  it("recovers on a later replay with backoff and never reloads on failure", async () => {
    let healthy = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (!healthy) throw new Error("transient outage");
      return url.includes("/models") ? inventory("recovered") : Response.json({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.replay();
    await settle();
    for (let i = 0; i < 10; i++) h.replay();
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    h.replay();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    h.replay();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2); // Second backoff is two seconds.
    healthy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    h.replay();
    await settle();
    expect([...h.output().keys()]).toEqual(["gateway/recovered"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(h.reload).toHaveBeenCalledOnce();
    h.cleanup();
  });

  it("refreshes expired inventory on replay without timer-driven requests", async () => {
    let id = "old";
    const fetchMock = vi.fn(async (url: string) => url.includes("/models") ? inventory(id) : Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.source.provider.settings["opencode-model-discovery"] = { discovery: true, discoveryCache: "PT1S" };
    h.replay();
    await settle();
    id = "fresh";
    await vi.advanceTimersByTimeAsync(1_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.replay().size).toBe(0);
    await settle();
    expect([...h.output().keys()]).toEqual(["gateway/fresh"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(h.reload).toHaveBeenCalledTimes(2);
    h.cleanup();
  });

  it("caps retry backoff at one minute and does not retry without a replay", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.replay();
    await settle();
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      h.replay();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      h.replay();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(h.reload).not.toHaveBeenCalled();
    h.cleanup();
  });

  it("treats an empty successful inventory as success rather than retrying", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.source.provider.settings["opencode-model-discovery"] = { discovery: true };
    h.replay();
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.replay().size).toBe(0);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.reload).toHaveBeenCalledOnce();
    h.cleanup();
  });

  it("cannot publish old metadata after a replacement discovery finishes", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("https://old.example")) {
        return url.includes("/models") ? inventory("old") : pending.promise;
      }
      return url.includes("/models") ? inventory("new") : Response.json({ data: [] });
    }));
    const h = await harness();
    h.replay();
    await settle();
    h.source.provider.settings.baseURL = "https://new.example/v1";
    h.replay();
    await settle();
    expect([...h.output().keys()]).toEqual(["gateway/new"]);
    pending.resolve(Response.json({ data: [] }));
    await settle();
    expect([...h.replay().keys()]).toEqual(["gateway/new"]);
    expect(h.reload).toHaveBeenCalledOnce();
    h.cleanup();
  });

  it.each(["change", "disable", "remove", "unload"])("ignores late completion after %s even if fetch ignores cancellation", async (change) => {
    const pending = Promise.withResolvers<Response>();
    let oldSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://old.example") && url.includes("/models")) {
        oldSignal = init.signal ?? undefined;
        return pending.promise;
      }
      return url.includes("/models") ? inventory("new") : Response.json({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = await harness();
    h.replay();
    await settle();
    if (change === "change") h.source.provider.settings.baseURL = "https://new.example/v1";
    if (change === "disable") h.source.provider.settings["opencode-model-discovery"] = { discovery: false };
    if (change === "remove") h.setSources([]);
    if (change === "unload") h.cleanup();
    h.replay();
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(inventory("stale"));
    await settle();
    expect([...h.replay().keys()]).toEqual(change === "change" ? ["gateway/new"] : []);
    expect(h.reload).toHaveBeenCalledTimes(change === "change" ? 1 : 0);
    // The superseded request must not advance to optional metadata.
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith("https://old.example"))).toHaveLength(1);
    h.cleanup();
  });
});
