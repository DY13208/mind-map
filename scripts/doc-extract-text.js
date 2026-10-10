#!/usr/bin/env node
// Local readable formats, MinerU official API for PDF/images.
const fs = require("node:fs/promises"),
  path = require("node:path");
const {
  extractDocument,
} = require("../simple-mind-map/bin/localKnowledge/extract");
async function main() {
  const args = process.argv.slice(2),
    file = args.find((a) => !a.startsWith("-"));
  if (!file || args.includes("--help")) {
    console.log(
      "Usage: node scripts/doc-extract-text.js <file> [--out <output.txt>]\nPDF/images require server-side MINERU_API_TOKEN."
    );
    return;
  }
  if (args.some((a) => ["--ocr", "--vision"].includes(a)))
    throw new Error("旧解析模式已移除，请直接指定文件");
  const pages = await extractDocument(path.resolve(file), {
      onStatus: (s) => console.error(s),
    }),
    text = pages
      .map((p) => "[页码 " + (p.page ?? "未提供") + "]\n" + p.text)
      .join("\n\n");
  const i = args.indexOf("--out");
  if (i >= 0) {
    if (!args[i + 1]) throw new Error("缺少输出路径");
    await fs.writeFile(args[i + 1], text);
  } else console.log(text);
}
main().catch((e) => {
  console.error(e.code || "EXTRACT_FAILED", e.message);
  process.exitCode = 1;
});
