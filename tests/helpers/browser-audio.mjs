import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export async function browserModule(filename) {
  const path = resolve(filename);
  let source = await readFile(path, "utf8");
  for (const match of [...source.matchAll(/from "(\.\/.+?)"/g)]) {
    source = source.replace(match[0], `from "${await browserModule(resolve(dirname(path), match[1] + ".ts"))}"`);
  }
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
}
export async function chromiumRuntime() {
  return (await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright")).chromium;
}
export async function normalizeFixture(filename) {
  const chromium = await chromiumRuntime();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const bytes = await page.evaluate(async ({ moduleUrl, input }) => {
      const { normalizeAudio } = await import(moduleUrl);
      const wav = await normalizeAudio(new Blob([new Uint8Array(input)], { type: "audio/wav" }), new AbortController().signal);
      return Array.from(new Uint8Array(await wav.arrayBuffer()));
    }, { moduleUrl: await browserModule("src/features/voice-input/normalize-audio.ts"), input: Array.from(await readFile(filename)) });
    return new File([new Uint8Array(bytes)], "normalized-synthetic.wav", { type: "audio/wav" });
  } finally { await browser.close(); }
}
