#!/usr/bin/env node
// 実際のブラウザ(iPhone の画面サイズ)でタイムラインを動かし、画面に出た文章をすべて原文と照らし合わせる。
// 使い方: node tools/e2e.cjs [押す回数]   (Playwright が必要)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium, devices } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const PRESSES = Number(process.argv[2] || 300);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const norm = (s) => s.split("\n").map((l) => l.replace(/[ 　\t]+$/, "")).filter((l) => l.trim() !== "").join("\n");

async function main() {
  // 照合用の原文(build の出力ではなく、verify.mjs と同じ独自の読み解き結果を使う)
  const index = JSON.parse(fs.readFileSync(path.join(DOCS, "data/index.json")));
  const { original } = await import(pathToFileURL(path.join(__dirname, "original.mjs")));
  const byId = new Map(index.map((w) => [w.id, { ...w, orig: norm(original(w.source).body) }]));
  const byTitle = new Map([...byId.values()].map((w) => [w.title, w]));

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
  await page.waitForSelector(".post .more");

  let bad = 0, checked = 0, taps = 0;
  const cards = { trivia: 0, similar: 0 };
  const ng = (...a) => { bad++; console.error("NG", ...a); };

  for (let k = 0; k < PRESSES; k++) {
    // ときどき下までスクロールしてタイムラインを伸ばす
    if (k % 10 === 0) {
      await page.evaluate(() => { const m = document.getElementById("scroller"); m.scrollTop = m.scrollHeight; });
      await page.waitForTimeout(150);
    }
    const buttons = await page.$$(".post .more");
    // 同じ投稿を何回か押すことも、別の投稿を押すこともある
    const btn = buttons[(k * 7) % buttons.length];
    await btn.click({ force: true });
    await page.waitForFunction(() => !document.body.dataset.busy);
    const card = await btn.evaluate((b) => {
      const post = b.closest(".post");
      if (!post) return null; // 読み終えた投稿のボタンは、次の作品を出したあと消える
      const c = post.querySelector(".post-slot .card");
      if (!c) return null;
      return { cls: c.className, text: c.querySelector(".text").textContent, title: c.querySelector("b")?.textContent || null, label: c.querySelector(".head span").textContent };
    });
    if (!card) continue;
    if (card.cls.includes("similar")) {
      cards.similar++;
      checked++;
      if (card.label !== "🎁 似た作品") ng("カードのラベル", card.label);
      if (!byTitle.get(card.title)?.orig.includes(norm(card.text))) ng("カードの文章が原文にない", card.title);
      if (k % 9 === 0) {
        await btn.evaluate((b) => b.closest(".post").querySelector(".post-slot .card.similar").click());
        taps++;
        await page.waitForTimeout(30);
      }
    } else cards.trivia++;
  }

  // すべての投稿: 本文が、その作品の原文の切れ目のない一部であること
  const posts = await page.$$eval(".post", (ps) => ps.map((p) => ({
    work: p.dataset.work,
    title: p.querySelector(".post-title").textContent,
    paras: [...p.querySelectorAll(".post-body p")].map((x) => x.textContent),
  })));
  const titles = new Set();
  for (const p of posts) {
    const w = byId.get(p.work);
    checked++;
    titles.add(p.title);
    if (!w || w.title !== p.title) { ng("投稿の題名と作品が合わない", p.title); continue; }
    if (!w.orig.includes(norm(p.paras.join("\n")))) ng("投稿の文章が原文にない", p.title);
  }

  // 画面に説明文(「ガチャ」など)や偽の統計が出ていないこと
  const bodyText = await page.textContent("body");
  if (/ガチャ|発動|上位\s*\d+\s*%|ランキング/.test(bodyText)) ng("説明文/偽の統計が出ている");
  // ボタンは各投稿の「続きを読む」だけ
  const labels = await page.$$eval("button, [role=button]", (b) => [...new Set(b.map((x) => x.textContent.trim()))]);
  if (labels.length !== 1 || labels[0] !== "続きを読む") ng("ボタン", labels);
  if (errors.length) ng("JS エラー", errors);

  await page.screenshot({ path: path.join(process.env.SHOT_DIR || ROOT, "e2e-last.png") });
  await browser.close();
  server.close();
  console.log(`presses: ${PRESSES}, 投稿: ${posts.length} (${titles.size}作品), カード: 豆知識 ${cards.trivia} / 似た作品 ${cards.similar}, タップで投稿追加: ${taps}, 照合: ${checked}`);
  if (bad) { console.error(`FAILED: ${bad}`); process.exit(1); }
  console.log("OK: 画面に出た文章はすべて原文の連続した部分でした。");
}
main().catch((e) => { console.error(e); process.exit(1); });
