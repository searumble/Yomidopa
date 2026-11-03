// 原文(Shift_JIS)を build.py とは別の実装で読み解く。verify.mjs と e2e.cjs が使う。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const gaiji = JSON.parse(read("tools/gaiji-used.json")); // tools/verify_gaiji.py で別途検証済み

// ---- 原文を独自に読み解く ----
export function original(file) {
  const raw = new TextDecoder("shift_jis", { fatal: true }).decode(read(path.join("source/aozora", file)));
  const lines = raw.split("\r\n");
  let start = lines.indexOf("") + 1;
  const dash = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) if (/^-{10,}/.test(lines[i])) dash.push(i);
  if (dash.length >= 2) start = dash[1] + 1;
  let foot = -1;
  lines.forEach((l, i) => { if (l.startsWith("底本：")) foot = i; });
  if (foot < 0) throw new Error(`${file}: 底本 の行がない`);
  const body = lines.slice(start, foot).map((l) => {
    let s = l.replace(/※［＃[^］]*］/g, (m) => {
      if (!(m in gaiji)) throw new Error(`${file}: 未知の外字 ${m}`);
      return gaiji[m];
    });
    s = s.replace(/［＃[^］]*］/g, "").replace(/《[^》]*》/g, "").replaceAll("｜", "");
    s = s.replaceAll("／″＼", "〴〵").replaceAll("／＼", "〳〵");
    return s;
  });
  return { title: lines[0], body: body.join("\n"), foot: lines.slice(foot).join("\n") };
}

