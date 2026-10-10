import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";

export const defaultSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

export function approved(text = "백성이 쉽게 글을 쓰도록 한글을 만들었단다.") {
  return {
    status: "approved", operation: "turn",
    answer: {
      answerId: "answer-1", kind: "conversation", text, factIds: [],
      sources: [{ id: "source-1", title: "훈민정음", institution: "국립한글박물관", url: "https://example.org/hangul" }],
      personaVersion: "test", contentVersion: "test",
    },
  };
}

// Only the network boundary is replaced. The component, API response handling,
// and archive serialization are transpiled unchanged from the selected tree.
function network() {
  const calls = [];
  const plans = new Map();
  function enqueue(method, url, response) {
    const key = `${method} ${url}`;
    if (!plans.has(key)) plans.set(key, []);
    plans.get(key).push(response);
  }
  async function fetch(url, options) {
    const call = {
      url, method: options.method, signal: options.signal,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(call);
    const queue = plans.get(`${call.method} ${url}`);
    let result;
    if (queue?.length) {
      result = await queue.shift();
    } else if (url === "/api/sessions" && call.method === "POST") {
      result = { status: "created", sessionId: `session-${calls.length}`, intro: "새 세션의 인사란다.", suggestedQuestions: ["한글은 왜 만들었나요?", "장영실은 누구인가요?"] };
    } else if (url === "/api/sessions/current" && call.method === "DELETE") {
      result = { status: "deleted" };
    } else if (url === "/api/turns" && call.method === "POST") {
      result = approved();
    } else if (url.startsWith("/api/requests/") && call.method === "DELETE") {
      result = { status: "cancelled" };
    } else {
      throw new Error(`Unexpected request: ${call.method} ${url}`);
    }
    if (url === "/api/turns" && result.requestId === undefined) result = { ...result, requestId: call.body.requestId };
    return { ok: true, json: async () => result };
  }
  return {
    calls, fetch, enqueue,
    count: (method, url) => calls.filter((call) => call.method === method && call.url === url).length,
    deferNext(method, url) {
      const response = deferred();
      enqueue(method, url, response.promise);
      return response;
    },
  };
}

function memoryStorage() {
  const values = new Map();
  const failedWrites = new Set();
  const writes = [];
  return {
    failedWrites, writes,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes.push({ key, value, failed: failedWrites.has(key) });
      if (failedWrites.has(key)) throw new Error("QuotaExceededError");
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
}

// A root-component hook runner, not a browser renderer. State updates are
// batched until flush(); refs update synchronously, and effects clean up on
// dependency changes/unmount. Keeping the old JSX handlers allows race tests
// to fire an event before React would commit the next render.
function hookRunner() {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial, updates: [] };
      const slot = slots[index];
      for (const update of slot.updates.splice(0)) slot.value = typeof update === "function" ? update(slot.value) : update;
      return [slot.value, (update) => { slot.updates.push(update); dirty = true; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps === undefined || deps.length !== previous.deps?.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  return {
    react,
    render(component) {
      let tree;
      let commits = 0;
      while (dirty) {
        if (++commits > 50) throw new Error("Hook runner did not settle");
        cursor = 0;
        dirty = false;
        effects = [];
        tree = component();
        for (const effect of effects) effect();
      }
      return tree;
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

export function textContent(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return textContent(node.props?.children);
}

function descendants(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) descendants(child, predicate, found);
  } else if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    descendants(node.props?.children, predicate, found);
  }
  return found;
}

export function mountChat({ sourceRoot = process.env.CHAT_LIFECYCLE_SOURCE_ROOT ?? defaultSourceRoot } = {}) {
  const hooks = hookRunner();
  const api = network();
  const storage = memoryStorage();
  const listeners = new Map();
  const window = {
    localStorage: storage, location: { search: "" },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const context = createContext({
    window, fetch: api.fetch, AbortController, URLSearchParams, crypto: webcrypto,
    setTimeout, clearTimeout, process: { env: { NODE_ENV: "test" } },
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  });
  const cache = new Map();
  function load(filename) {
    const path = resolve(sourceRoot, filename);
    if (cache.has(path)) return cache.get(path).exports;
    const loaded = { exports: {} };
    cache.set(path, loaded);
    const { outputText, diagnostics } = ts.transpileModule(readFileSync(path, "utf8"), {
      fileName: path, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    if (diagnostics.some((entry) => entry.category === ts.DiagnosticCategory.Error)) throw new Error(`Cannot transpile ${path}`);
    const require = (name) => {
      if (name === "react") return hooks.react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol.for("chat-test-fragment") };
      if (name === "next/image") return { __esModule: true, default: "img" };
      if (name.startsWith(".")) return load(resolve(dirname(path), `${name}.ts`));
      throw new Error(`Unexpected dependency: ${name}`);
    };
    runInContext(`(function(require, module, exports) {\n${outputText}\n})`, context, { filename: path })(require, loaded, loaded.exports);
    return loaded.exports;
  }
  const { ChatExperience } = load("src/features/chat/ChatExperience.tsx");
  const archives = load("src/features/chat/chat-history.ts");
  let tree;
  const app = {
    api, storage, historyKey: archives.CHAT_HISTORY_KEY,
    flush() { tree = hooks.render(ChatExperience) ?? tree; return tree; },
    async settle() {
      // Drain the finite fetch/json/API/component promise chain without timers.
      // Deliberately deferred requests remain pending until the test resolves them.
      for (let i = 0; i < 20; i++) { await Promise.resolve(); app.flush(); }
    },
    all(predicate) { return descendants(tree, predicate); },
    one(predicate) {
      const matches = app.all(predicate);
      if (matches.length !== 1) throw new Error(`Expected one rendered element; found ${matches.length}`);
      return matches[0];
    },
    button(label) { return app.one((node) => node.type === "button" && (node.props["aria-label"] === label || textContent(node).trim() === label)); },
    click(label) {
      const button = app.button(label);
      if (button.props.disabled) throw new Error(`Button is disabled: ${label}`);
      const result = button.props.onClick();
      app.flush();
      return result;
    },
    textarea() { return app.one((node) => node.type === "textarea" && node.props.id === "question"); },
    form() { return app.one((node) => node.type === "form"); },
    type(value) {
      const textarea = app.textarea();
      if (textarea.props.disabled) throw new Error("Question input is disabled");
      textarea.props.onChange({ target: { value } });
      app.flush();
    },
    submit() { app.form().props.onSubmit({ preventDefault() {} }); app.flush(); },
    isChat() { return app.all((node) => node.type === "textarea").length === 1; },
    questions() {
      return app.all((node) => node.type === "div" && node.props.className === "message student-message")
        .map((node) => textContent(descendants(node, (child) => child.type === "p")[0]));
    },
    savedChats() { return structuredClone(archives.readSavedChats(storage)); },
    otherTabStorage(key, newValue = null) {
      const oldValue = storage.getItem(key);
      if (newValue === null) storage.removeItem(key);
      else storage.setItem(key, newValue);
      for (const listener of [...(listeners.get("storage") ?? [])]) listener({ key, oldValue, newValue, storageArea: storage, url: "https://example.org/other-tab" });
      app.flush();
    },
    dispose: () => hooks.dispose(),
  };
  app.flush();
  return app;
}
