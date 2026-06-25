import type { Candle } from "@shared/schema";

export function parseCSV(text: string): Candle[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];

  const headerLine = lines[0].toLowerCase().replace(/\r/g, "");
  const headers = headerLine.split(",").map((h) => h.trim());

  const tsIdx = headers.indexOf("timestamp");
  const openIdx = headers.indexOf("open");
  const highIdx = headers.indexOf("high");
  const lowIdx = headers.indexOf("low");
  const closeIdx = headers.indexOf("close");

  if (tsIdx === -1 || openIdx === -1 || highIdx === -1 || lowIdx === -1 || closeIdx === -1) {
    throw new Error(`CSV must have columns: timestamp, open, high, low, close. Found: ${headers.join(", ")}`);
  }

  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g, "").trim();
    if (!line) continue;
    const cols = line.split(",");
    const ts = cols[tsIdx]?.trim();
    const o = parseFloat(cols[openIdx]);
    const h = parseFloat(cols[highIdx]);
    const l = parseFloat(cols[lowIdx]);
    const c = parseFloat(cols[closeIdx]);

    if (!ts || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;

    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;

    candles.push({
      timestamp: d.toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
    });
  }

  candles.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return candles;
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
