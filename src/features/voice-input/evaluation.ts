const TERMS = ["세종", "세종대왕", "훈민정음", "훈민정음 해례본", "집현전", "장영실", "자격루", "측우기", "앙부일구"];
const compact = (value: string) => value.normalize("NFC").replace(/\s/gu, "");
export function cer(reference: string, text: string): number | null {
  const a = Array.from(reference.normalize("NFC"));
  const b = Array.from(text.normalize("NFC"));
  if (!a.length) return null;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length] / a.length;
}
export function evaluate(reference: string, text: string) {
  const terms = TERMS.filter((term) => compact(reference).includes(compact(term))).map((term) => ({ term, recognized: compact(text).includes(compact(term)) }));
  return { exactMatch: reference ? reference === text : null, cer: cer(reference, text), cerWithoutSpaces: cer(compact(reference), compact(text)), terms, termAccuracy: terms.length ? terms.filter((t) => t.recognized).length / terms.length : null };
}
