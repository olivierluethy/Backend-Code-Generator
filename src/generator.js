"use strict";
// Deterministic template-based generator. Given a normalized spec, it writes a
// runnable Express + better-sqlite3 CRUD backend. No AI, no network.

const fs = require("fs");
const path = require("path");

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return rel;
}

// --- Templates -----------------------------------------------------------

function migrationSql(entity, index) {
  const cols = entity.fields
    .map((f) => `  ${f.name} ${f.sqlite}${f.required ? " NOT NULL" : ""}`)
    .join(",\n");
  return (
    `-- ${String(index + 1).padStart(3, "0")}: create ${entity.table}\n` +
    `CREATE TABLE IF NOT EXISTS ${entity.table} (\n` +
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,\n` +
    `${cols},\n` +
    `  created_at TEXT DEFAULT CURRENT_TIMESTAMP\n` +
    `);\n`
  );
}

function modelJs(entity) {
  const fieldNames = entity.fields.map((f) => f.name);
  const cols = fieldNames.join(", ");
  const placeholders = fieldNames.map((n) => `@${n}`).join(", ");
  const setClause = fieldNames.map((n) => `${n} = @${n}`).join(", ");
  return `"use strict";
const db = require("../db");

const ${entity.className} = {
  all() {
    return db.prepare("SELECT * FROM ${entity.table} ORDER BY id DESC").all();
  },
  get(id) {
    return db.prepare("SELECT * FROM ${entity.table} WHERE id = ?").get(id);
  },
  create(data) {
    const info = db
      .prepare("INSERT INTO ${entity.table} (${cols}) VALUES (${placeholders})")
      .run(data);
    return this.get(info.lastInsertRowid);
  },
  update(id, data) {
    db.prepare("UPDATE ${entity.table} SET ${setClause} WHERE id = @id").run({
      ...data,
      id,
    });
    return this.get(id);
  },
  remove(id) {
    return db.prepare("DELETE FROM ${entity.table} WHERE id = ?").run(id)
      .changes;
  },
};

module.exports = ${entity.className};
`;
}

function controllerJs(entity) {
  const required = entity.fields.filter((f) => f.required).map((f) => f.name);
  const pick = entity.fields
    .map((f) => {
      if (f.type === "boolean") return `    ${f.name}: body.${f.name} ? 1 : 0,`;
      return `    ${f.name}: body.${f.name} ?? null,`;
    })
    .join("\n");
  const requiredCheck = required.length
    ? `  const missing = ${JSON.stringify(
        required
      )}.filter((k) => body[k] === undefined || body[k] === null || body[k] === "");
  if (missing.length) {
    return res.status(400).json({ error: "Missing required fields: " + missing.join(", ") });
  }`
    : "  // no required fields";
  return `"use strict";
const ${entity.className} = require("../models/${entity.className}");

function pick(body) {
  return {
${pick}
  };
}

module.exports = {
  list(req, res) {
    res.json(${entity.className}.all());
  },
  show(req, res) {
    const row = ${entity.className}.get(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  },
  create(req, res) {
    const body = req.body || {};
${requiredCheck}
    res.status(201).json(${entity.className}.create(pick(body)));
  },
  update(req, res) {
    const existing = ${entity.className}.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const body = { ...existing, ...(req.body || {}) };
    res.json(${entity.className}.update(req.params.id, pick(body)));
  },
  remove(req, res) {
    const changes = ${entity.className}.remove(req.params.id);
    if (!changes) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  },
};
`;
}

function routesJs(entity) {
  const varName = entity.table + "Controller";
  return `"use strict";
const express = require("express");
const router = express.Router();
const ${varName} = require("../controllers/${entity.className}Controller");

router.get("/", ${varName}.list);
router.get("/:id", ${varName}.show);
router.post("/", ${varName}.create);
router.put("/:id", ${varName}.update);
router.delete("/:id", ${varName}.remove);

module.exports = router;
`;
}

function dbJs() {
  return `"use strict";
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");

// Run every migration in migrations/ once, in filename order.
const dir = path.join(__dirname, "migrations");
for (const file of fs.readdirSync(dir).sort()) {
  if (file.endsWith(".sql")) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
}

module.exports = db;
`;
}

function appJs(entities) {
  const mounts = entities
    .map(
      (e) =>
        `app.use("${e.route}", require("./routes/${e.table}.routes"));`
    )
    .join("\n");
  return `"use strict";
const express = require("express");
require("./db"); // runs migrations on boot

const app = express();
app.use(express.json());

${mounts}

app.get("/", (req, res) =>
  res.json({ status: "ok", resources: [${entities
    .map((e) => `"${e.route}"`)
    .join(", ")}] })
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API listening on http://localhost:" + port));
`;
}

function generatedPackageJson(projectName) {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      main: "app.js",
      scripts: { start: "node app.js" },
      dependencies: { express: "^4.19.2", "better-sqlite3": "^11.0.0" },
    },
    null,
    2
  );
}

// --- Orchestration -------------------------------------------------------

function generate(spec, outDir) {
  const written = [];
  const trace = [];

  written.push(write(outDir, "package.json", generatedPackageJson(spec.projectName)));
  written.push(write(outDir, "db.js", dbJs()));
  written.push(write(outDir, "app.js", appJs(spec.entities)));

  spec.entities.forEach((entity, i) => {
    const files = [
      write(outDir, `migrations/${String(i + 1).padStart(3, "0")}_create_${entity.table}.sql`, migrationSql(entity, i)),
      write(outDir, `models/${entity.className}.js`, modelJs(entity)),
      write(outDir, `controllers/${entity.className}Controller.js`, controllerJs(entity)),
      write(outDir, `routes/${entity.table}.routes.js`, routesJs(entity)),
    ];
    written.push(...files);
    trace.push({ entity: entity.className, route: entity.route, files });
  });

  return { written, trace };
}

module.exports = { generate };
