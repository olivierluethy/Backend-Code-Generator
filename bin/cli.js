#!/usr/bin/env node
"use strict";
// bcg — Backend Code Generator CLI.
//
//   bcg analyze  <frontend-dir> [--out spec.json] [--generate <dir>]
//   bcg generate <spec.json>    --out <dir>

const fs = require("fs");
const path = require("path");
const { loadSpec, normalizeSpec } = require("../src/spec");
const { generate } = require("../src/generator");
const { analyzeDir } = require("../src/analyze");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--generate" || a === "-g") args.generate = argv[++i];
    else if (a === "--project" || a === "-p") args.project = argv[++i];
    else if (a === "--target" || a === "-t") args.target = argv[++i];
    else args._.push(a);
  }
  return args;
}

function printHelp() {
  console.log(
    "bcg — deterministic backend generator\n\n" +
      "Usage:\n" +
      "  bcg analyze  <frontend-dir> [--out spec.json] [--generate <dir>] [--project <name>]\n" +
      "  bcg generate <spec.json>    --out <dir>\n\n" +
      "Examples:\n" +
      "  bcg analyze examples/frontend --out spec.json\n" +
      "  bcg analyze examples/frontend --generate ./out/api\n" +
      "  bcg generate examples/blog.json --out ./out/blog-api"
  );
}

function cmdGenerate(argv) {
  const args = parseArgs(argv);
  const specPath = args._[0];
  if (!specPath) {
    console.error("Missing spec file. Usage: bcg generate <spec.json> --out <dir>");
    process.exit(1);
  }
  const outDir = path.resolve(args.out || "./out");

  let spec;
  try {
    spec = loadSpec(path.resolve(specPath));
  } catch (e) {
    console.error("Spec error: " + e.message);
    process.exit(1);
  }

  const { written, trace } = generate(spec, outDir);

  console.log(`\nGenerated ${written.length} files into ${outDir}\n`);
  console.log("Traceability (entity -> generated components):");
  for (const t of trace) {
    console.log(`  ${t.entity}  ${t.route}`);
    for (const f of t.files) console.log(`      - ${f}`);
  }
  console.log(
    `\nRun it:\n  cd ${path.relative(process.cwd(), outDir)} && npm install && npm start\n`
  );
}

function cmdAnalyze(argv) {
  const args = parseArgs(argv);
  const dir = args._[0];
  if (!dir) {
    console.error(
      "Missing frontend directory.\n" +
        "Usage: bcg analyze <frontend-dir> [--out spec.json] [--generate <dir>]"
    );
    process.exit(1);
  }

  let result;
  try {
    result = analyzeDir(dir, { project: args.project, target: args.target });
  } catch (e) {
    console.error("Analyze error: " + e.message);
    process.exit(1);
  }
  const { spec, trace, warnings } = result;

  const specOut = path.resolve(args.out || "./spec.json");
  fs.mkdirSync(path.dirname(specOut), { recursive: true });
  fs.writeFileSync(specOut, JSON.stringify(spec, null, 2) + "\n");

  const count = spec.entities.length;
  console.log(
    `\nAnalyzed frontend -> ${count} entit${count === 1 ? "y" : "ies"}. ` +
      `Spec written to ${specOut}\n`
  );
  console.log("Traceability (frontend evidence -> backend requirement):");
  for (const t of trace) {
    console.log(`  ${t.entity}`);
    const ops = t.operations.map((o) => o.op).join(", ") || "(none detected)";
    console.log(`      operations: ${ops}`);
    for (const f of t.fields) {
      console.log(`      field ${f.name} (${f.type})  <- ${f.sources.join(", ")}`);
    }
  }
  if (warnings.length) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log("  ! " + w);
  }

  if (args.generate) {
    const outDir = path.resolve(args.generate);
    let normalized;
    try {
      normalized = normalizeSpec(spec);
    } catch (e) {
      console.error("Spec error: " + e.message);
      process.exit(1);
    }
    const { written } = generate(normalized, outDir);
    console.log(`\nGenerated ${written.length} backend files into ${outDir}`);
    console.log(
      `Run it:\n  cd ${path.relative(process.cwd(), outDir)} && npm install && npm start\n`
    );
  } else {
    const rel = path.relative(process.cwd(), specOut);
    console.log(
      `\nReview/edit ${rel}, then generate:\n` +
        `  bcg generate ${rel} --out ./out/backend\n`
    );
  }
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "analyze") return cmdAnalyze(argv.slice(1));
  if (cmd === "generate") return cmdGenerate(argv.slice(1));

  console.error(`Unknown command "${cmd}". Try: bcg help`);
  process.exit(1);
}

main();
