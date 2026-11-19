// up in the air: polls /api/planes and draws the stats strip, the positions
// plot, the altitude ladder, the sortable "in the air" table and the ground
// cards.

interface Airport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
}

interface Plane {
  hex: string;
  callsign: string;
  flight_iata: string;
  reg: string;
  type_code: string;
  type_name: string;
  airline: string;
  owner: string;
  private: boolean;
  origin: Airport | null;
  dest: Airport | null;
  route_doubtful: boolean;
  pending_route: boolean;
  pending_aircraft: boolean;
  alt_ft: number;
  ground: boolean;
  vehicle: boolean;
  rate_fpm: number | null;
  gs: number;
  track: number | null;
  dist_nm: number;
  bearing: number;
  dir: string;
  squawk: string;
  alert: string;
  military: boolean;
}

interface Snapshot {
  at: number;
  feed: string;
  center: { lat: number; lon: number; radius_nm: number };
  refresh_s: number;
  pending: number;
  planes: Plane[];
  stale_error: string;
  next_in_s: number;
}

interface ApiError {
  error: string;
  next_in_s?: number;
}

declare global {
  interface Window {
    API_BASE_URL?: string;
    UITA_RADII?: number[];
    UITA_DEFAULT_NM?: number;
  }
}

const API = window.API_BASE_URL || "/api";
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
function span(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
const minus = (n: number, digits: number): string => (n < 0 ? "−" : "") + Math.abs(n).toFixed(digits);

// ---------------------------------------------------------------------------
// radius: per browser. ?nm= in the URL wins, then what this browser last
// picked, then the server default.
// ---------------------------------------------------------------------------

const RADII = window.UITA_RADII || [5];
const RADIUS_KEY = "up-in-the-air.radius_nm";

function validRadius(v: string | null): number | null {
  const n = Number(v);
  return v !== null && RADII.includes(n) ? n : null;
}
function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

let radius =
  validRadius(new URLSearchParams(window.location.search).get("nm")) ??
  validRadius(stored(RADIUS_KEY)) ??
  validRadius(stored("overhead.radius_nm")) ?? // the app's old name
  window.UITA_DEFAULT_NM ??
  RADII[0];

function setRadius(n: number): void {
  radius = n;
  try {
    window.localStorage.setItem(RADIUS_KEY, String(n));
  } catch {
    /* private window etc.: the choice just won't be remembered */
  }
  const url = new URL(window.location.href);
  url.searchParams.set("nm", String(n));
  window.history.replaceState(null, "", url.toString());
  markRadius();
}

function markRadius(): void {
  $("radius")
    .querySelectorAll<HTMLButtonElement>("button[data-nm]")
    .forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.nm) === radius)));
}

// ---------------------------------------------------------------------------
// view state
// ---------------------------------------------------------------------------

type SortKey = "flight" | "who" | "route" | "type" | "alt" | "rate" | "gs" | "track" | "dist" | "dir";

let last: Snapshot | null = null;
let nextAt = 0; // ms, when the server will next ask the feed
let timer = 0;
let polling = false;
let sort: SortKey = "dist";
let asc = true;
let hover: string | null = null;
let pin: string | null = null;
let groundOpen = true;

const sel = (): string | null => hover || pin;

// ---------------------------------------------------------------------------
// one plane, as the views show it
// ---------------------------------------------------------------------------

interface View {
  p: Plane;
  flight: string;
  sub: string; // callsign/registration under the flight
  who: string;
  route: string;
  routeTitle: string;
  routeSub: string;
  routeKnown: boolean;
  type: string;
  typeSub: string;
  flags: { text: string; alert: boolean }[];
  x: number; // nm east of center
  y: number; // nm north of center
}

function view(p: Plane): View {
  const flight = p.flight_iata || p.callsign || p.reg || p.hex.toUpperCase();
  let who = p.airline;
  if (!who && p.private) who = p.owner || "Private";
  if (!who && p.owner) who = p.owner;
  if (!who && p.military) who = "Military";
  if (p.vehicle) who = "Airport vehicle";
  if (!who && (p.pending_route || p.pending_aircraft)) who = "Looking up…";

  let route = "—";
  let routeSub = "";
  let routeTitle = "";
  let routeKnown = false;
  if (p.origin && p.dest) {
    route = `${p.origin.city || p.origin.name} → ${p.dest.city || p.dest.name}`;
    routeSub = `${p.origin.iata || p.origin.icao} → ${p.dest.iata || p.dest.icao}`;
    routeTitle = `${p.origin.name} → ${p.dest.name}`;
    routeKnown = true;
  } else if (p.pending_route) route = "Looking up…";
  else if (p.route_doubtful) route = "Route on file doesn’t match";

  const flags: View["flags"] = [];
  if (p.alert) flags.push({ text: `squawk ${p.squawk} · ${p.alert}`, alert: true });
  if (p.military) flags.push({ text: "military", alert: false });
  if (p.private) flags.push({ text: "private", alert: false });

  const b = (p.bearing * Math.PI) / 180;
  return {
    p,
    flight,
    sub: p.callsign && p.callsign !== flight ? p.callsign : p.reg && p.reg !== flight ? p.reg : "",
    who,
    route,
    routeTitle,
    routeSub,
    routeKnown,
    type: p.type_name || p.type_code || (p.pending_aircraft ? "…" : "—"),
    typeSub: [p.type_code, p.reg].filter(Boolean).join(" · "),
    flags,
    x: p.dist_nm * Math.sin(b),
    y: p.dist_nm * Math.cos(b),
  };
}

const rate = (v: View): number => v.p.rate_fpm ?? 0;
const rateTxt = (r: number): string => (r >= 300 ? `↑ ${fmt(r)}` : r <= -300 ? `↓ ${fmt(-r)}` : "level");

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

const COLS: [SortKey, string, "l" | "r"][] = [
  ["flight", "Flight", "l"],
  ["who", "Operator", "l"],
  ["route", "Route", "l"],
  ["type", "Aircraft", "l"],
  ["alt", "Alt ft", "r"],
  ["rate", "V/S fpm", "r"],
  ["gs", "GS kt", "r"],
  ["track", "Hdg", "r"],
  ["dist", "Dist nm", "r"],
  ["dir", "Dir", "l"],
];

const SORT_FN: Record<SortKey, (v: View) => string | number> = {
  flight: (v) => v.flight,
  who: (v) => v.who,
  route: (v) => v.route,
  type: (v) => v.type,
  alt: (v) => v.p.alt_ft,
  rate,
  gs: (v) => v.p.gs,
  track: (v) => v.p.track ?? -1,
  dist: (v) => v.p.dist_nm,
  dir: (v) => v.p.bearing,
};

function renderStats(air: View[], ground: View[], r: number): void {
  const nearest = [...air].sort((a, b) => a.p.dist_nm - b.p.dist_nm)[0];
  const highest = [...air].sort((a, b) => b.p.alt_ft - a.p.alt_ft)[0];
  const climbing = air.filter((v) => rate(v) >= 300).length;
  const descending = air.filter((v) => rate(v) <= -300).length;
  const stats = [
    { label: "In the air", value: String(air.length), unit: "", sub: `within ${r} nm` },
    { label: "Ground", value: String(ground.length), unit: "", sub: `${ground.filter((v) => v.p.gs > 3).length} moving` },
    {
      label: "Nearest",
      value: nearest ? nearest.p.dist_nm.toFixed(1) : "—",
      unit: nearest ? "nm" : "",
      sub: nearest ? `${nearest.flight} · ${nearest.p.dir}` : "nothing airborne",
    },
    {
      label: "Highest",
      value: highest ? fmt(highest.p.alt_ft) : "—",
      unit: highest ? "ft" : "",
      sub: highest ? highest.flight : "nothing airborne",
    },
    { label: "Climb / desc.", value: `${climbing}/${descending}`, unit: "", sub: `${air.length - climbing - descending} level` },
  ];
  $("stats").innerHTML = stats
    .map(
      (s) => `<div class="stat">
        <div class="eyebrow-sm">${esc(s.label)}</div>
        <div class="stat-value">${esc(s.value)}${s.unit ? `<span class="stat-unit">${esc(s.unit)}</span>` : ""}</div>
        <div class="stat-sub">${esc(s.sub)}</div>
      </div>`,
    )
    .join("");
}

function renderPlot(all: View[], r: number): void {
  const scale = 180 / r;
  const s = sel();
  const rings = [0.25, 0.5, 0.75, 1]
    .map(
      (f) => `<circle class="grid" cx="200" cy="200" r="${180 * f}"></circle>
        <text class="ring-label" x="196" y="${196 - 180 * f}">${+(r * f).toFixed(2)} nm</text>`,
    )
    .join("");
  const dots = all
    .map((v) => {
      const hi = s === v.p.hex;
      const x = 200 + v.x * scale;
      const y = 200 - v.y * scale;
      const t = ((v.p.track ?? 0) * Math.PI) / 180;
      const len = v.p.ground || v.p.track === null ? 0 : hi ? 20 : 13;
      const color = hi ? "var(--accent)" : v.p.ground ? "var(--ink-3)" : "var(--ink)";
      const pinned = pin === v.p.hex;
      // a pinned plane's dot turns pale green; hover alone only enlarges it
      const fill = pinned ? "var(--pin)" : v.p.ground ? "var(--paper)" : color;
      const ring = pinned ? "var(--pin-edge)" : color;
      const label = v.p.ground && !hi ? "" : v.flight;
      return {
        hi,
        svg: `<g class="dot${hi ? " is-sel" : ""}" data-hex="${esc(v.p.hex)}">
          ${len ? `<line x1="${x}" y1="${y}" x2="${x + Math.sin(t) * len}" y2="${y - Math.cos(t) * len}" stroke="${color}" stroke-width="1.5"></line>` : ""}
          <circle cx="${x}" cy="${y}" r="${hi ? 6 : 4}" fill="${fill}" stroke="${ring}" stroke-width="1.5"></circle>
          <circle cx="${x}" cy="${y}" r="12" fill="transparent"></circle>
          ${label ? `<text class="dot-label" x="${x + 8}" y="${y - 6}" fill="${color}">${esc(label)}</text>` : ""}
        </g>`,
      };
    })
    .sort((a, b) => Number(a.hi) - Number(b.hi)) // the selected plane on top
    .map((d) => d.svg)
    .join("");
  $("plot").innerHTML = `<svg viewBox="0 0 400 400" role="img" aria-label="Aircraft positions around the center">
    ${rings}
    <line class="grid" x1="200" y1="14" x2="200" y2="386"></line>
    <line class="grid" x1="14" y1="200" x2="386" y2="200"></line>
    <text class="compass" x="200" y="8">N</text>
    <text class="compass" x="397" y="203">E</text>
    <text class="compass" x="200" y="400">S</text>
    <text class="compass" x="3" y="203">W</text>
    <circle cx="200" cy="200" r="3" fill="var(--accent)"></circle>
    ${dots}
  </svg>`;
}

function renderLadder(air: View[], none: string): void {
  const ceil = Math.ceil(Math.max(10000, ...air.map((v) => v.p.alt_ft)) / 10000) * 10000;
  $("alt-scale").textContent = `scale 0 – ${fmt(ceil)} ft`;
  if (!air.length) {
    $("ladder").innerHTML = `<p class="empty">${esc(none)}</p>`;
    return;
  }
  $("ladder").innerHTML = [...air]
    .sort((a, b) => b.p.alt_ft - a.p.alt_ft)
    .map((v) => {
      const r = rate(v);
      const trend = r >= 300 ? "↑" : r <= -300 ? "↓" : "·";
      return `<div class="ladder-row" data-hex="${esc(v.p.hex)}">
        <span class="ladder-flight">${esc(v.flight)}</span>
        <div class="ladder-track"><div class="ladder-bar" style="width:${((v.p.alt_ft / ceil) * 100).toFixed(1)}%"></div></div>
        <span class="ladder-alt">${fmt(v.p.alt_ft)} <span>${trend}</span></span>
      </div>`;
    })
    .join("");
}

function renderTable(air: View[], none: string): void {
  $("thead").innerHTML = COLS.map(
    ([k, label, align]) =>
      `<button type="button" data-sort="${k}" class="${align === "r" ? "r " : ""}${sort === k ? "is-sorted" : ""}">${esc(label)}${
        sort === k ? (asc ? " ↑" : " ↓") : ""
      }</button>`,
  ).join("");
  const sortLabel = COLS.find((c) => c[0] === sort)![1].toLowerCase();
  $("air-caption").textContent = `${air.length} aircraft · sorted by ${sortLabel} · click a row to pin it on the plot`;

  const fn = SORT_FN[sort];
  const rows = [...air].sort((a, b) => {
    const x = fn(a);
    const y = fn(b);
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return asc ? c : -c;
  });
  if (!rows.length) {
    $("rows").innerHTML = `<p class="empty">${esc(none)}</p>`;
    return;
  }
  $("rows").innerHTML = rows
    .map((v) => {
      const p = v.p;
      const r = rate(v);
      const flags = v.flags.length
        ? `<div class="flags">${v.flags.map((f) => `<span class="flag${f.alert ? " alert" : ""}">${esc(f.text)}</span>`).join("")}</div>`
        : "";
      return `<div class="trow${p.alert ? " is-alert" : ""}" data-hex="${esc(p.hex)}">
        <div><div class="flight">${esc(v.flight)}</div><div class="mono">${esc(v.sub)}</div></div>
        <div><div class="cell-main">${esc(v.who)}</div>${flags}</div>
        <div><div class="cell-main${v.routeKnown ? "" : " muted"}" title="${esc(v.routeTitle)}">${esc(v.route)}</div><div class="cell-sub">${esc(v.routeSub)}</div></div>
        <div><div class="cell-main">${esc(v.type)}</div><div class="mono">${esc(v.typeSub)}</div></div>
        <div class="r num">${fmt(p.alt_ft)}</div>
        <div class="r num${Math.abs(r) >= 300 ? "" : " muted"}">${rateTxt(r)}</div>
        <div class="r num">${p.gs}</div>
        <div class="r num" style="white-space:nowrap">${
          p.track === null ? "—" : `<span class="needle" style="transform:rotate(${p.track}deg)">↑</span> ${p.track}°`
        }</div>
        <div class="r num dist">${p.dist_nm.toFixed(1)}</div>
        <div class="muted">${esc(p.dir)}</div>
      </div>`;
    })
    .join("");
}

function renderGround(ground: View[]): void {
  $("ground-wrap").hidden = ground.length === 0;
  $("ground-caption").textContent = `${ground.length} · ${groundOpen ? "hide" : "show"}`;
  $("ground").hidden = !groundOpen;
  $("ground").innerHTML = ground
    .map((v) => {
      const p = v.p;
      const motion = p.vehicle ? (p.gs > 3 ? `moving ${p.gs} kt` : "stopped") : p.gs > 3 ? `taxiing ${p.gs} kt` : "parked";
      const line = [motion, v.routeKnown ? v.routeSub : "", p.type_code].filter(Boolean).join(" · ");
      return `<div class="gcard">
        <div class="gcard-head">
          <span class="flight">${esc(v.flight)}</span>
          <span class="gcard-where"><strong>${p.dist_nm.toFixed(1)} nm</strong> <span class="muted">${esc(p.dir)}</span></span>
        </div>
        <div class="gcard-who">${esc(v.who)}</div>
        <div class="gcard-line">${esc(line)}</div>
      </div>`;
    })
    .join("");
}

function renderNotice(air: View[], s: Snapshot | null, error = ""): void {
  const notes: string[] = [];
  const alerts = air.filter((v) => v.p.alert);
  for (const a of alerts) {
    notes.push(`${a.flight} is squawking ${a.p.squawk} (${a.p.alert}), ${a.p.dist_nm.toFixed(1)} nm ${a.p.dir}.`);
  }
  if (error) notes.push(error);
  if (s?.stale_error) notes.push(`The feed didn’t answer, so this is the last good list (${s.stale_error}).`);
  if (s?.pending) notes.push(`Still looking up ${s.pending} plane${s.pending === 1 ? "" : "s"}; they’ll fill in shortly.`);
  const el = $("notice");
  el.textContent = notes.join(" ");
  el.hidden = notes.length === 0;
  el.classList.toggle("is-alert", alerts.length > 0);
}

function renderMeta(): void {
  if (!last) return;
  const age = Date.now() / 1000 - last.at;
  const next = (nextAt - Date.now()) / 1000;
  $("meta").textContent = `last poll ${span(age)} ago · ` + (polling || next <= 0 ? "updating…" : `next in ${span(next)}`);
}

let views: { all: View[]; air: View[]; ground: View[] } = { all: [], air: [], ground: [] };

function render(): void {
  const s = last;
  if (!s) return;
  const r = s.center.radius_nm;
  const all = s.planes.map(view);
  const air = all.filter((v) => !v.p.ground);
  const ground = all.filter((v) => v.p.ground);
  views = { all, air, ground };
  const none = all.length ? `Nothing in the air within ${r} nm right now.` : `No aircraft within ${r} nm right now.`;

  renderNotice(air, s);
  renderStats(air, ground, r);
  renderPlot(all, r);
  renderLadder(air, none);
  renderTable(air, none);
  renderGround(ground);
  applySel();
  $("feed").textContent = s.feed;
  $("center").textContent = `centered on ${minus(s.center.lat, 3)}, ${minus(s.center.lon, 3)} · radius ${r} nm`;
  renderMeta();
}

/** Hover/pin highlight without rebuilding the table (rebuilding under the
 *  pointer would fire mouseleave/mouseenter in a loop). */
function applySel(): void {
  const s = sel();
  document.querySelectorAll<HTMLElement>(".trow[data-hex], .ladder-row[data-hex]").forEach((el) => {
    el.classList.toggle("is-sel", el.dataset.hex === s);
  });
  if (last) renderPlot(views.all, last.center.radius_nm);
}

function showError(msg: string, retryIn: number): void {
  const when = `Trying again in ${span(retryIn)}.`;
  if (last) {
    renderNotice(views.air, last, `Couldn’t refresh: ${msg} ${when}`);
    return;
  }
  renderNotice([], null, `No position feed is answering right now (${msg}). ${when}`);
  $("stats").innerHTML = "";
  $("plot").innerHTML = "";
  $("ladder").innerHTML = "";
  $("rows").innerHTML = `<p class="empty">No position feed is answering right now. ${esc(when)}</p>`;
  $("meta").textContent = "not loaded yet";
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

async function poll(force = false): Promise<void> {
  if (polling) return;
  polling = true;
  const btn = $("poll-now") as HTMLButtonElement;
  btn.disabled = true;
  if (force) btn.textContent = "Polling…";
  renderMeta();
  let wait = 60;
  const asked = radius;
  try {
    const q = `?nm=${encodeURIComponent(String(asked))}`;
    const res = force
      ? await fetch(`${API}/poll${q}`, { method: "POST", cache: "no-store" })
      : await fetch(`${API}/planes${q}`, { cache: "no-store" });
    let body: Snapshot | ApiError;
    try {
      body = (await res.json()) as Snapshot | ApiError;
    } catch {
      body = { error: `the server answered HTTP ${res.status}` };
    }
    if (asked !== radius) {
      wait = 0; // the radius changed while this was in flight: ask again for the new one
    } else if ("error" in body) {
      wait = Math.max(10, body.next_in_s ?? 60);
      nextAt = Date.now() + wait * 1000;
      showError(body.error, wait);
    } else {
      nextAt = Date.now() + body.next_in_s * 1000;
      last = body;
      polling = false;
      render();
      // lookups fill in from the server's cached feed answer; otherwise wait for the next feed call
      wait = body.pending ? 5 : body.next_in_s + 2;
    }
  } catch (e) {
    showError(`couldn’t reach the server (${e instanceof Error ? e.message : String(e)}).`, wait);
  }
  polling = false;
  btn.disabled = false;
  btn.textContent = "Poll now ↻";
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void poll(), wait * 1000);
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

$("poll-now").addEventListener("click", () => void poll(true));

$("radius").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-nm]");
  if (!b || Number(b.dataset.nm) === radius) return;
  setRadius(Number(b.dataset.nm));
  hover = pin = null;
  void poll();
});

$("thead").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-sort]");
  if (!b) return;
  const k = b.dataset.sort as SortKey;
  asc = sort === k ? !asc : !["alt", "gs", "rate"].includes(k);
  sort = k;
  render();
});

$("ground-toggle").addEventListener("click", () => {
  groundOpen = !groundOpen;
  render();
});

// hover + pin, shared by the plot dots, ladder rows and table rows
const hexOf = (t: EventTarget | null): string | null =>
  t instanceof Element ? (t.closest<HTMLElement | SVGElement>("[data-hex]")?.dataset.hex ?? null) : null;

document.addEventListener("mouseover", (e) => {
  const h = hexOf(e.target);
  if (h !== hover) {
    hover = h;
    applySel();
  }
});
document.addEventListener("click", (e) => {
  const h = hexOf(e.target);
  if (!h) return;
  pin = pin === h ? null : h;
  applySel();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void poll();
  else window.clearTimeout(timer);
});

markRadius();
window.setInterval(renderMeta, 1000);
void poll();

export {};
