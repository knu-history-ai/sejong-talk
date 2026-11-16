import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { textContent } from "./chat-lifecycle.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function descendants(node, predicate, found = []) {
  if (Array.isArray(node)) node.forEach((child) => descendants(child, predicate, found));
  else if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    descendants(node.props?.children, predicate, found);
  }
  return found;
}

// Like chat-lifecycle.mjs, this runs hooks without a DOM. It also executes the
// real player, playback hook/controller, speech client and microphone button.
// Only HTTP, Audio and the hardware recorder are replaced; nothing calls Azure.
export function createChatAudioHarness({ playGate, rejectPlay = false } = {}) {
  let activeHost;
  const changedDeps = (previous, deps) => !previous || deps === undefined ||
    deps.length !== previous.deps?.length || deps.some((value, i) => !Object.is(value, previous.deps[i]));
  function createHost(component, props = {}) {
    const host = {
      component, props, slots: [], dirty: true, alive: true,
      flush() {
        let commits = 0;
        while (host.dirty && host.alive) {
          if (++commits > 50) throw new Error("Hook runner did not settle");
          host.cursor = 0; host.effects = []; host.dirty = false; activeHost = host;
          host.tree = host.component(host.props);
          activeHost = null;
          for (const slot of host.effects.sort((a, b) => Number(b.layout) - Number(a.layout))) {
            slot.cleanup?.(); slot.cleanup = slot.create();
          }
        }
        return host.tree;
      },
      update(props) { host.props = props; host.dirty = true; host.flush(); },
      strictCycle() {
        const effects = host.slots.filter((slot) => slot.effect)
          .sort((a, b) => Number(b.layout) - Number(a.layout));
        effects.forEach((slot) => slot.cleanup?.());
        effects.forEach((slot) => { slot.cleanup = slot.create(); });
        host.flush();
      },
      dispose() { host.alive = false; host.slots.forEach((slot) => slot.cleanup?.()); },
    };
    return host;
  }
  const react = {
    useState(initial) {
      const host = activeHost, index = host.cursor++;
      const slot = host.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slot.value, (update) => {
        const value = typeof update === "function" ? update(slot.value) : update;
        if (!Object.is(value, slot.value)) { slot.value = value; host.dirty = true; }
      }];
    },
    useRef(initial) { return activeHost.slots[activeHost.cursor++] ??= { current: initial }; },
    useCallback(fn, deps) {
      const host = activeHost, index = host.cursor++;
      if (changedDeps(host.slots[index], deps)) host.slots[index] = { fn, deps };
      return host.slots[index].fn;
    },
    useEffect(create, deps) { effect(create, deps); },
    useImperativeHandle(ref, create, deps) {
      effect(() => {
        if (!ref) return;
        const assign = (value) => { if (typeof ref === "function") ref(value); else ref.current = value; };
        assign(create());
        return () => assign(null);
      }, deps === undefined ? undefined : [...deps, ref], true);
    },
  };
  function effect(create, deps, layout = false) {
    const host = activeHost, index = host.cursor++, previous = host.slots[index];
    if (changedDeps(previous, deps)) {
      const slot = { effect: true, create, deps, layout, cleanup: previous?.cleanup };
      host.slots[index] = slot; host.effects.push(slot);
    }
  }

  const audios = [], urls = new Set(), revoked = [], recorders = [], calls = [], plans = new Map();
  class Audio {
    constructor(url) {
      Object.assign(this, { url, currentTime: 0, playbackRate: 1, playing: false, pauseCalls: 0, playCalls: 0, version: 0 });
      audios.push(this);
    }
    play() {
      this.playCalls += 1;
      const version = ++this.version;
      if (rejectPlay) { rejectPlay = false; return Promise.reject(new Error("NotAllowedError")); }
      const started = () => { if (this.version === version) this.playing = true; };
      if (playGate) return playGate.promise.then(started);
      started(); return Promise.resolve();
    }
    pause() { this.pauseCalls += 1; this.version += 1; this.playing = false; }
  }
  class VoiceRecorder {
    constructor(onChange, onTranscript) {
      this.onChange = onChange; this.onTranscript = onTranscript; this.state = "idle"; recorders.push(this);
    }
    phase(phase) { this.state = phase; this.onChange({ phase, elapsedMs: 0, message: "" }); }
    isBusy() { return ["permission", "recording", "stopping", "transcribing"].includes(this.state); }
    start() {
      this.audioAtOpen = audios.some((audio) => audio.playing);
      this.urlsAtOpen = urls.size;
      this.phase("permission");
    }
    stop() { this.phase("transcribing"); }
    cancel() { this.phase("idle"); }
    finish(text) { this.onTranscript(text); this.phase("review"); }
    expire() { this.state = "error"; this.onChange({ phase: "error", code: "SESSION_EXPIRED", elapsedMs: 0, message: "만료" }); }
    dispose() { this.disposed = true; }
  }
  let answerId = 0, objectUrl = 0;
  const api = {
    calls,
    enqueue(method, url, response, ignoreAbort = false) {
      const key = `${method} ${url}`;
      if (!plans.has(key)) plans.set(key, []);
      plans.get(key).push({ response, ignoreAbort });
    },
    defer(method, url, { ignoreAbort = false } = {}) {
      const result = deferred(); api.enqueue(method, url, result.promise, ignoreAbort); return result;
    },
    count: (url) => calls.filter((call) => call.url === url).length,
  };
  async function fetch(url, options = {}) {
    const method = options.method ?? "GET", input = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, input, signal: options.signal });
    const plan = plans.get(`${method} ${url}`)?.shift();
    async function respond() {
      if (plan) {
        let response = await plan.response;
        if (response instanceof Response) return response;
        if (url === "/api/turns") response = { ...response, requestId: input.requestId };
        return Response.json(response);
      }
      if (url === "/api/speech") return Response.json({
        ...input, operation: "speech", status: "completed",
        audio: { url: `/api/speech/audio/${input.answerId}`, mimeType: "audio/wav", expiresAt: new Date(Date.now() + 60000).toISOString() },
      });
      if (url.startsWith("/api/speech/audio/")) return new Response(new Blob(["test"], { type: "audio/wav" }), { headers: { "content-type": "audio/wav" } });
      if (url === "/api/sessions") return Response.json({ status: "created", sessionId: "session-1", intro: "인사", suggestedQuestions: ["질문"] });
      if (url === "/api/sessions/current") return Response.json({ status: "deleted" });
      if (url === "/api/turns") return Response.json({ status: "approved", operation: "turn", requestId: input.requestId,
        answer: { answerId: `answer-${++answerId}`, kind: "conversation", text: "승인된 답변", sources: [], factIds: [], personaVersion: "test", contentVersion: "test" } });
      if (url.startsWith("/api/requests/")) return Response.json({ status: "cancelled" });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    if (!options.signal || plan?.ignoreAbort) return respond();
    options.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener("abort", abort, { once: true });
      respond().then(resolve, reject).finally(() => options.signal.removeEventListener("abort", abort));
    });
  }
  const storage = new Map(), listeners = new Map();
  const window = {
    location: { search: "" },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const context = createContext({
    window, document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    Audio, fetch, AbortController, URLSearchParams, Blob, Response, crypto: webcrypto,
    URL: { createObjectURL() { const url = `blob:test-${++objectUrl}`; urls.add(url); return url; }, revokeObjectURL(url) { revoked.push(url); urls.delete(url); } },
    setTimeout, clearTimeout, process: { env: { NODE_ENV: "test" } },
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
  });
  const cache = new Map();
  function load(filename) {
    let path = resolve(sourceRoot, filename);
    if (!existsSync(path)) path += existsSync(`${path}.ts`) ? ".ts" : ".tsx";
    if (cache.has(path)) return cache.get(path).exports;
    const loaded = { exports: {} }; cache.set(path, loaded);
    const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), { fileName: path,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
    function require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol.for("chat-audio-test-fragment") };
      if (name === "next/image") return { __esModule: true, default: "img" };
      if (path.endsWith("chat-voice-button.tsx") && name === "./recorder") return { VoiceRecorder, MAX_RECORDING_MS: 20_000 };
      if (path.endsWith("chat-voice-button.tsx") && name === "./transcription") return { serverTranscribe() { throw new Error("Use the controlled recorder"); } };
      if (name.startsWith(".")) return load(resolve(dirname(path), name));
      throw new Error(`Unexpected dependency: ${name}`);
    }
    runInContext(`(function(require,module,exports){\n${outputText}\n})`, context, { filename: path })(require, loaded, loaded.exports);
    return loaded.exports;
  }
  const { ChatAnswerAudio } = load("src/features/voice-output/chat-answer-audio.tsx");
  const { ChatVoiceButton } = load("src/features/voice-input/chat-voice-button.tsx");
  const flushPromises = async (flush) => { for (let i = 0; i < 8; i++) { await new Promise((resolve) => setImmediate(resolve)); flush(); } };

  function mountAnswer(props = {}) {
    const host = createHost(ChatAnswerAudio, { answerId: "answer-1", speed: 1, ...props }); host.flush();
    return {
      host,
      button: () => descendants(host.tree, (node) => node.type === "button")[0],
      text: () => textContent(host.tree),
      alerts: () => descendants(host.tree, (node) => node.props?.role === "alert"),
      click() { this.button().props.onClick(); host.flush(); },
      update(props) { host.update({ ...host.props, ...props }); },
      settle: () => flushPromises(() => host.flush()),
      dispose: () => host.dispose(),
    };
  }
  function mountChat() {
    const main = createHost(load("src/features/chat/ChatExperience.tsx").ChatExperience);
    const children = new Map();
    const app = {
      flush() {
        for (let i = 0; i < 10; i++) {
          const parentChanged = main.dirty;
          main.flush();
          for (const type of [ChatAnswerAudio, ChatVoiceButton]) {
            const node = descendants(main.tree, (node) => node.type === type)[0];
            let child = children.get(type);
            if (!node) { child?.host.dispose(); children.delete(type); }
            else if (!child || child.key !== node.key) {
              child?.host.dispose(); child = { host: createHost(type, node.props), key: node.key }; children.set(type, child);
              child.host.flush();
            } else if (parentChanged) child.host.update(node.props);
            else child.host.flush();
          }
          if (!main.dirty) return;
        }
        throw new Error("Chat children did not settle");
      },
      all(predicate) { return descendants(main.tree, predicate); },
      playerButton() { return descendants(children.get(ChatAnswerAudio)?.host.tree, (node) => node.type === "button")[0]; },
      voiceButton() { return descendants(children.get(ChatVoiceButton)?.host.tree, (node) => node.type === "button")[0]; },
      button(label) {
        const found = app.all((node) => node.type === "button" && (textContent(node).trim() === label || node.props["aria-label"] === label));
        if (found.length !== 1) throw new Error(`Expected one button: ${label}, found ${found.length}`);
        return found[0];
      },
      click(label) { const result = app.button(label).props.onClick(); app.flush(); return result; },
      listen() { app.playerButton().props.onClick(); app.flush(); },
      record() { app.voiceButton().props.onClick(); app.flush(); },
      autoListen(checked) { app.all((node) => node.props?.role === "switch")[0].props.onChange({ target: { checked } }); app.flush(); },
      type(value) { app.all((node) => node.type === "textarea")[0].props.onChange({ target: { value } }); app.flush(); },
      submit() { app.all((node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} }); app.flush(); },
      async start() { app.click("세종대왕 만나기"); await app.settle(); },
      async ask(text = "질문") { app.type(text); app.submit(); await app.settle(); },
      settle: () => flushPromises(() => app.flush()),
      text: () => textContent(main.tree),
      storageEvent(key, newValue = "other-tab") { listeners.get("storage")?.forEach((fn) => fn({ key, newValue })); app.flush(); },
      dispose() { for (const child of children.values()) child.host.dispose(); main.dispose(); },
    };
    app.flush(); return app;
  }
  return { api, audios, urls, revoked, recorders, mountAnswer, mountChat };
}
