const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../dist/flips-core.js");

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

// (tests will be added in following tasks)
