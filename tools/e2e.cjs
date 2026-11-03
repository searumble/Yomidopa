#!/usr/bin/env node
// 実際のブラウザ(iPhone の画面サイズ)でアプリを動かし、画面に出た文章をすべて原文と照らし合わせる。
// 使い方: node tools/e2e.cjs [押す回数]   (Playwright が必要)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, devices } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const PRESSES = Number(process.argv[2] || 400);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const norm = (s) => s.split("\n").map((l) => l.replace(/[ 　\t]+$/, "")).filter((l) => l.trim() !== "").join("\n");

async function main() {
  // 照合用の原文(build の出力ではなく verify.mjs と同じ独自の読み解き結果を使う)
  const { pathToFileURL } = require("node:url");
  const index = JSON.parse(fs.readFileSync(path.join(DOCS, "data/index.json")));
  const verifyOrig = await import(pathToFileURL(path.join(__dirname, "original.mjs")));
  const originals = new Map(index.map((w) => [w.title, norm(verifyOrig.original(w.source).body)]));

  const server = http.createServer((req, res) => {
    const p = path.join(DOCS, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      res.end(buf);
    });
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector("#more:not([disabled])");

  let bad = 0, checked = 0, cards = { trivia: 0, similar: 0 }, jumps = 0;
  const seenTitles = new Set();
  for (let k = 0; k < PRESSES; k++) {
    await page.click("#more", { force: true });
    await page.waitForFunction(() => !document.body.dataset.busy);
    await page.waitForTimeout(15);
    const card = await page.$eval("#slot", (el) => {
      const c = el.querySelector(".card");
      if (!c) return null;
      return { cls: c.className, text: c.querySelector(".text").textContent, title: c.querySelector("b")?.textContent || null, label: c.querySelector(".head span").textContent };
    });
    if (card) {
      if (card.cls.includes("similar")) {
        cards.similar++;
        if (card.label !== "🎁 似た作品") { bad++; console.error("NG ラベル", card.label); }
        checked++;
        if (!originals.get(card.title)?.includes(norm(card.text))) { bad++; console.error("NG カード", card.title, card.text.slice(0, 30)); }
        // ときどきタップして作品を移る
        if (k % 37 === 0) { await page.evaluate(() => window.__yomiTrace.push(["JUMP"])); await page.click("#slot .card.similar", { force: true }); jumps++; await page.waitForTimeout(30); }
      } else cards.trivia++;
    }
  }
  // 流れに出た本文: 題名ブロックごとに区切って、その作品の原文と照らし合わせる
  const blocks = await page.$eval("#flow", (flow) => {
    const out = [];
    let cur = null;
    for (const el of flow.children) {
      if (el.classList.contains("title")) { cur = { title: el.querySelector("h1").textContent, paras: [] }; out.push(cur); }
      else if (cur) cur.paras.push(el.textContent);
    }
    return out;
  });
  for (const b of blocks) {
    seenTitles.add(b.title);
    const o = originals.get(b.title);
    const joined = norm(b.paras.join("\n"));
    checked++;
    if (!o || !o.includes(joined)) {
      bad++;
      console.error("NG 本文", b.title);
      let acc = "";
      for (let i = 0; i < b.paras.length; i++) {
        const n = norm(acc + "\n" + b.paras[i]);
        if (!o.includes(n)) { console.error(`  段落 ${i} / ${b.paras.length} でつながらない`); if (process.env.DEBUG) console.error(JSON.stringify(b.paras.slice(Math.max(0, i - 1), i + 1).map((p) => p.slice(0, 50) + " … " + p.slice(-20)))); break; }
        acc = n;
      }
    }
  }
  if (bad && process.env.DEBUG) {
    const trace = await page.evaluate(() => window.__yomiTrace);
    console.error(JSON.stringify(trace.filter((t) => t[0] === "JUMP" || t[1] === "title" || true).slice(-400)));
  }
  // 画面に説明文(「ガチャ」など)が出ていないこと
  const bodyText = await page.textContent("body");
  if (/ガチャ|発動|上位\s*\d+\s*%|ランキング/.test(bodyText)) { bad++; console.error("NG 説明文/偽の統計が出ている"); }
  const buttons = await page.$$eval("button, [role=button]", (b) => b.map((x) => x.textContent.trim()));
  if (buttons.length !== 1 || buttons[0] !== "続きを読む") { bad++; console.error("NG ボタン", buttons); }
  if (errors.length) { bad++; console.error("NG JS エラー", errors); }

  await page.screenshot({ path: path.join(process.env.SHOT_DIR || ROOT, "e2e-last.png") });
  await browser.close();
  server.close();
  console.log(`presses: ${PRESSES}, 作品ブロック: ${blocks.length} (${seenTitles.size}作品), カード: 豆知識 ${cards.trivia} / 似た作品 ${cards.similar}, タップで移動: ${jumps}, 照合: ${checked}`);
  if (bad) { console.error(`FAILED: ${bad}`); process.exit(1); }
  console.log("OK: 画面に出た文章はすべて原文の連続した部分でした。");
}
main().catch((e) => { console.error(e); process.exit(1); });
