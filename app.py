"""up in the air: the aircraft over a fixed point.

Positions come from adsb.lol (opendata.adsb.fi as the fallback); airline,
route, type and owner come from adsbdb.com. Nothing is kept about the planes
themselves: only the adsbdb lookups are cached (SQLite under DATA_DIR) so a
callsign or airframe is asked about once a week/month, not every refresh.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any

from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

def _coordinate(name: str, limit: float) -> float:
    """LAT/LON are required: there is no sensible default location."""
    raw = os.environ.get(name, "").strip()
    try:
        value = float(raw)
    except ValueError:
        value = None
    if value is None or not -limit <= value <= limit:
        sys.stderr.write(
            f"up-in-the-air: set {name} to your {'latitude' if name == 'LAT' else 'longitude'} in decimal degrees "
            f"(between -{limit:g} and {limit:g}); got {raw!r}. See README.md, step 2.\n"
        )
        raise SystemExit(1)
    return value


LAT = _coordinate("LAT", 90)
LON = _coordinate("LON", 180)
# The feed is always asked for MAX_RADIUS_NM; each browser picks how much of
# that to show (one of RADII, remembered in the browser), RADIUS_NM by default.
MAX_RADIUS_NM = float(os.environ.get("MAX_RADIUS_NM", "25"))
RADII = tuple(r for r in (2.0, 5.0, 10.0, 25.0) if r <= MAX_RADIUS_NM) or (MAX_RADIUS_NM,)
RADIUS_NM = float(os.environ.get("RADIUS_NM", "5"))
if RADIUS_NM not in RADII:
    RADIUS_NM = RADII[0]
REFRESH_S = float(os.environ.get("REFRESH_S", "300"))  # how often the position feed is asked
FEED_RETRY_S = 60.0  # after a failed feed call
FORCE_MIN_S = 15.0  # "poll now" is ignored when the feed was asked less than this long ago
DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
CACHE_DB = os.path.join(DATA_DIR, "lookups.sqlite")

# adsb.fi first: its limit is 1 request/second. adsb.lol caps each IP at
# 500 requests/day (shared with anything else on the same network polling
# it), so it is only the fallback.
FEEDS = (
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}"),
    ("adsb.lol", "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}"),
)
ADSBDB_ROUTE = "https://api.adsbdb.com/v0/callsign/{key}"
ADSBDB_AIRCRAFT = "https://api.adsbdb.com/v0/aircraft/{key}"
UA = "up-in-the-air/0.1"

ROUTE_TTL = 7 * 86400
AIRCRAFT_TTL = 30 * 86400
MISS_TTL = 86400  # "unknown callsign" / "unknown aircraft": ask again tomorrow
LOOKUPS_PER_REFRESH = 16  # new adsbdb questions per refresh; the rest wait for the next one
LOOKUP_BUDGET_S = 8.0

EMERGENCY_SQUAWKS = {"7500": "hijack", "7600": "radio failure", "7700": "emergency"}
COMPASS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Unreachable(Exception):
    """The service did not answer (timeout, DNS, 5xx, 429): not cached.
    retry_after is set (seconds) when the service said how long to wait."""

    def __init__(self, msg: str, retry_after: float | None = None):
        super().__init__(msg)
        self.retry_after = retry_after


def _retry_after(headers: Any) -> float | None:
    for h in ("Retry-After", "X-RateLimit-Reset"):
        try:
            v = float(str(headers.get(h) or "").split(",")[0])
        except ValueError:
            continue
        if v > 0:
            return min(v, 86400.0)
    return None


def get_json(url: str, timeout: float) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:  # adsbdb answers "unknown ..." as a 404 with a JSON body
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:
                return {}
        if e.code == 429:
            raise Unreachable("rate limited (HTTP 429)", _retry_after(e.headers) or 3600.0) from e
        raise Unreachable(f"HTTP {e.code}") from e
    except Exception as e:  # URLError, timeout, bad JSON
        raise Unreachable(str(e)) from e


# --------------------------------------------------------------------------
# lookup cache
# --------------------------------------------------------------------------

_db_lock = threading.Lock()


def _db() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(CACHE_DB, timeout=5)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS lookups (kind TEXT, key TEXT, at REAL, data TEXT, PRIMARY KEY (kind, key))"
    )
    return conn


def cache_get(kind: str, key: str, ttl: float) -> dict | None:
    with _db_lock, _db() as conn:
        row = conn.execute("SELECT at, data FROM lookups WHERE kind=? AND key=?", (kind, key)).fetchone()
    if not row:
        return None
    at, data = row
    out = json.loads(data)
    if time.time() - at > (ttl if out else MISS_TTL):
        return None
    return out


def cache_put(kind: str, key: str, data: dict) -> None:
    with _db_lock, _db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO lookups (kind, key, at, data) VALUES (?, ?, ?, ?)",
            (kind, key, time.time(), json.dumps(data)),
        )


def looks_like_flight(cs: str) -> bool:
    """An airline callsign (DAL1234, SWA12K), not a tail number (N183TS)."""
    return bool(re.fullmatch(r"[A-Z]{3}[0-9][0-9A-Z]{0,4}", cs))


def fetch_route(cs: str) -> dict:
    data = get_json(ADSBDB_ROUTE.format(key=urllib.parse.quote(cs)), timeout=4)
    try:
        fr = data["response"]["flightroute"]
    except (KeyError, TypeError):
        return {}
    airline = fr.get("airline") or {}

    def end(p: dict) -> dict:
        return {
            "iata": p.get("iata_code") or "",
            "icao": p.get("icao_code") or "",
            "name": p.get("name") or "",
            "city": p.get("municipality") or "",
            "country": p.get("country_iso_name") or "",
            "lat": p.get("latitude"),
            "lon": p.get("longitude"),
        }

    return {
        "flight_iata": fr.get("callsign_iata") or "",
        "airline": airline.get("name") or "",
        "airline_country": airline.get("country") or "",
        "origin": end(fr.get("origin") or {}),
        "dest": end(fr.get("destination") or {}),
    }


def fetch_aircraft(hexid: str) -> dict:
    data = get_json(ADSBDB_AIRCRAFT.format(key=urllib.parse.quote(hexid)), timeout=4)
    try:
        a = data["response"]["aircraft"]
    except (KeyError, TypeError):
        return {}
    return {
        "type": " ".join(str(a.get("type") or "").split()),
        "manufacturer": " ".join(str(a.get("manufacturer") or "").split()),
        "icao_type": a.get("icao_type") or "",
        "registration": a.get("registration") or "",
        "owner": " ".join(str(a.get("registered_owner") or "").split()),
        "owner_country": a.get("registered_owner_country_name") or "",
    }


LOOKUPS = {
    "route": (fetch_route, ROUTE_TTL),
    "aircraft": (fetch_aircraft, AIRCRAFT_TTL),
}
_pool = ThreadPoolExecutor(max_workers=6)


def resolve(wanted: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    """Cached answers for every (kind, key), asking adsbdb for at most
    LOOKUPS_PER_REFRESH of the missing ones. Missing answers are absent."""
    found: dict[tuple[str, str], dict] = {}
    missing = []
    for kind, key in dict.fromkeys(wanted):
        got = cache_get(kind, key, LOOKUPS[kind][1])
        if got is None:
            missing.append((kind, key))
        else:
            found[(kind, key)] = got

    def ask(kind: str, key: str) -> tuple[tuple[str, str], dict | None]:
        try:
            out = LOOKUPS[kind][0](key)
        except Unreachable:
            return (kind, key), None
        cache_put(kind, key, out)
        return (kind, key), out

    futures = [_pool.submit(ask, k, key) for k, key in missing[:LOOKUPS_PER_REFRESH]]
    done, _ = wait(futures, timeout=LOOKUP_BUDGET_S)
    for f in done:
        k, out = f.result()
        if out is not None:
            found[k] = out
    return found


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def distance_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    """(nautical miles, degrees true) from point 1 to point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    nm = 3440.065 * 2 * math.asin(math.sqrt(min(1.0, a)))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return nm, (math.degrees(math.atan2(y, x)) + 360) % 360


def compass(deg: float) -> str:
    return COMPASS[int((deg % 360) / 22.5 + 0.5) % 16]


def route_fits(route: dict, plane: dict) -> bool:
    """adsbdb keeps one route per callsign, but a flight number can fly
    several legs: only show a route the plane could plausibly be on (roughly
    between the two airports, and not flying away from the destination)."""
    o, d = route.get("origin") or {}, route.get("dest") or {}
    pts = (o.get("lat"), o.get("lon"), d.get("lat"), d.get("lon"))
    if not all(isinstance(v, (int, float)) for v in pts):
        return True
    olat, olon, dlat, dlon = pts
    direct, _ = distance_bearing(olat, olon, dlat, dlon)
    from_o, _ = distance_bearing(olat, olon, plane["lat"], plane["lon"])
    to_d, brg = distance_bearing(plane["lat"], plane["lon"], dlat, dlon)
    if from_o + to_d > direct * 1.2 + 80:
        return False
    if plane["ground"] or plane["gs"] < 100 or min(from_o, to_d) < 80 or plane["track"] is None:
        return True
    return abs((plane["track"] - brg + 180) % 360 - 180) <= 90


# --------------------------------------------------------------------------
# the snapshot
# --------------------------------------------------------------------------

def num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


_feed_rested_until: dict[str, float] = {}  # feed -> time it may be asked again


def fetch_feed() -> tuple[list[dict], str]:
    """The aircraft list from the first feed that answers. A feed that
    rate-limits us is left alone until it says it will accept us again; a
    feed that fails otherwise is skipped for a minute. An empty list is an
    answer (an empty sky), not a failure."""
    errors = []
    now = time.time()
    order = [f for f in FEEDS if _feed_rested_until.get(f[0], 0) <= now] or list(FEEDS)
    for name, url in order:
        try:
            data = get_json(url.format(lat=f"{LAT:.4f}", lon=f"{LON:.4f}", nm=f"{MAX_RADIUS_NM:g}"), timeout=6)
        except Unreachable as e:
            _feed_rested_until[name] = time.time() + (e.retry_after or 60.0)
            errors.append(f"{name}: {e}")
            continue
        if isinstance(data, dict):
            # adsb.lol says "ac", adsb.fi says "aircraft"
            ac = data.get("ac", data.get("aircraft"))
            if ac is None and (data.get("total") == 0 or data.get("resultCount") == 0):
                ac = []
            if isinstance(ac, list):
                _feed_rested_until.pop(name, None)
                return ac, name
        _feed_rested_until[name] = time.time() + 60.0
        errors.append(f"{name}: unexpected answer")
    raise Unreachable("; ".join(errors))


def parse(a: dict, radius: float) -> dict | None:
    lat, lon = num(a.get("lat")), num(a.get("lon"))
    if lat is None or lon is None:
        return None
    nm, brg = distance_bearing(LAT, LON, lat, lon)
    if nm > radius:
        return None
    alt_raw = a.get("alt_baro")
    alt = 0 if alt_raw == "ground" else int(round(num(alt_raw) or 0))
    rate = num(a.get("baro_rate"))
    if rate is None:
        rate = num(a.get("geom_rate"))
    track = num(a.get("track"))
    if track is None:
        track = num(a.get("true_heading"))
    squawk = str(a.get("squawk") or "")
    flags = a.get("dbFlags") if isinstance(a.get("dbFlags"), int) else 0
    category = str(a.get("category") or "").upper()
    vehicle = category in ("C1", "C2")  # ADS-B emitter category: emergency / service vehicle on the airfield
    return {
        "hex": str(a.get("hex") or "").lower(),
        "callsign": str(a.get("flight") or "").strip().upper(),
        "reg": str(a.get("r") or "").strip().upper(),
        "type_code": str(a.get("t") or "").strip().upper(),
        "desc": " ".join(str(a.get("desc") or "").split()),
        "lat": lat,
        "lon": lon,
        "alt_ft": max(0, alt),
        "ground": vehicle or alt_raw == "ground" or (alt_raw is not None and alt <= 25),
        "vehicle": vehicle,
        "rate_fpm": int(round(rate)) if rate is not None else None,
        "gs": int(round(num(a.get("gs")) or 0)),
        "track": round(track) if track is not None else None,
        "dist_nm": round(nm, 1),
        "bearing": round(brg),
        "dir": compass(brg),
        "squawk": squawk,
        "alert": EMERGENCY_SQUAWKS.get(squawk, ""),
        "military": bool(flags & 1),
        "seen_s": num(a.get("seen")),
    }


def build_snapshot(raw: list, feed: str, at: float, radius: float) -> dict:
    """The feed's answer from `at`, cut to `radius`, with what adsbdb knows
    filled in (only planes inside the radius are looked up)."""
    planes = [p for p in (parse(a, radius) for a in raw if isinstance(a, dict)) if p]

    wanted = []
    for p in planes:
        if p["vehicle"]:
            continue
        if looks_like_flight(p["callsign"]):
            wanted.append(("route", p["callsign"]))
        if p["hex"] and not p["hex"].startswith("~"):  # "~" = TIS-B track, not a real airframe address
            wanted.append(("aircraft", p["hex"]))
    # nearest first, so the nearest planes are filled in first when the lookup cap bites
    planes.sort(key=lambda p: (p["ground"], p["vehicle"], p["dist_nm"]))
    wanted.sort(key=lambda kk: next((i for i, p in enumerate(planes) if kk[1] in (p["callsign"], p["hex"])), 0))
    info = resolve(wanted)

    pending = 0
    for p in planes:
        looked_up = not p["vehicle"]
        route = info.get(("route", p["callsign"])) if looked_up and looks_like_flight(p["callsign"]) else {}
        craft = info.get(("aircraft", p["hex"]), {}) if looked_up and p["hex"] else {}
        p["pending_route"] = looked_up and route is None
        p["pending_aircraft"] = (
            looked_up and bool(p["hex"]) and not p["hex"].startswith("~") and ("aircraft", p["hex"]) not in info
        )
        if p["pending_route"] or p["pending_aircraft"]:
            pending += 1
        route = route or {}

        p["airline"] = route.get("airline", "")
        iata = route.get("flight_iata", "")
        p["flight_iata"] = iata if re.match(r"[A-Z0-9]{2}[0-9]", iata) and not iata.isdigit() else ""
        p["origin"] = p["dest"] = None
        p["route_doubtful"] = False
        if route.get("origin") or route.get("dest"):
            if route_fits(route, p):
                keep = ("iata", "icao", "name", "city", "country")
                p["origin"] = {k: route["origin"].get(k, "") for k in keep}
                p["dest"] = {k: route["dest"].get(k, "") for k in keep}
            else:
                p["route_doubtful"] = True

        p["type_name"] = " ".join(x for x in (craft.get("manufacturer", ""), craft.get("type", "")) if x) or p["desc"]
        p["type_code"] = p["type_code"] or craft.get("icao_type", "")
        p["reg"] = p["reg"] or craft.get("registration", "")
        p["owner"] = craft.get("owner", "")
        p["private"] = bool(p["callsign"]) and p["callsign"].replace("-", "") == p["reg"].replace("-", "")
        for k in ("lat", "lon", "desc"):
            p.pop(k, None)

    return {
        "at": at,
        "feed": feed,
        "center": {"lat": LAT, "lon": LON, "radius_nm": radius},
        "refresh_s": REFRESH_S,
        "pending": pending,
        "planes": planes,
    }


_snap_lock = threading.Lock()
_feed: dict = {"raw": None, "name": "", "at": 0.0, "next": 0.0, "err": ""}
_snaps: dict[float, dict] = {}  # radius -> snapshot of the current feed answer


def pick_radius(v: Any) -> float:
    """The asked-for radius if it is one of RADII, else the default."""
    try:
        r = float(v)
    except (TypeError, ValueError):
        return RADIUS_NM
    return r if r in RADII else RADIUS_NM


def snapshot(radius: float, force: bool = False) -> tuple[dict | None, str]:
    """The latest snapshot for a radius. The position feed is asked at most
    once per REFRESH_S (once per FEED_RETRY_S after a failure) however many
    browsers are open, whatever radius they show. Between feed calls, planes
    whose adsbdb lookups are still pending are filled in from the last feed
    answer, without asking the feed."""
    with _snap_lock:
        now = time.time()
        if force and now - _feed["at"] >= FORCE_MIN_S:
            _feed["next"] = now
        if now >= _feed["next"]:
            try:
                raw, name = fetch_feed()
                _feed.update(raw=raw, name=name, at=now, next=now + REFRESH_S, err="")
                _snaps.clear()
            except Unreachable as e:
                _feed.update(next=now + FEED_RETRY_S, err=str(e))
        snap = _snaps.get(radius)
        if _feed["raw"] is not None and (snap is None or snap["pending"]):
            snap = _snaps[radius] = build_snapshot(_feed["raw"], _feed["name"], _feed["at"], radius)
        if snap is not None:
            snap["next_feed_at"] = _feed["next"]
        return snap, _feed["err"]


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html", radius=RADIUS_NM, radii=RADII)


@app.get("/api/planes")
def api_planes():
    return planes_response(snapshot(pick_radius(request.args.get("nm"))))


@app.post("/api/poll")
def api_poll():
    """Ask the feed now (the "poll now" button), at most once per FORCE_MIN_S."""
    return planes_response(snapshot(pick_radius(request.args.get("nm")), force=True))


def planes_response(got: tuple[dict | None, str]):
    snap, err = got
    if snap is None:
        return jsonify({"error": f"no feed answered: {err}", "next_in_s": max(0, round(_feed["next"] - time.time()))}), 503
    return jsonify({**snap, "stale_error": err, "next_in_s": max(0, round(snap["next_feed_at"] - time.time()))})


@app.get("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "9030")))
