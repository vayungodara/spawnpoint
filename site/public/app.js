/* Spawnpoint · HUD, physics-y microinteractions, world descent */
(() => {
"use strict";

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const PRM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FINE = matchMedia("(pointer: fine)").matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- square particles (shared canvas) ---------- */
const fx = $("#fx");
const ctx = fx.getContext("2d");
let parts = [], fxLive = false, DPR = 1;

function fxSize() {
  DPR = clamp(devicePixelRatio || 1, 1, 2);
  fx.width = innerWidth * DPR;
  fx.height = innerHeight * DPR;
}
fxSize();
addEventListener("resize", fxSize, { passive: true });

function burst(x, y, colors, n = 16, power = 1) {
  if (PRM) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = (2 + Math.random() * 4.5) * power;
    parts.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 3.2 * power,
      s: 3 + Math.random() * 4,
      c: colors[(Math.random() * colors.length) | 0],
      l: 1, d: 0.02 + Math.random() * 0.018,
    });
  }
  if (!fxLive) { fxLive = true; requestAnimationFrame(fxTick); }
}
function fxTick() {
  ctx.clearRect(0, 0, fx.width, fx.height);
  parts = parts.filter(p => p.l > 0);
  if (!parts.length) { fxLive = false; return; }
  for (const p of parts) {
    p.vy += 0.22; p.vx *= 0.985;
    p.x += p.vx; p.y += p.vy; p.l -= p.d;
    ctx.globalAlpha = clamp(p.l, 0, 1);
    ctx.fillStyle = p.c;
    const s = p.s * DPR;
    ctx.fillRect((p.x * DPR - s / 2) | 0, (p.y * DPR - s / 2) | 0, s | 0, s | 0);
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(fxTick);
}
const PALETTES = {
  emerald: ["#4ec97a", "#2e9c55", "#eafff2", "#1b2130"],
  stone:   ["#a2a8b0", "#787f88", "#c6cad1", "#1b2130"],
  redstone:["#e2483d", "#8e2a22", "#ffd85e"],
  grass:   ["#7cc24f", "#5c9c3c", "#8a5f3c"],
};
document.addEventListener("pointerdown", e => {
  const el = e.target.closest("[data-burst]");
  if (!el) return;
  const pal = el.classList.contains("btn-emerald") || el.classList.contains("slot-go")
    ? PALETTES.emerald : PALETTES.stone;
  burst(e.clientX, e.clientY, pal, 18);
});

/* ---------- block-targeting outline ---------- */
const tgt = $("#tgt");
const TGT_SEL = ".btn, .slot, .faq-q, .tier, .loader-track li, .lever, .tile, .logo";
if (FINE && !PRM) {
  let cur = null;
  document.addEventListener("pointerover", e => {
    const el = e.target.closest(TGT_SEL);
    if (!el || el === cur) return;
    cur = el;
    const r = el.getBoundingClientRect();
    const pad = el.classList.contains("tile") || el.classList.contains("tier") ? 8 : 6;
    tgt.style.width  = r.width + pad * 2 + "px";
    tgt.style.height = r.height + pad * 2 + "px";
    tgt.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
    tgt.classList.add("on");
  });
  document.addEventListener("pointerout", e => {
    if (cur && !e.relatedTarget?.closest?.(TGT_SEL)) { cur = null; tgt.classList.remove("on"); }
  });
  addEventListener("scroll", () => { cur = null; tgt.classList.remove("on"); }, { passive: true });
}

/* ---------- world descent: yhud, xp, header, parallax ---------- */
const yhud = $("#yhud"), yhY = $(".yh-y"), yhB = $(".yh-b");
const head = $(".site-head");
const xpFill = $(".xp-fill"), xpLvl = $(".xp-lvl");
const clouds = $(".clouds"), sun = $(".sun");
const f3y = $("#f3y"), f3b = $("#f3b");
const sections = $$("main > .band");
yhud.classList.add("on");

let heroH = innerHeight, docH = 1, ticking = false, biome = "SKY", lvl = 0;

function measure() {
  heroH = sections[0].offsetHeight;
  docH = document.documentElement.scrollHeight - innerHeight;
}
measure();
addEventListener("resize", () => { measure(); onScroll(); }, { passive: true });
addEventListener("load", measure);

function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const sy = scrollY;
    const p = clamp(sy / docH, 0, 1);
    /* Y: 320 at top → -64 at bottom */
    const yv = Math.round(320 - p * 384);
    yhY.textContent = "Y " + yv;
    f3y.textContent = yv;
    xpFill.style.setProperty("--p", p.toFixed(4));
    head.classList.toggle("scrolled", sy > 40);
    document.body.classList.toggle("deep", sy > heroH * 0.45);
    if (!PRM && sy < heroH) {
      clouds.style.transform = `translateY(${sy * 0.18}px)`;
      sun.style.transform = `translateY(${sy * 0.3}px)`;
    }
  });
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ---------- scrollspy: hotbar selection + biome ---------- */
const slots = $$("#hotbar .slot");
const slotByHash = Object.fromEntries(slots.map(s => [s.getAttribute("href"), s]));
const spy = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const sec = en.target;
    biome = sec.dataset.biome || biome;
    yhB.textContent = biome;
    f3b.textContent = "minecraft:" + biome.toLowerCase();
    lvl = sections.indexOf(sec);
    xpLvl.textContent = lvl;
    slots.forEach(s => s.removeAttribute("aria-current"));
    slotByHash["#" + sec.id]?.setAttribute("aria-current", "true");
  }
}, { rootMargin: "-42% 0px -42% 0px" });
sections.forEach(s => spy.observe(s));

/* hotbar keys 1-7 */
const keySlots = Object.fromEntries(slots.map(s => [s.dataset.key, s]));
addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "F3") {
    e.preventDefault();
    const f3 = $("#f3");
    f3.hidden = !f3.hidden;
    f3.hidden ? stopFps() : startFps();
    return;
  }
  const slot = keySlots[e.key];
  if (!slot) return;
  slot.click();
  slot.classList.add("kbd-hit");
  const r = slot.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top, PALETTES.stone, 8, 0.7);
});

/* ---------- reveals ---------- */
const rvIO = new IntersectionObserver(entries => {
  for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); rvIO.unobserve(en.target); }
}, { threshold: 0.12, rootMargin: "0px 0px -4% 0px" });
$$("[data-rv]").forEach(el => rvIO.observe(el));

/* ---------- FAQ torches ---------- */
$$(".faq-q").forEach(q => {
  q.addEventListener("click", () => {
    const item = q.closest(".faq-item");
    const open = item.classList.toggle("open");
    q.setAttribute("aria-expanded", open);
    q.querySelector(".tgl use").setAttribute("href", open ? "#i-minus" : "#i-plus");
    if (open) {
      const t = q.querySelector(".torch").getBoundingClientRect();
      burst(t.left + t.width / 2, t.top + 4, ["#ffd85e", "#f2a23c", "#f7f3e8"], 7, 0.55);
    }
  });
});

/* ---------- billing lever ---------- */
const lever = $("#lever");
const billing = $(".billing");
const pricing = $("#pricing");
billing.classList.add("is-m");
lever.addEventListener("click", () => {
  const yearly = lever.getAttribute("aria-checked") !== "true";
  lever.setAttribute("aria-checked", yearly);
  billing.classList.toggle("is-y", yearly);
  billing.classList.toggle("is-m", !yearly);
  pricing.classList.toggle("is-y-page", yearly);
  const r = lever.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, yearly ? PALETTES.redstone : PALETTES.stone, 12, 0.8);
  $$(".tier").forEach(tier => {
    const amt = $(".amt", tier), billed = $(".billed", tier);
    const k = yearly ? "y" : "m";
    amt.classList.remove("swap");
    void amt.offsetWidth;
    amt.textContent = amt.dataset[k];
    billed.textContent = billed.dataset[k];
    amt.classList.add("swap");
  });
});

/* ---------- Spawnpoint console replica ---------- */
const consoleEl = $("#console");
const spark = $("#spark");
const ptps = $("#ptps");
const pplayers = $("#pplayers");
const NAMES = ["Kira", "wattson", "Blockbuster_Ben", "eline", "MossyCobble", "Piglin_Pete", "ada_lovelace", "Redstone_Rosa"];
const WISHES = ["give everyone a maxed pickaxe", "build a cobblestone farm", "make it stop raining", "tp us all somewhere safe"];
const LOGS = [
  () => `[${ts()}] ${pick(NAMES)} joined the game`,
  () => `[${ts()}] ${pick(NAMES)} has made the advancement [Serious Dedication]`,
  () => `[${ts()}] [Backup] Snapshot #${482 + ((Math.random() * 40) | 0)} stored (12.4 GB, 6.1 s)`,
  () => `[${ts()}] [Spawnpoint] genie: "${pick(WISHES)}" — ${2 + ((Math.random() * 5) | 0)} commands, all ok`,
  () => `[${ts()}] TPS: 20.0 (mspt ${(2.4 + Math.random() * 2.2).toFixed(1)})`,
  () => `[${ts()}] [Chunky] Pregen r=24: ${(88 + Math.random() * 11).toFixed(0)}%`,
  () => `[${ts()}] ${pick(NAMES)} left the game`,
  () => `[${ts()}] [Spawnpoint] Autosave complete (0.8 s, async)`,
  () => `[${ts()}] <${pick(NAMES)}> anyone near the mesa?`,
  () => `[${ts()}] [Spawnpoint] AppleSkin 3.0.10 passed boot and join tests`,
];
let simMin = 13, simSec = 41, players = 5;
function ts() {
  simSec += 3 + ((Math.random() * 20) | 0);
  if (simSec > 59) { simMin += 1 + (simSec / 60 | 0) - 1, simSec %= 60; }
  if (simMin > 59) simMin = 0;
  return `06:${String(simMin).padStart(2, "0")}:${String(simSec).padStart(2, "0")}`;
}
const pick = a => a[(Math.random() * a.length) | 0];

let sparkPts = [4, 4, 5, 4, 4, 6, 4, 4, 4];
let conTimer = null;
function conTick() {
  const p = document.createElement("p");
  p.textContent = pick(LOGS)();
  p.className = "new";
  consoleEl.append(p);
  while (consoleEl.children.length > 9) consoleEl.firstElementChild.remove();
  /* tps sparkline + stats drift */
  sparkPts.push(clamp(sparkPts.at(-1) + (Math.random() * 2.4 - 1.2), 3, 9));
  if (sparkPts.length > 9) sparkPts.shift();
  spark.setAttribute("points", sparkPts.map((v, i) => `${i * 8},${v.toFixed(1)}`).join(" "));
  const tps = 20 - Math.max(0, (sparkPts.at(-1) - 5)) * 0.05;
  ptps.textContent = tps.toFixed(1);
  if (Math.random() < 0.3) players = clamp(players + (Math.random() < 0.5 ? 1 : -1), 2, 9);
  pplayers.textContent = `${players} / 20`;
}
new IntersectionObserver(entries => {
  for (const en of entries) {
    if (en.isIntersecting && !conTimer) conTimer = setInterval(conTick, 1700);
    else if (!en.isIntersecting && conTimer) { clearInterval(conTimer); conTimer = null; }
  }
}, { threshold: 0.2 }).observe(consoleEl);

/* ---------- F3 fps meter ---------- */
const f3fps = $("#f3fps");
let fpsRAF = null, lastT = 0, ema = 60;
function fpsTick(t) {
  if (lastT) { const inst = 1000 / (t - lastT); ema = ema * 0.9 + inst * 0.1; }
  lastT = t;
  f3fps.textContent = Math.round(ema);
  fpsRAF = requestAnimationFrame(fpsTick);
}
const startFps = () => { lastT = 0; fpsRAF = requestAnimationFrame(fpsTick); };
const stopFps = () => { cancelAnimationFrame(fpsRAF); fpsRAF = null; };

/* ---------- ore sparkle on tier hover ---------- */
if (FINE && !PRM) {
  const ORE_COLS = {
    "tier-iron": ["#dcc6a8", "#a68a66", "#f7f3e8"],
    "tier-gold": ["#e9c53e", "#b8921f", "#fff3c4"],
    "tier-diamond": ["#7fd8df", "#3fa9b8", "#eafcff"],
    "tier-netherite": ["#8a6a4a", "#e9c53e", "#514440"],
  };
  $$(".tier").forEach(tier => {
    tier.addEventListener("mouseenter", () => {
      const ore = $(".ore", tier).getBoundingClientRect();
      const cls = [...tier.classList].find(c => ORE_COLS[c]);
      burst(ore.left + ore.width / 2, ore.top + ore.height / 2, ORE_COLS[cls], 6, 0.5);
    });
  });
}

})();
