const fs = require("fs");
const p = "scripts/openclaw-docker.js";
let s = fs.readFileSync(p, "utf8");
const m = "LIANGCE_LOAD_COGNEE_ENV";
if (s.includes(m)) {
  console.log("env load already");
  process.exit(0);
}
const anchor = "  let cogneeActive = false\n  try {";
let idx = s.indexOf(anchor);
let nl = "\n";
if (idx < 0) {
  const anchor2 = "  let cogneeActive = false\r\n  try {";
  idx = s.indexOf(anchor2);
  nl = "\r\n";
  if (idx < 0) {
    console.error("anchor missing");
    process.exit(1);
  }
}
const inject =
  "  let cogneeActive = false" + nl +
  "  /* " + m + " */" + nl +
  "  {" + nl +
  "    const envMap = loadEnvFile()" + nl +
  "    for (const k of ['COGNEE_ENABLED','COGNEE_DIR','COGNEE_PORT','COGNEE_URL','COGNEE_API_KEY','COGNEE_DATASET']) {" + nl +
  "      if (!String(process.env[k] || '').trim() && envMap[k]) process.env[k] = envMap[k]" + nl +
  "    }" + nl +
  "  }" + nl +
  "  try {";
const anchorLen = (nl === "\n") ? anchor.length : ("  let cogneeActive = false\r\n  try {").length;
s = s.slice(0, idx) + inject + s.slice(idx + anchorLen);
fs.writeFileSync(p, s);
console.log("env load patched");