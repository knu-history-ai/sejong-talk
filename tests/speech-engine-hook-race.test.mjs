import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { loadTs } from "./helpers/load-ts.mjs";

const hookPath = "src/features/realtime-voice/use-speech-engine-voice.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Execute the actual hook and client with the project's existing TS compiler.
// Only React's hook storage, browser resources and the SDK import are substituted.
function hookHarness(t) {
  const sdk = deferred();
  const refs = [];
  const effects = [];
  const events = [];
  const calls = { mic: 0, token: 0, session: 0, end: 0, import: 0 };
  let refIndex = 0;
  let effectIndex = 0;
  let state;
  let api;
  let callbacks;
  let mounted = true;
  let sessionReady;
  const pendingEffects = [];
  const react = {
    useRef(value) {
      const i = refIndex++;
      return refs[i] ??= { current: value };
    },
    useReducer(reducer, initial) {
      state ??= initial;
      return [state, (event) => { events.push(event); state = reducer(state, event); }];
    },
    useCallback: (callback) => callback,
    useEffect(setup, deps) {
      const i = effectIndex++;
      const previous = effects[i];
      if (!previous || deps.some((dep, j) => !Object.is(dep, previous.deps[j]))) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          effects[i] = { deps, setup, cleanup: setup() };
        });
      }
    },
  };
  const window = new EventTarget();
  window.isSecureContext = true;
  const fakeGlobals = {
    window,
    navigator: { mediaDevices: { getUserMedia: async () => {
      calls.mic += 1;
      return { getTracks: () => [{ stop() {} }] };
    } } },
    fetch: async () => { calls.token += 1; return Response.json({ token: "test-token" }); },
  };
  const descriptors = Object.fromEntries(Object.keys(fakeGlobals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(fakeGlobals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { outputText } = ts.transpileModule(readFileSync(hookPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const loaded = { exports: {} };
  const require = (name) => {
    if (name === "react") return react;
    if (name === "./speech-engine-client") return loadTs("src/features/realtime-voice/speech-engine-client.ts");
    if (name === "./voice-state") return loadTs("src/features/realtime-voice/voice-state.ts");
    if (name === "@elevenlabs/client") {
      calls.import += 1;
      // CJS transpilation wraps dynamic import in a promise. Keep it pending
      // until the test releases the module, without changing the hook's await.
      return Object.assign(sdk.promise, { __esModule: true });
    }
    throw new Error(`Unexpected test dependency: ${name}`);
  };
  new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  const render = () => {
    refIndex = effectIndex = 0;
    api = loaded.exports.useSpeechEngineVoice();
    pendingEffects.splice(0).forEach((run) => run());
    return api;
  };
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    effects.forEach((effect) => effect.cleanup?.());
  };
  t.after(async () => {
    unmount();
    await tick();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  render();
  return {
    get api() { return api; }, get state() { return state; }, get callbacks() { return callbacks; },
    calls, events, render, unmount,
    pagehide: () => window.dispatchEvent(new Event("pagehide")),
    replayMountEffect() {
      const effect = effects.at(-1);
      effect.cleanup();
      effect.cleanup = effect.setup();
    },
    delaySession: (promise) => { sessionReady = promise; },
    loadSdk({ ready = true } = {}) {
      sdk.resolve({ Conversation: { startSession: async (options) => {
        calls.session += 1;
        callbacks = options;
        if (sessionReady) await sessionReady;
        options.onConnect?.({ conversationId: "conv_test" });
        if (ready) options.onConversationMetadata?.({});
        return { endSession: async () => { calls.end += 1; options.onDisconnect?.({ reason: "user" }); } };
      } } });
    },
    rejectSdk: () => sdk.reject(new Error("synthetic import failure")),
  };
}

test("same-render double start holds a lock throughout the SDK import", async (t) => {
  const h = hookHarness(t);
  const start = h.api.start;
  const first = start();
  const second = start();
  await tick();
  const pendingPhase = h.state.phase;
  const pendingMicCalls = h.calls.mic;
  h.loadSdk();
  await Promise.all([first, second]);
  await tick();
  assert.deepEqual(h.calls, { mic: 1, token: 1, session: 1, end: 0, import: 1 });
  assert.equal(pendingPhase, "requestingMic");
  assert.equal(pendingMicCalls, 0);
  assert.equal(h.state.phase, "listening");
  await h.api.stop();
  assert.equal(h.calls.end, 1);
  assert.equal(h.state.phase, "ended");
});

test("operating hook keeps the new engine readiness gate after import", async (t) => {
  const h = hookHarness(t);
  const starting = h.api.start();
  h.loadSdk({ ready: false });
  await starting;
  await tick();
  assert.equal(h.state.phase, "connecting");
  h.callbacks.onConversationMetadata({});
  assert.equal(h.state.phase, "listening");
  assert.equal(h.state.timing.readyByFallback, false);
});

test("stop during SDK import ends immediately and prevents all late resource acquisition", async (t) => {
  const h = hookHarness(t);
  const starting = h.api.start();
  await tick();
  await h.render().stop();
  const stoppedPhase = h.state.phase;
  h.render();
  const eventCount = h.events.length;
  h.loadSdk();
  await starting;
  await tick();
  assert.deepEqual([h.calls.mic, h.calls.token, h.calls.session], [0, 0, 0]);
  assert.equal(stoppedPhase, "ended");
  assert.equal(h.events.length, eventCount);
});

for (const leave of ["unmount", "pagehide"]) {
  test(`${leave} during SDK import cancels it and rejects a retained start callback`, async (t) => {
    const h = hookHarness(t);
    const staleStart = h.api.start;
    const starting = staleStart();
    await tick();
    h[leave]();
    const eventCount = h.events.length;
    h.loadSdk();
    await starting;
    await staleStart();
    await tick();
    assert.deepEqual([h.calls.mic, h.calls.token, h.calls.session], [0, 0, 0]);
    assert.equal(h.events.length, eventCount);
  });
}

test("stop then restart ignores the older import and opens exactly one new session", async (t) => {
  const h = hookHarness(t);
  const oldStart = h.api.start();
  await tick();
  await h.render().stop();
  const newStart = h.render().start();
  const duplicate = h.api.start();
  await tick();
  h.loadSdk();
  await Promise.all([oldStart, newStart, duplicate]);
  await tick();
  assert.deepEqual([h.calls.import, h.calls.mic, h.calls.token, h.calls.session], [2, 1, 1, 1]);
  assert.equal(h.state.phase, "listening");
});

test("effect cleanup/setup cannot revive an earlier pending import", async (t) => {
  const h = hookHarness(t);
  const oldStart = h.api.start();
  await tick();
  h.replayMountEffect();
  const newStart = h.api.start();
  h.loadSdk();
  await Promise.all([oldStart, newStart]);
  await tick();
  assert.equal(h.calls.session, 1);
});

test("leave while stop awaits an SDK session closes the late handle without stale events", async (t) => {
  const h = hookHarness(t);
  const session = deferred();
  h.delaySession(session.promise);
  const starting = h.api.start();
  h.loadSdk();
  await starting;
  await tick();
  assert.equal(h.calls.session, 1);
  const stopping = h.render().stop();
  h.unmount();
  const eventCount = h.events.length;
  session.resolve();
  await stopping;
  h.callbacks.onError("synthetic late error");
  assert.equal(h.calls.end, 1);
  assert.equal(h.events.length, eventCount);
});

test("SDK import failure shows a bounded error and allows stop and retry", async (t) => {
  const h = hookHarness(t);
  const starting = h.api.start();
  h.rejectSdk();
  await starting;
  await tick();
  assert.equal(h.state.error, "connectFailed");
  await h.render().stop();
  assert.equal(h.state.phase, "ended");
  await h.render().start();
  await tick();
  assert.equal(h.state.error, "connectFailed");
  assert.equal(h.calls.token, 0);
});

test("SDK error cleanup preserves the error screen and restart gets a fresh controller", async (t) => {
  const h = hookHarness(t);
  const starting = h.api.start();
  h.loadSdk();
  await starting;
  await tick();
  h.callbacks.onError("synthetic connection failure");
  assert.equal(h.state.error, "connectFailed");
  h.render();
  await tick();
  assert.equal(h.calls.end, 1);
  assert.equal(h.state.phase, "error");
  await h.api.start();
  await tick();
  assert.equal(h.calls.session, 2);
  assert.equal(h.state.phase, "listening");
});

// Run the actual CLI/server in isolated child processes. Module hooks replace
// HTTP listening and the provider SDK, so these tests cannot make API calls.
function runScript(script, { sdk, args = [], http = false }) {
  const preload = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(name, context, next) {
        if (name === "@elevenlabs/elevenlabs-js") return { shortCircuit: true, url: "test:sdk" };
        if (${http} && name === "node:http") return { shortCircuit: true, url: "test:http" };
        return next(name, context);
      },
      load(url, context, next) {
        if (url === "test:sdk") return { shortCircuit: true, format: "module", source: ${JSON.stringify(sdk)} };
        if (url === "test:http") return { shortCircuit: true, format: "module", source: "export const createServer = () => ({ listen() {}, close(done) { done(); } });" };
        return next(url, context);
      },
    });`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, ...args], {
    env: { ...process.env, ELEVENLABS_API_KEY: "fake-key", ELEVENLABS_SPEECH_ENGINE_ID: "seng_test", REALTIME_POC_ANSWER_MODULE: "", REALTIME_POC_DEBUG: "0" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test("server onError never reads or logs provider error fields", () => {
  const result = runScript("scripts/realtime-poc/speech-engine-server.mjs", { http: true, sdk: `
    export class ElevenLabsClient {
      speechEngine = { attach: async (id, server, path, options) => {
        if (options.disableAuth || options.debug) throw new Error("auth/debug invariant failed");
        const error = new Proxy({}, { get() { throw new Error("SECRET_PROVIDER_ERROR"); } });
        options.onError(error, { conversationId: "SECRET_PROVIDER_SESSION" });
      } };
    }` });
  assert.equal(result.status, 0, result.stderr);
  const logs = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "error");
  assert.equal(logs[0].errorClass, "speech_engine_error");
  assert.ok(!`${result.stdout}${result.stderr}`.includes("SECRET_PROVIDER"));
});

for (const status of [429, "SECRET_STATUS", 999, 401.5]) {
  test(`engine CLI catch bounds status (${typeof status === "number" ? status : "string"}) and omits arbitrary error data`, () => {
    const result = runScript("scripts/realtime-poc/create-engine.mjs", {
      args: ["--ws-url=wss://example.invalid/ws", "--update=seng_test", "--apply"],
      sdk: `export class ElevenLabsClient {
        speechEngine = { update: async () => { throw {
          statusCode: ${JSON.stringify(status)},
          get message() { throw new Error("SECRET_MESSAGE_ACCESSED"); },
          toString() { return "SECRET_OBJECT"; }, body: "SECRET_BODY",
        }; } };
      }`,
    });
    assert.equal(result.status, 1);
    const expected = { errorClass: "engine_configuration_failed", ...(status === 429 ? { status } : {}) };
    assert.equal(result.stderr.trim(), `실패: ${JSON.stringify(expected)}`);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("SECRET_"));
  });
}
