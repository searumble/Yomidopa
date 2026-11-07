// 説明ページ共通: config.js の値を画面に入れる(空欄は「準備中」)
import { CONFIG } from "./config.js";

const PENDING = "準備中";

function payButton(label, url) {
  if (url) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    return a;
  }
  const s = document.createElement("span");
  s.textContent = `${label}(${PENDING})`;
  return s;
}

for (const el of document.querySelectorAll("[data-pay]")) {
  const [group, key] = el.dataset.pay.split(".");
  const v = CONFIG[group]?.[key];
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) if (item) el.append(payButton(item.label, item.url));
}
for (const el of document.querySelectorAll("[data-config]")) {
  const v = el.dataset.config.split(".").reduce((o, k) => o?.[k], CONFIG);
  el.textContent = v || PENDING;
  if (v && el.dataset.config === "contactEmail") {
    el.textContent = "";
    const a = document.createElement("a");
    a.href = `mailto:${v}`;
    a.textContent = v;
    el.append(a);
  }
}
