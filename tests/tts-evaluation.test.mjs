import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "scripts/tts-w01-05.mjs");
const fetchMock = path.join(root, "tests/helpers/tts-delayed-fetch.mjs");

for (const provider of ["azure", "elevenlabs", "typecast"]) {
  test(`TTS evaluation CLI includes the complete delayed ${provider} audio body`, async (t) => {
    const output = await mkdtemp(path.join(tmpdir(), "sejong-tts-latency-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    const receiptPath = path.join(output, "mock-receipt.json");

    // Direct node invocation skips .env.local; use only synthetic credentials.
    const { stdout } = await execute(
      process.execPath,
      [
        "--import", fetchMock,
        cli,
        `--provider=${provider}`,
        "--case=historical-terms",
        `--out=${output}`,
      ],
      {
        cwd: root,
        timeout: 10_000,
        env: {
          TTS_TEST_PROVIDER: provider,
          TTS_TEST_RECEIPT: receiptPath,
          AZURE_SPEECH_KEY: "offline-test-key",
          AZURE_SPEECH_REGION: "koreacentral",
          ELEVENLABS_API_KEY: "offline-test-key",
          ELEVENLABS_VOICE_ID: "test-voice",
          TYPECAST_API_KEY: "offline-test-key",
          TYPECAST_VOICE_ID: "test-voice",
        },
      },
    );

    const report = JSON.parse(await readFile(path.join(output, "results.json"), "utf8"));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(report.provider, provider);
    assert.equal(report.results.length, 1);
    assert.equal(receipt.calls, 1);
    assert.ok(receipt.bodyLatencyMs >= 180, "the mock must delay the final body chunk");
    const [result] = report.results;
    assert.equal(result.id, "historical-terms");
    assert.ok(
      result.apiLatencyMs >= Math.floor(receipt.bodyLatencyMs) - 1,
      `reported ${result.apiLatencyMs} ms must include ${receipt.bodyLatencyMs} ms of body receipt`,
    );
    assert.equal(result.bytes, 8);
    assert.deepEqual(
      await readFile(path.join(output, result.filename)),
      Buffer.from([73, 68, 51, 1, 2, 3, 4, 5]),
    );
    assert.match(stdout, new RegExp(`historical-terms: ${result.apiLatencyMs} ms, 8 bytes`));
    assert.equal(result.humanScores.pronunciation, null);
  });
}
