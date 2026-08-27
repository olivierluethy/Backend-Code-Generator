"use strict";
// Spec loading, validation and name normalization. Pure and deterministic:
// the same spec always yields the same backend.

const fs = require("fs");

const FIELD_TYPES = ["string", "text", "integer", "boolean", "float"];

// SQLite column type per spec field type.
const SQLITE_TYPE = {
  string: "TEXT",
  text: "TEXT",
  integer: "INTEGER",
  boolean: "INTEGER",
  float: "REAL",
};

function pascalCase(name) {
  return String(name)
    .replace(/[_\-\s]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function snakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .toLowerCase();
}

// Naive but predictable pluralization for table/route names.
function pluralize(word) {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es";
  return word + "s";
}

function fail(msg) {
  const e = new Error(msg);
  e.isSpecError = true;
  return e;
}

// Validate + normalize a raw spec object into a canonical shape the generator
// consumes. Throws a spec error (with a clear message) on anything invalid.
function normalizeSpec(raw) {
  if (!raw || typeof raw !== "object") throw fail("Spec must be a JSON object.");
  const target = raw.target || "node";
  if (target !== "node") {
    throw fail(`Unsupported target "${target}". Only "node" is implemented.`);
  }
  if (!Array.isArray(raw.entities) || raw.entities.length === 0) {
    throw fail("Spec must have a non-empty 'entities' array.");
  }

  const projectName = snakeCase(raw.projectName || "generated-api").replace(
    /_/g,
    "-"
  );

  const entities = raw.entities.map((ent, i) => {
    if (!ent || !ent.name) throw fail(`entities[${i}] is missing 'name'.`);
    if (!Array.isArray(ent.fields) || ent.fields.length === 0) {
      throw fail(`Entity "${ent.name}" must have a non-empty 'fields' array.`);
    }
    const className = pascalCase(ent.name);
    const table = pluralize(snakeCase(ent.name));
    const route = "/" + table;
    const fields = ent.fields.map((f, j) => {
      if (!f || !f.name) throw fail(`${ent.name}.fields[${j}] is missing 'name'.`);
      const type = f.type || "string";
      if (!FIELD_TYPES.includes(type)) {
        throw fail(
          `${ent.name}.${f.name}: unknown type "${type}". ` +
            `Allowed: ${FIELD_TYPES.join(", ")}.`
        );
      }
      return {
        name: snakeCase(f.name),
        type,
        required: Boolean(f.required),
        sqlite: SQLITE_TYPE[type],
      };
    });
    return { className, table, route, fields };
  });

  return { projectName, target, entities };
}

function loadSpec(path) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    throw fail(`Cannot read spec file: ${path}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw fail(`Spec is not valid JSON: ${e.message}`);
  }
  return normalizeSpec(raw);
}

module.exports = {
  FIELD_TYPES,
  SQLITE_TYPE,
  pascalCase,
  snakeCase,
  pluralize,
  normalizeSpec,
  loadSpec,
};
