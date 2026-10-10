import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const nativeRequire = createRequire(import.meta.url);
const cache = new Map();
// Execute real TypeScript with the existing compiler. Only Next's build-time
// server-only marker is replaced; all provider fetches are mocked by the tests.
export function loadTs(path) {
  let filename = resolve(path);
  if (filename.endsWith(".json")) return JSON.parse(readFileSync(filename, "utf8"));
  if (!existsSync(filename)) filename += ".ts";
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = { exports: {} }; cache.set(filename, loaded);
  const source = readFileSync(filename, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href));
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const require = (name) => name === "server-only" ? {} : name.startsWith("@/") ? loadTs(resolve("src", name.slice(2))) : name.startsWith(".") ? loadTs(resolve(dirname(filename), name)) : nativeRequire(name);
  new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  return loaded.exports;
}
