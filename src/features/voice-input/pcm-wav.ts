export const PCM_RATE = 16_000;
export const PCM_MAX_SAMPLES = PCM_RATE * 30;

/** Actual signed PCM16 little-endian WAV, not a renamed compressed file. */
export function encodePcmWav(samples: Float32Array): ArrayBuffer {
  if (!samples.length || samples.length > PCM_MAX_SAMPLES) throw new Error("음성은 0초보다 길고 30초 이하여야 해요.");
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, PCM_RATE, true); view.setUint32(28, PCM_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

/** Validate actual RIFF chunks and derive duration from data bytes on the server. */
export function inspectPcmWav(buffer: ArrayBuffer) {
  const invalid = () => new Error("Azure에는 16kHz 모노 PCM16 WAV 음성이 필요해요. 다시 녹음해 주세요.");
  if (buffer.byteLength < 44 || buffer.byteLength > 5_000_000) throw invalid();
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(buffer, offset, length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== buffer.byteLength) throw invalid();
  let format = false;
  let dataOffset = 0;
  let dataBytes = 0;
  for (let offset = 12; offset < buffer.byteLength;) {
    if (offset + 8 > buffer.byteLength) throw invalid();
    const tag = ascii(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > buffer.byteLength) throw invalid();
    if (tag === "fmt ") {
      if (format || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 || view.getUint32(start + 4, true) !== PCM_RATE || view.getUint32(start + 8, true) !== PCM_RATE * 2 || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw invalid();
      format = true;
    }
    if (tag === "data") { if (dataOffset) throw invalid(); dataOffset = start; dataBytes = size; }
    offset = start + size + size % 2;
    if (offset > buffer.byteLength) throw invalid();
  }
  if (!format || !dataOffset || !dataBytes || dataBytes % 2 || dataBytes / 2 > PCM_MAX_SAMPLES) throw invalid();
  return { sampleRate: PCM_RATE, channels: 1, bitsPerSample: 16, durationMs: dataBytes / 32, dataOffset, dataBytes };
}
