// Recognising file content passed inline as base64: in results (hydra's
// `audio_b64`) and in requests (an agent's base64 `initial_image`).

const MAGIC: [RegExp, string][] = [
  [/^ID3|^\xff[\xe0-\xff]/, ".mp3"],
  [/^RIFF.{4}WAVE/s, ".wav"],
  [/^RIFF.{4}WEBP/s, ".webp"],
  [/^OggS/, ".ogg"],
  [/^fLaC/, ".flac"],
  [/^\x89PNG/, ".png"],
  [/^GIF8/, ".gif"],
  [/^\xff\xd8/, ".jpg"],
  [/^.{4}ftyp/s, ".mp4"],
  [/^glTF/, ".glb"]
];

// ".bin" when neither the data: URI's type nor the first bytes say what it is.
export function extensionFor(buffer: Buffer, dataUrlMime?: string): string {
  if (dataUrlMime) {
    const sub = dataUrlMime.split("/")[1] || "";
    const map: Record<string, string> = { mpeg: ".mp3", mp3: ".mp3", wav: ".wav", "x-wav": ".wav", ogg: ".ogg", png: ".png", jpeg: ".jpg", webp: ".webp", mp4: ".mp4" };
    if (map[sub]) return map[sub];
  }
  const head = buffer.subarray(0, 12).toString("latin1");
  for (const [re, ext] of MAGIC) if (re.test(head)) return ext;
  return ".bin";
}

export function looksLikeBase64(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return false;
  const body = value.replace(/^data:[^,]*,/, "");
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(body.slice(0, 4096).replace(/\s+/g, ""));
}

// File content passed inline in a request: a data: URI, or bare base64 whose
// first bytes name a file type. Short strings never count.
export function isInlineFile(value: string): boolean {
  if (value.length < 512 || !looksLikeBase64(value)) return false;
  const m = /^data:([^;,]+)[^,]*,/.exec(value);
  return !!m || extensionFor(Buffer.from(value.slice(0, 64), "base64")) !== ".bin";
}
