import type { Spec } from "./spec.js";

// Turns the public OpenAPI spec into `ludo <group> <command>` definitions.
//
// Groups come from the operation's tag, command names from its operationId
// with the group's own nouns removed (createImage -> image create,
// animate3DModelPreset -> model animate-preset). An operation can override its
// name with `x-cli-name` in the spec. The operationId itself always works too
// (`ludo createImage ...`), so names from the MCP tools or the API docs carry
// straight over.

export type FieldType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export interface Field {
  name: string; // wire name, e.g. image_type
  flag: string; // --image-type
  in: "body" | "query" | "path";
  type: FieldType;
  itemType?: FieldType;
  enum?: string[];
  default?: unknown;
  required: boolean;
  description: string;
  // Accepts a local file, uploaded by the CLI before the call.
  isFile: boolean;
  minimum?: number;
  maximum?: number;
}

export interface Command {
  group: string;
  name: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  credits?: string;
  fields: Field[];
  // A generation: submitted as an async job the CLI then waits on.
  isJob: boolean;
  // Used internally (createUpload); not listed in help.
  hidden: boolean;
}

const TAG_GROUPS: Record<string, string> = {
  Images: "image",
  Spritesheets: "sprite",
  Videos: "video",
  "3D Models": "model",
  Audio: "audio",
  Jobs: "jobs",
  Generations: "generations",
  Documentation: "docs",
  Authentication: "auth",
  Files: "files",
  Account: "account"
};

// Words dropped from an operationId when it is already implied by the group.
const GROUP_NOUNS: Record<string, string[]> = {
  image: ["image", "images"],
  sprite: ["sprite", "sprites", "spritesheet", "spritesheets"],
  video: ["video", "videos"],
  model: ["3d", "model", "models"],
  audio: ["audio"],
  jobs: ["api", "job", "jobs"],
  generations: ["generations"],
  docs: ["docs"],
  auth: ["endpoint"],
  files: [],
  account: ["account"]
};

// Group display order and one-line blurbs for `ludo --help`.
export const GROUP_INFO: Record<string, string> = {
  image: "Generate, edit and process images",
  sprite: "Animate sprites, poses, rotations and spritesheets",
  video: "Generate, edit and upscale videos",
  model: "Image to 3D, rigging and 3D animation",
  audio: "Sound effects, music, ambiance, voices and speech",
  jobs: "Follow, list and cancel generation jobs",
  generations: "Browse your generation history",
  docs: "Search and read Ludo's feature documentation",
  auth: "Check your API key",
  files: "Upload local files",
  account: "Your credits, plan and auto top-up"
};

// Names that read better than the derived ones (`ludo account show`, not
// `ludo account get`).
const CLI_NAMES: Record<string, string> = { getAccount: "show" };

// Operations the CLI calls itself, behind its own commands: createUpload for
// file flags and `ludo files upload`, revokeCurrentCliKey for `ludo logout`,
// submitApiFeedback for `ludo feedback`.
const HIDDEN = new Set(["createUpload", "revokeCurrentCliKey", "submitApiFeedback"]);

const SYNC_TAIL = /\s*The call returns 202 with a job id[\s\S]*$/;
const MCP_TAIL = /\s*Async generation job:[\s\S]*$/;

function splitWords(id: string): string[] {
  return id
    .replace(/3D/g, "-3d-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .split("-")
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

export function commandName(group: string, operationId: string): string {
  const drop = new Set(GROUP_NOUNS[group] || []);
  const words = splitWords(operationId).filter(w => !drop.has(w));
  return words.length ? words.join("-") : splitWords(operationId).join("-");
}

export function toFlag(name: string): string {
  return "--" + name.replace(/_/g, "-");
}

function resolveRef(spec: Spec, ref: string): any {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node: any, key: string) => (node ? node[key] : undefined), spec);
}

function resolveSchema(spec: Spec, schema: any, depth = 0): any {
  if (!schema || depth > 20) return schema || {};
  if (schema.$ref) return resolveSchema(spec, resolveRef(spec, schema.$ref), depth + 1);
  if (schema.allOf) {
    const merged: any = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const r = resolveSchema(spec, part, depth + 1);
      Object.assign(merged.properties, r.properties || {});
      merged.required.push(...(r.required || []));
      if (r.description && !merged.description) merged.description = r.description;
    }
    return merged;
  }
  return schema;
}

function fieldType(schema: any): FieldType {
  const t = schema.type;
  if (t === "integer" || t === "number" || t === "boolean" || t === "array" || t === "object") return t;
  return "string";
}

function makeField(spec: Spec, name: string, rawSchema: any, where: Field["in"], required: boolean, extraDescription?: string): Field {
  const schema = resolveSchema(spec, rawSchema);
  const items = schema.items ? resolveSchema(spec, schema.items) : undefined;
  const type = fieldType(schema);
  const description = String(extraDescription || schema.description || items?.description || "").trim();
  const itemType = items ? fieldType(items) : undefined;
  // Every field that takes arbitrary media says so with "base64" ("URL or
  // base64-encoded source image"); fields that only take a URL of something
  // you already generated do not, and a local file could not work there.
  const stringy = type === "string" || (type === "array" && itemType === "string");
  return {
    name,
    flag: toFlag(name),
    in: where,
    type,
    itemType,
    enum: Array.isArray(schema.enum) ? schema.enum.map(String) : Array.isArray(items?.enum) ? items.enum.map(String) : undefined,
    default: schema.default,
    required,
    description,
    isFile: stringy && /base64/i.test(description),
    minimum: schema.minimum,
    maximum: schema.maximum
  };
}

function cleanDescription(op: any): string {
  const text = String(op["x-mcp-description"] || op.description || op.summary || "");
  return text.replace(SYNC_TAIL, "").replace(MCP_TAIL, "").trim();
}

function firstSentence(text: string): string {
  const match = text.match(/^[\s\S]*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim();
}

function isApiKeyOp(op: any, spec: Spec): boolean {
  const security = op.security || spec.security || [];
  return security.some((s: any) => Object.keys(s).includes("ApiKey"));
}

export function buildCommands(spec: Spec): Command[] {
  const commands: Command[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (!op || !op.operationId || !isApiKeyOp(op, spec)) continue;
      // Deprecated reads (superseded by jobs/generations) are not offered.
      if (op.deprecated) continue;

      const tag = (op.tags && op.tags[0]) || "Misc";
      const group = TAG_GROUPS[tag] || tag.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const name = op["x-cli-name"] || CLI_NAMES[op.operationId] || commandName(group, op.operationId);

      const fields: Field[] = [];
      for (const p of op.parameters || []) {
        const param = p.$ref ? resolveRef(spec, p.$ref) : p;
        if (param.in !== "query" && param.in !== "path") continue;
        fields.push(makeField(spec, param.name, param.schema || {}, param.in, !!param.required || param.in === "path", param.description));
      }

      let isJob = false;
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        const body = resolveSchema(spec, bodySchema);
        const required = new Set<string>(body.required || []);
        for (const [prop, propSchema] of Object.entries<any>(body.properties || {})) {
          // The CLI is always async and waits for the job itself.
          if (prop === "async") {
            isJob = true;
            continue;
          }
          fields.push(makeField(spec, prop, propSchema, "body", required.has(prop)));
        }
      }

      const description = cleanDescription(op);
      commands.push({
        group,
        name,
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: firstSentence(description),
        description,
        credits: op["x-credit-summary"] || op["x-credit-description"],
        fields,
        isJob,
        hidden: HIDDEN.has(op.operationId)
      });
    }
  }
  dropSharedCreate(commands);
  return commands;
}

// When every command in a group starts with "create" (audio: createMusic,
// createVoice, ...), the verb carries no information: `ludo audio music` reads
// better than `ludo audio create-music`. Groups that mix verbs keep them
// (`video create` vs `video edit`). Names set with x-cli-name are left alone.
function dropSharedCreate(commands: Command[]) {
  const byGroup = new Map<string, Command[]>();
  for (const c of commands) {
    if (c.hidden) continue;
    byGroup.set(c.group, [...(byGroup.get(c.group) || []), c]);
  }
  for (const group of byGroup.values()) {
    if (group.length < 2 || !group.every(c => c.name.startsWith("create-"))) continue;
    for (const c of group) c.name = c.name.slice("create-".length);
  }
}

export function findCommand(commands: Command[], words: string[]): { command?: Command; consumed: number } {
  if (words.length === 0) return { consumed: 0 };
  const lower = words[0].toLowerCase();
  const byId = commands.find(c => c.operationId.toLowerCase() === lower);
  if (byId) return { command: byId, consumed: 1 };
  if (words.length >= 2) {
    const match = commands.find(c => c.group === words[0] && c.name === words[1]);
    if (match) return { command: match, consumed: 2 };
  }
  return { consumed: 0 };
}

export function groupsOf(commands: Command[]): string[] {
  const order = Object.keys(GROUP_INFO);
  const groups = Array.from(new Set(commands.filter(c => !c.hidden).map(c => c.group)));
  return groups.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}
