#!/usr/bin/env node
"use strict";
// bcg — Backend Code Generator CLI.
// Usage: bcg generate <spec.json> --out <dir>

const path = require("path");
const { loadSpec } = require("../src/spec");
const { generate } = require("../src/generator");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" || argv[i] === "-o") args.out = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(
      "bcg — deterministic backend generator\n\n" +
        "Usage:\n" +
        "  bcg generate <spec.json> --out <dir>\n\n" +
        "Example:\n" +
        "  bcg generate examples/blog.json --out ./out/blog-api"
    );
    return;
  }

  if (cmd !== "generate") {
    console.error(`Unknown command "${cmd}". Try: bcg help`);
    process.exit(1);
  }

  const args = parseArgs(argv.slice(1));
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

main();
