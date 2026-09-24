// Refreshes the embedded fallback spec (spec/openapi.json) from the live API.
// The CLI fetches the spec at run time anyway; this copy only serves offline
// first runs, so the scheduled workflow that calls this is housekeeping.
import fs from "node:fs";

const url = `${process.env.LUDO_API_URL || "https://api.ludo.ai"}/api-documentation/openapi.json`;
const target = new URL("../spec/openapi.json", import.meta.url);

const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  console.error(`Could not fetch ${url}: HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();
const spec = JSON.parse(text);
if (!spec.paths || !spec.info?.version) {
  console.error(`${url} did not return an OpenAPI spec`);
  process.exit(1);
}
const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
if (before === text) {
  console.log(`Spec unchanged (API ${spec.info.version})`);
} else {
  fs.writeFileSync(target, text);
  console.log(`Spec updated (API ${spec.info.version}, ${Object.keys(spec.paths).length} paths)`);
}
