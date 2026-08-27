"use strict";
// Deterministic frontend analyzer. Reads a frontend project and infers the
// backend spec (entities, fields, CRUD operations) that the generator consumes.
// No AI, no network: the same frontend always produces the same spec.
//
// It works by scanning source files for HTTP calls (fetch / axios) and HTML
// forms, then applying a fixed set of naming and type rules. The rules are
// intentionally simple and documented so the output is predictable; see the
// README ("Frontend analysis") for the full list and known limitations.

const fs = require("fs");
const path = require("path");
const { pascalCase, snakeCase, FIELD_TYPES } = require("./spec");

const SOURCE_EXTS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".html",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next",
  ".svelte-kit", ".nuxt", "vendor",
]);

// --- Filesystem walk -----------------------------------------------------

// Recursively collect source files, sorted at every level so the traversal
// order (and therefore the output) is deterministic.
function walk(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      files.push(...walk(full));
    } else if (SOURCE_EXTS.has(path.extname(name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

// --- Low-level scanning helpers -----------------------------------------

// Advance past a string literal starting at `i` (quote char). Returns the index
// of the closing quote (the caller's loop then steps past it).
function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length && src[i] !== q) {
    if (src[i] === "\\") i += 2;
    else i++;
  }
  return i;
}

// Replace comment bodies with spaces (preserving newlines and total length) so
// later scans never match code that appears only inside a comment. String and
// template literals are kept intact because request URLs live there. Length is
// preserved so byte offsets still map to the correct source line.
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && d === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i);
      out += src.slice(i, end + 1);
      i = end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// From an opening delimiter at `openIdx`, return { text, end } spanning through
// the matching close delimiter, honoring nesting of the same delimiter and
// skipping string literals.
function matchDelims(src, openIdx) {
  const open = src[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { text: src.slice(openIdx, i + 1), end: i };
    }
  }
  return { text: src.slice(openIdx), end: src.length - 1 };
}

// Split a delimited body (with the outer braces already removed) by top-level
// commas, ignoring commas nested inside brackets or strings.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  const last = s.slice(start);
  if (last.trim()) parts.push(last);
  return parts;
}

// Return the content of the first string literal in `s`, or null.
function firstString(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(s, i);
      return s.slice(i + 1, end);
    }
  }
  return null;
}

// 1-based source line for a byte offset.
function lineOf(src, index) {
  let line = 1;
  const stop = Math.min(index, src.length);
  for (let i = 0; i < stop; i++) if (src[i] === "\n") line++;
  return line;
}

// --- Object / type inference --------------------------------------------

// Classify a value's literal type, or null when it's a variable/expression.
function literalType(v) {
  if (!v) return null;
  if (/^(true|false)\b/.test(v)) return "boolean";
  if (/^-?\d+\.\d+/.test(v)) return "float";
  if (/^-?\d+\b/.test(v)) return "integer";
  const q = v[0];
  if (q === '"' || q === "'" || q === "`") return "string";
  return null;
}

// Given object-literal text "{ ... }", return [{ name, valueType }] for each
// top-level property. valueType is set only when the value is a literal.
function objectKeys(objText) {
  const inner = objText.trim().replace(/^\{/, "").replace(/\}$/, "");
  const keys = [];
  for (const seg of splitTopLevel(inner)) {
    const t = seg.trim();
    if (!t || t.startsWith("...")) continue;
    let name;
    let rest;
    const q = t[0];
    if (q === '"' || q === "'") {
      const end = skipString(t, 0);
      name = t.slice(1, end);
      rest = t.slice(end + 1).replace(/^\s*:/, "");
    } else {
      const m = t.match(/^([A-Za-z_$][\w$]*)/);
      if (!m) continue;
      name = m[1];
      const after = t.slice(m[1].length).trim();
      rest = after.startsWith(":") ? after.slice(1) : ""; // shorthand => no value
    }
    keys.push({ name, valueType: literalType(rest.trim()) });
  }
  return keys;
}

const BOOL_WORDS = new Set([
  "active", "enabled", "published", "done", "completed", "verified",
  "visible", "archived", "public", "featured", "read", "paid",
]);
const TEXT_WORDS = new Set([
  "body", "content", "description", "notes", "bio", "comment",
  "message", "summary", "details", "about",
]);

// Deterministic field type: an explicit literal type wins; otherwise the field
// name is matched against a fixed set of naming rules; string is the fallback.
function inferType(name, valueType) {
  if (valueType && FIELD_TYPES.includes(valueType)) return valueType;
  const n = snakeCase(name).toLowerCase();
  if (/^(is|has|can|should)_/.test(n) || BOOL_WORDS.has(n)) return "boolean";
  if (
    n === "id" ||
    /_id$/.test(n) ||
    /(^|_)(count|views|view|age|quantity|qty|number|num|stock|rank|position|year|priority)($|_)/.test(n)
  )
    return "integer";
  if (/(price|amount|rate|total|cost|balance|latitude|longitude|weight|height|width|score|percentage)/.test(n))
    return "float";
  if (TEXT_WORDS.has(n) || /_text$/.test(n)) return "text";
  return "string";
}

// Naive, predictable inverse of the generator's pluralize (handles the same
// endings it produces). Ambiguous cases fall through unchanged.
function singularize(word) {
  const w = String(word);
  if (/ies$/i.test(w)) return w.slice(0, -3) + "y";
  if (/(ches|shes|xes|sses)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && !/ss$/i.test(w)) return w.slice(0, -1);
  return w;
}

// --- URL / method mapping -----------------------------------------------

// Turn a request URL into { resource, itemLevel }. resource is the plural path
// segment naming the collection; itemLevel is true when the URL targets a
// single record (a path parameter or trailing id).
function resolveResource(url) {
  if (!url) return null;
  let p = url;
  const proto = p.match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i); // strip scheme://host
  if (proto) p = proto[1] || "/";
  p = p.split("?")[0].split("#")[0];
  const isParam = (s) =>
    s.startsWith(":") || s.includes("${") || /^\d+$/.test(s) || /^\{.*\}$/.test(s);
  let segs = p.split("/").filter(Boolean);
  while (segs.length && /^(api|v\d+)$/i.test(segs[0])) segs.shift();
  if (!segs.length) return null;
  let resource = null;
  let itemLevel = false;
  for (const seg of segs) {
    if (isParam(seg)) {
      if (resource) itemLevel = true;
    } else {
      resource = seg;
    }
  }
  if (!resource) return null;
  return { resource, itemLevel };
}

// HTTP method + item-level flag -> CRUD operation name.
function opFor(method, itemLevel) {
  switch (method) {
    case "GET":
      return itemLevel ? "show" : "list";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "remove";
    default:
      return null;
  }
}

// --- Per-file extraction ------------------------------------------------

// Pull field descriptors out of a fetch options object's `body` value,
// unwrapping JSON.stringify(...) when present. Returns null when there is no
// body key, [] when the body is a variable/FormData (fields unknown).
function extractBody(optsText) {
  const inner = optsText.trim().replace(/^\{/, "").replace(/\}$/, "");
  for (const seg of splitTopLevel(inner)) {
    const t = seg.trim();
    const m = t.match(/^(['"]?)body\1\s*:/);
    if (!m) continue;
    let val = t.slice(m[0].length).trim();
    if (/^JSON\s*\.\s*stringify\s*\(/.test(val)) {
      const open = val.indexOf("(");
      val = matchDelims(val, open).text.slice(1, -1).trim();
    }
    if (val.startsWith("{")) return objectKeys(matchDelims(val, 0).text);
    return [];
  }
  return null;
}

// Extract every fetch / axios call site from already comment-stripped source.
function parseCalls(src) {
  const calls = [];
  let m;

  const fetchRe = /\bfetch\s*\(/g;
  while ((m = fetchRe.exec(src))) {
    const open = src.indexOf("(", m.index);
    if (open === -1) continue;
    const args = splitTopLevel(matchDelims(src, open).text.slice(1, -1));
    const url = firstString(args[0] || "");
    let method = null;
    let body = null;
    if (args[1] && args[1].trim().startsWith("{")) {
      const mm = args[1].match(/\bmethod\s*:\s*['"`](\w+)['"`]/i);
      if (mm) method = mm[1].toUpperCase();
      body = extractBody(args[1]);
    }
    if (!method) method = body ? "POST" : "GET";
    calls.push({ url, method, fields: body || [], index: m.index });
  }

  const axiosMethodRe = /\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(/gi;
  while ((m = axiosMethodRe.exec(src))) {
    const method = m[1].toUpperCase();
    const open = src.indexOf("(", m.index);
    if (open === -1) continue;
    const args = splitTopLevel(matchDelims(src, open).text.slice(1, -1));
    const url = firstString(args[0] || "");
    let fields = [];
    if (args[1] && args[1].trim().startsWith("{")) fields = objectKeys(args[1].trim());
    calls.push({ url, method, fields, index: m.index });
  }

  const axiosConfigRe = /\baxios\s*\(\s*\{/g;
  while ((m = axiosConfigRe.exec(src))) {
    const open = src.indexOf("{", m.index);
    if (open === -1) continue;
    const text = matchDelims(src, open).text;
    const url = (text.match(/\burl\s*:\s*['"`]([^'"`]+)['"`]/) || [])[1] || null;
    const method = ((text.match(/\bmethod\s*:\s*['"`](\w+)['"`]/i) || [])[1] || "GET").toUpperCase();
    let fields = [];
    const dm = text.match(/\bdata\s*:\s*/);
    if (dm) {
      const after = text.slice(dm.index + dm[0].length);
      if (after.startsWith("{")) fields = objectKeys(matchDelims(after, 0).text);
    }
    calls.push({ url, method, fields, index: m.index });
  }

  return calls;
}

// Extract form field names (and the form action) from HTML/JSX markup.
function parseForms(src) {
  const fields = [];
  const re = /<(input|textarea|select)\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[2];
    const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nameM) continue;
    const typeM = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const t = (typeM ? typeM[1] : "").toLowerCase();
    if (["submit", "button", "reset", "hidden", "file", "image"].includes(t)) continue;
    let valueType = null;
    if (t === "number" || t === "range") valueType = "integer";
    else if (t === "checkbox") valueType = "boolean";
    fields.push({ name: nameM[1], valueType, index: m.index });
  }
  const actionM = src.match(/<form\b[^>]*\baction\s*=\s*["']([^"']+)["']/i);
  return { fields, actionUrl: actionM ? actionM[1] : null };
}

// --- Orchestration ------------------------------------------------------

function specError(msg) {
  const e = new Error(msg);
  e.isSpecError = true;
  return e;
}

function deriveName(abs) {
  let base = path.basename(abs);
  const pkg = path.join(abs, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const name = JSON.parse(fs.readFileSync(pkg, "utf8")).name;
      if (name) base = String(name).replace(/^@[^/]+\//, "");
    } catch {
      /* ignore malformed package.json */
    }
  }
  return `${base}-api`;
}

// Analyze a frontend directory and return { spec, trace, warnings }.
// spec matches the JSON contract the generator consumes; trace records, per
// entity, which frontend files/lines produced each field and operation.
function analyzeDir(dir, opts = {}) {
  const abs = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw specError(`Cannot read frontend directory: ${dir}`);
  }
  if (!stat.isDirectory()) throw specError(`Not a directory: ${dir}`);

  const entities = new Map(); // name -> { name, fields:Map, ops:Map, sources:Set }
  const warnings = [];

  const getEntity = (name) => {
    if (!entities.has(name)) {
      entities.set(name, {
        name,
        fields: new Map(),
        ops: new Map(),
        sources: new Set(),
      });
    }
    return entities.get(name);
  };
  const addField = (ent, fname, valueType, source) => {
    const key = snakeCase(fname);
    if (!key) return;
    if (!ent.fields.has(key)) {
      ent.fields.set(key, {
        name: key,
        type: inferType(fname, valueType),
        sources: new Set(),
      });
    }
    ent.fields.get(key).sources.add(source);
  };

  for (const file of walk(abs)) {
    const rel = path.relative(abs, file);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const src = stripComments(raw);

    const fileWriteEntities = new Set();
    for (const call of parseCalls(src)) {
      const r = resolveResource(call.url);
      if (!r) continue;
      const name = pascalCase(singularize(r.resource));
      if (!name) continue;
      const ent = getEntity(name);
      const source = `${rel}:${lineOf(src, call.index)}`;
      ent.sources.add(source);
      const op = opFor(call.method, r.itemLevel);
      if (op) {
        if (!ent.ops.has(op)) ent.ops.set(op, new Set());
        ent.ops.get(op).add(source);
        if (op === "create" || op === "update") fileWriteEntities.add(name);
      }
      for (const f of call.fields) addField(ent, f.name, f.valueType, source);
    }

    // A form enriches the entity this file writes to.
    const form = parseForms(src);
    if (form.fields.length) {
      let targetName = null;
      if (fileWriteEntities.size === 1) {
        targetName = [...fileWriteEntities][0];
      } else if (form.actionUrl) {
        const r = resolveResource(form.actionUrl);
        if (r) targetName = pascalCase(singularize(r.resource));
      }
      if (targetName) {
        const ent = getEntity(targetName);
        for (const f of form.fields) {
          const source = `${rel}:${lineOf(src, f.index)}`;
          ent.sources.add(source);
          addField(ent, f.name, f.valueType, source);
        }
      } else {
        warnings.push(`${rel}: form fields found but no clear target entity; skipped.`);
      }
    }
  }

  const specEntities = [];
  const trace = [];
  for (const ent of entities.values()) {
    let fields = [...ent.fields.values()].map((f) => ({
      name: f.name,
      type: f.type,
      required: false,
    }));
    if (!fields.length) {
      fields = [{ name: "name", type: "string", required: false }];
      warnings.push(
        `${ent.name}: no fields detected from the frontend; added a placeholder ` +
          `"name" field — edit the spec before generating.`
      );
    }
    specEntities.push({ name: ent.name, fields });
    trace.push({
      entity: ent.name,
      sources: [...ent.sources].sort(),
      operations: [...ent.ops.entries()].map(([op, s]) => ({
        op,
        sources: [...s].sort(),
      })),
      fields: [...ent.fields.values()].map((f) => ({
        name: f.name,
        type: f.type,
        sources: [...f.sources].sort(),
      })),
    });
  }
  specEntities.sort((a, b) => a.name.localeCompare(b.name));
  trace.sort((a, b) => a.entity.localeCompare(b.entity));

  if (!specEntities.length) {
    throw specError(
      "No backend requirements detected: found no fetch/axios calls or forms targeting an API."
    );
  }

  const spec = {
    projectName: opts.project || deriveName(abs),
    target: opts.target || "node",
    entities: specEntities,
  };
  return { spec, trace, warnings };
}

module.exports = {
  analyzeDir,
  // exported for reuse / inspection
  singularize,
  inferType,
  resolveResource,
  opFor,
  parseCalls,
  parseForms,
  stripComments,
};
