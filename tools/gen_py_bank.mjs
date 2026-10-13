// 从 questions.js 生成 Python 题库字面量（保证两端题库逐字节一致）
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const { QUESTIONS, SVG_TASKS, GROUPS } = await import(join(here, "..", "winapp", "wwwroot", "questions.js"));
import { writeFileSync } from "node:fs";
const py = (v) => JSON.stringify(v, null, 2)
  .replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
let out = "# 本文件由 winapp/wwwroot/questions.js 生成（tools/gen_py_bank.mjs），请勿手改\n";
out += "# 22 道学科推理题 + 8 道 SVG 动画题，与桌面端题库完全一致\n\n";
out += "GROUPS = " + py(GROUPS) + "\n\n";
out += "QUESTIONS = " + py(QUESTIONS) + "\n\n";
out += "SVG_TASKS = " + py(SVG_TASKS) + "\n";
writeFileSync(join(here, "..", "bank_data.py"), out);
console.log("bank_data.py:", out.length, "bytes;", QUESTIONS.length, "questions,", SVG_TASKS.length, "svg tasks");
