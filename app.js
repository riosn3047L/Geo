/* GeoStamp: client-side geotag stamp generator. Classic script, no build step. */
(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const CONFIG = Object.assign(
    { appName: "GeoStamp", appIcon: "assets/icon.svg" },
    root.APP_CONFIG || {}
  );

  const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const DEFAULT_W = 2000;
  const DEFAULT_H = 1500;
  const MAX_SIDE = 6000;
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /* ---------------------------------------------------------------- helpers */

  const pad2 = (n) => String(n).padStart(2, "0");
  const fontStr = (weight, px) => `${weight} ${px}px ${FONT}`;

  function parseDateStr(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || "");
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return { y, mo, d, dow: t.getUTCDay() };
  }

  function parseTimeStr(str) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(str || "");
    if (!m) return null;
    const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
    if (h > 23 || mi > 59 || s > 59) return null;
    return { h, mi, s };
  }

  // "+05:30" -> 330
  function parseOffset(str) {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(str || "");
    if (!m) return null;
    return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
  }

  function formatOffset(minutes) {
    const sign = minutes < 0 ? "-" : "+";
    const a = Math.abs(minutes);
    return `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
  }

  // "Sunday, 01/11/2026 10:49 AM GMT +05:30"
  function formatDateLine(dateStr, timeStr, tzStr) {
    const d = parseDateStr(dateStr);
    const t = parseTimeStr(timeStr);
    if (!d || !t || parseOffset(tzStr) === null) return "";
    const h12 = t.h % 12 || 12;
    const ampm = t.h < 12 ? "AM" : "PM";
    return `${WEEKDAYS[d.dow]}, ${pad2(d.d)}/${pad2(d.mo)}/${d.y} ${pad2(h12)}:${pad2(t.mi)} ${ampm} GMT ${tzStr}`;
  }

  /* ------------------------------------------------------ Open Location Code */

  const OLC_ALPHABET = "23456789CFGHJMPQRVWX";

  // Returns an 11-digit code, e.g. "6JXVHMFG+6HH" (8 chars, '+', 3 chars).
  function encodeOLC(lat, lng) {
    lat = Math.min(90, Math.max(-90, lat));
    while (lng < -180) lng += 360;
    while (lng >= 180) lng -= 360;
    const LAT_MUL = 8000 * 3125;
    const LNG_MUL = 8000 * 1024;
    let latVal = Math.floor(Math.round((lat + 90) * LAT_MUL * 1e6) / 1e6);
    let lngVal = Math.floor(Math.round((lng + 180) * LNG_MUL * 1e6) / 1e6);
    latVal = Math.min(latVal, 180 * LAT_MUL - 1);

    let code = "";
    // 5 grid-refinement digits (5 rows x 4 columns), least significant first
    for (let i = 0; i < 5; i++) {
      code = OLC_ALPHABET[(latVal % 5) * 4 + (lngVal % 4)] + code;
      latVal = Math.floor(latVal / 5);
      lngVal = Math.floor(lngVal / 4);
    }
    // 5 lat/lng digit pairs
    for (let i = 0; i < 5; i++) {
      code = OLC_ALPHABET[lngVal % 20] + code;
      code = OLC_ALPHABET[latVal % 20] + code;
      latVal = Math.floor(latVal / 20);
      lngVal = Math.floor(lngVal / 20);
    }
    // 15 digits -> keep 11, '+' after the 8th
    return code.slice(0, 8) + "+" + code.slice(8, 11);
  }

  // "HMFG+6HH" -> "Hmfg+6hh"
  function plusCodeShort(lat, lng) {
    const s = encodeOLC(lat, lng).slice(4);
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  /* --------------------------------------------------------- image loading */

  function loadImage(url, timeoutMs) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timer = setTimeout(() => resolve(null), timeoutMs || 12000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = url;
    });
  }

  /* ------------------------------------------------------ satellite thumbnail */

  const SAT_URL = (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const SAT_SRC = 352; // source pixels cropped around the point
  const satCache = new Map();

  function worldPx(lat, lng, z) {
    const size = 256 * Math.pow(2, z);
    const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
    return {
      x: ((lng + 180) / 360) * size,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    };
  }

  async function buildSatellite(lat, lng, z) {
    const p = worldPx(lat, lng, z);
    const n = Math.pow(2, z);
    const tx = Math.floor(p.x / 256);
    const ty = Math.floor(p.y / 256);
    const ox = SAT_SRC / 2 - (p.x - tx * 256);
    const oy = SAT_SRC / 2 - (p.y - ty * 256);

    const jobs = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = ty + dy;
        if (y < 0 || y >= n) continue;
        const x = (((tx + dx) % n) + n) % n;
        jobs.push(loadImage(SAT_URL(z, x, y)).then((img) => ({ img, dx, dy })));
      }
    }
    const tiles = await Promise.all(jobs);
    const centre = tiles.find((t) => t.dx === 0 && t.dy === 0);
    if (!centre || !centre.img) return null;

    const c = document.createElement("canvas");
    c.width = c.height = SAT_SRC;
    const cx = c.getContext("2d");
    cx.fillStyle = "#3a4a3a";
    cx.fillRect(0, 0, SAT_SRC, SAT_SRC);
    for (const t of tiles) {
      if (t.img) cx.drawImage(t.img, ox + t.dx * 256, oy + t.dy * 256, 256, 256);
    }
    return c;
  }

  function getSatellite(lat, lng) {
    const r = (v) => v.toFixed(6);
    const key18 = `18/${r(lat)}/${r(lng)}`;
    if (satCache.has(key18)) return satCache.get(key18);

    const p = (async () => {
      for (const z of [18, 17]) {
        try {
          const res = await buildSatellite(lat, lng, z);
          if (res) return res;
        } catch (e) { /* try next zoom */ }
      }
      return null;
    })();

    satCache.set(key18, p);
    if (satCache.size > 24) satCache.delete(satCache.keys().next().value);
    p.then((res) => { if (!res) satCache.delete(key18); });
    return p;
  }

  /* ------------------------------------------------------------------ flag */

  const flagCache = new Map();

  function flagEmoji(cc) {
    return String.fromCodePoint(...cc.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  function getFlag(cc) {
    cc = cc.toLowerCase();
    if (flagCache.has(cc)) return flagCache.get(cc);
    const p = loadImage(`https://flagcdn.com/w160/${cc}.png`).then((img) =>
      img && img.naturalWidth ? { img } : { emoji: flagEmoji(cc) }
    );
    flagCache.set(cc, p);
    return p;
  }

  /* ------------------------------------------------------------ app icon */

  let iconPromise = null;
  let iconSrc = null;
  function getIcon() {
    if (!iconPromise || iconSrc !== CONFIG.appIcon) {
      iconSrc = CONFIG.appIcon;
      iconPromise = loadImage(iconSrc);
    }
    return iconPromise;
  }

  /* --------------------------------------------------------- canvas drawing */

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Shrink to minPx (px * minRatio), then ellipsize. Leaves ctx.font set. Returns drawn text.
  function fitLine(ctx, text, weight, px, minPx, maxW) {
    ctx.font = fontStr(weight, px);
    const w = ctx.measureText(text).width;
    let size = px;
    if (w > maxW) size = Math.max(minPx, (px * maxW) / w);
    ctx.font = fontStr(weight, size);
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + "…";
  }

  function drawPinAndCone(ctx, cx, cy, u) {
    // direction cone, pointing down-left from the pin tip
    const R = 125 * u;
    const dir = (135 * Math.PI) / 180;
    const half = (34 * Math.PI) / 180;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, "rgba(66,133,244,0.6)");
    g.addColorStop(1, "rgba(66,133,244,0.04)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, dir - half, dir + half);
    ctx.closePath();
    ctx.fill();

    // teardrop pin, tip at (cx, cy)
    const r = 27 * u;
    const hp = 84 * u;
    const d = hp - r;
    const ccy = cy - d;
    const phi = Math.acos(r / d);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 8 * u;
    ctx.shadowOffsetY = 2 * u;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.sin(phi), ccy + r * Math.cos(phi));
    ctx.arc(cx, ccy, r, Math.PI / 2 - phi, Math.PI / 2 + phi, true);
    ctx.closePath();
    ctx.fillStyle = "#E53935";
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 2.5 * u;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, ccy, 10 * u, 0, Math.PI * 2);
    ctx.fillStyle = "#8B0000";
    ctx.fill();
  }

  function drawThumbnail(ctx, x, y, size, u, sat) {
    ctx.save();
    roundRectPath(ctx, x, y, size, size, 14 * u);
    ctx.clip();
    if (sat) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sat, x, y, size, size);
    } else {
      ctx.fillStyle = "#3a4a3a";
      ctx.fillRect(x, y, size, size);
    }
    drawPinAndCone(ctx, x + size / 2, y + size / 2, u);
    ctx.restore();
  }

  function drawStamp(ctx, W, H, st, assets) {
    const u = Math.min(W / 2000, H / 1500);
    const blockW = 1530 * u;
    const left = (W - blockW) / 2;
    const right = left + blockW;
    const textX = left + 410 * u;
    const textMaxW = right - textX;

    // readability panel
    ctx.save();
    roundRectPath(ctx, left + 390 * u, H - 448 * u, 1160 * u, 417 * u, 16 * u);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill();
    ctx.restore();

    drawThumbnail(ctx, left, H - 383 * u, 352 * u, u, assets.sat);

    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 4 * u;
    ctx.shadowOffsetY = 1 * u;

    // --- title (+ flag)
    const baseTitle = 62 * u;
    const flag = assets.flag;
    let flagW = 0;
    const flagH0 = 50 * u;
    if (flag && flag.img) {
      const asp = flag.img.naturalWidth / flag.img.naturalHeight || 1.5;
      flagW = Math.min(flagH0 * asp, 100 * u);
    } else if (flag && flag.emoji) {
      ctx.font = fontStr(500, baseTitle);
      flagW = ctx.measureText(flag.emoji).width;
    }
    ctx.font = fontStr(500, baseTitle);
    const space0 = ctx.measureText(" ").width;
    const tw0 = ctx.measureText(st.title).width;
    const extra0 = flag ? space0 + flagW : 0;
    const k = Math.min(1, textMaxW / Math.max(1, tw0 + extra0));
    const titleSize = Math.max(baseTitle * 0.5, baseTitle * k);
    const scale = titleSize / baseTitle;
    const extra = extra0 * scale;
    const titleText = fitLine(ctx, st.title, 500, titleSize, titleSize, textMaxW - extra);
    const titleBase = H - 258 * u;
    ctx.fillText(titleText, textX, titleBase);
    if (flag) {
      const fx = textX + ctx.measureText(titleText).width + space0 * scale;
      const fh = flagH0 * scale;
      const fy = titleBase - titleSize * 0.36 - fh / 2;
      if (flag.img) {
        ctx.save();
        ctx.shadowColor = "transparent";
        roundRectPath(ctx, fx, fy, flagW * scale, fh, 5 * u * scale);
        ctx.clip();
        ctx.drawImage(flag.img, fx, fy, flagW * scale, fh);
        ctx.restore();
      } else {
        ctx.fillText(flag.emoji, fx, titleBase);
      }
    }

    // --- address, coordinates, date
    const small = 40 * u;
    const addr = fitLine(ctx, st.address, 400, small, small * 0.7, textMaxW);
    ctx.fillText(addr, textX, H - 200 * u);

    const coords = fitLine(ctx, `Lat ${st.latStr}° Long ${st.lngStr}°`, 400, small, small * 0.7, textMaxW);
    ctx.fillText(coords, textX, H - 150 * u);

    const dateLine = fitLine(ctx, st.dateLine, 400, small, small * 0.7, textMaxW);
    ctx.fillText(dateLine, textX, H - 100 * u);

    // --- app badge, right aligned
    const badgePx = 28 * u;
    const name = CONFIG.appName;
    ctx.font = fontStr(500, badgePx);
    const nameW = ctx.measureText(name).width;
    const cy = H - 417 * u;
    const iconSz = 38 * u;
    const gap = 14 * u;
    const hasIcon = !!assets.icon;
    const nameX = right - nameW;
    ctx.fillText(name, nameX, cy + badgePx * 0.35);
    if (hasIcon) {
      try {
        ctx.shadowColor = "transparent";
        ctx.drawImage(assets.icon, nameX - gap - iconSz, cy - iconSz / 2, iconSz, iconSz);
      } catch (e) { /* unsupported icon format; skip */ }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ state */

  let canvas, ctx;
  let photo = null; // { source, w, h }
  let renderToken = 0;
  let debounceTimer = null;
  let validationShown = false;
  let map = null;
  let marker = null;

  const $ = (id) => document.getElementById(id);

  function setStatus(msg, isError) {
    const el = $("status");
    if (!el) return;
    el.textContent = msg || "";
    el.dataset.type = isError ? "error" : "info";
    el.classList.toggle("error", !!isError);
  }

  function readState() {
    const latStr = $("lat").value.trim();
    const lngStr = $("lng").value.trim();
    const lat = latStr === "" ? NaN : Number(latStr);
    const lng = lngStr === "" ? NaN : Number(lngStr);
    if (!isFinite(lat) || lat < -90 || lat > 90) return { error: "Latitude must be a number between -90 and 90." };
    if (!isFinite(lng) || lng < -180 || lng > 180) return { error: "Longitude must be a number between -180 and 180." };
    const dateStr = $("date").value;
    const timeStr = $("time").value;
    const tzStr = $("tzOffset").value;
    const dateLine = formatDateLine(dateStr, timeStr, tzStr);
    if (!dateLine) return { error: "Pick a valid date, time and timezone." };
    const cc = $("countryCode").value.trim().toUpperCase();
    return {
      lat, lng, latStr, lngStr, dateStr, timeStr, tzStr, dateLine,
      title: $("placeTitle").value.trim(),
      address: $("address").value.replace(/\s*\n\s*/g, " ").trim(),
      flagCode: $("showFlag").checked && /^[A-Z]{2}$/.test(cc) ? cc : "",
    };
  }

  async function render() {
    const token = ++renderToken;
    const st = readState();
    if (st.error) {
      setStatus(st.error, true);
      validationShown = true;
      return false;
    }
    const [sat, flag, icon] = await Promise.all([
      getSatellite(st.lat, st.lng).catch(() => null),
      st.flagCode ? getFlag(st.flagCode).catch(() => null) : null,
      getIcon().catch(() => null),
    ]);
    if (token !== renderToken) return false; // superseded by a newer render

    const w = photo ? photo.w : DEFAULT_W;
    const h = photo ? photo.h : DEFAULT_H;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (photo) {
      ctx.drawImage(photo.source, 0, 0, w, h);
    } else {
      ctx.fillStyle = "#050308";
      ctx.fillRect(0, 0, w, h);
    }
    try {
      drawStamp(ctx, w, h, st, { sat, flag, icon });
    } catch (e) {
      setStatus("Could not draw the stamp: " + e.message, true);
      validationShown = false;
      return false;
    }
    if (validationShown) {
      setStatus("");
      validationShown = false;
    }
    return true;
  }

  function scheduleRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { render().catch(reportError); }, 250);
  }

  function reportError(e) {
    setStatus((e && e.message) || String(e), true);
    validationShown = false;
  }

  /* ------------------------------------------------------------ photo input */

  async function loadPhoto(file) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      const url = URL.createObjectURL(file);
      try {
        source = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("This file could not be read as an image."));
          img.src = url;
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    }
    let w = source.width || source.naturalWidth;
    let h = source.height || source.naturalHeight;
    const longest = Math.max(w, h);
    if (longest > MAX_SIDE) {
      const s = MAX_SIDE / longest;
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    if (photo && photo.source && typeof photo.source.close === "function") photo.source.close();
    photo = { source, w, h };
  }

  async function onPhotoChosen(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    setStatus("Loading photo…");
    try {
      await loadPhoto(file);
      setStatus("");
      validationShown = false;
      await render();
    } catch (e) {
      reportError(e);
    }
  }

  /* -------------------------------------------------------------- timezone */

  function buildTzOptions() {
    const sel = $("tzOffset");
    const mins = new Set();
    for (let h = -12; h <= 14; h++) mins.add(h * 60);
    [-570, -210, -150, 210, 270, 330, 345, 390, 510, 525, 570, 630, 765, 825].forEach((m) => mins.add(m));
    const browser = -new Date().getTimezoneOffset();
    mins.add(browser);
    sel.innerHTML = "";
    Array.from(mins).sort((a, b) => a - b).forEach((m) => {
      const o = document.createElement("option");
      o.value = formatOffset(m);
      o.textContent = "GMT " + o.value;
      sel.appendChild(o);
    });
    sel.value = formatOffset(browser);
  }

  function setNow() {
    const off = parseOffset($("tzOffset").value);
    const d = new Date(Date.now() + (off === null ? -new Date().getTimezoneOffset() : off) * 60000);
    $("date").value = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    $("time").value = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }

  /* ----------------------------------------------------------------- map */

  const PIN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +
    '<path d="M15 41C15 41 2 25 2 15a13 13 0 0 1 26 0C28 25 15 41 15 41z" fill="#E53935" stroke="#fff" stroke-width="2"/>' +
    '<circle cx="15" cy="15" r="5.5" fill="#8B0000"/></svg>';

  function setInputsFromCoords(lat, lng) {
    $("lat").value = String(Number(lat.toFixed(6)));
    $("lng").value = String(Number(lng.toFixed(6)));
  }

  function moveTo(lat, lng, pan) {
    setInputsFromCoords(lat, lng);
    if (marker) marker.setLatLng([lat, lng]);
    if (map && pan) map.panTo([lat, lng]);
    scheduleRender();
  }

  function initMap() {
    if (typeof L === "undefined" || !$("map")) return;
    const lat = Number($("lat").value) || 0;
    const lng = Number($("lng").value) || 0;
    map = L.map("map").setView([lat, lng], 17);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles &copy; Esri" }
    ).addTo(map);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19 }
    ).addTo(map);
    const icon = L.divIcon({ html: PIN_SVG, className: "", iconSize: [30, 42], iconAnchor: [15, 41] });
    marker = L.marker([lat, lng], { draggable: true, icon }).addTo(map);
    marker.on("dragend", () => {
      const p = marker.getLatLng().wrap();
      moveTo(p.lat, p.lng, false);
    });
    map.on("click", (e) => {
      const p = e.latlng.wrap();
      moveTo(p.lat, p.lng, false);
    });
    setTimeout(() => map.invalidateSize(), 200);
    window.addEventListener("load", () => map.invalidateSize());
  }

  function syncMapFromInputs() {
    if (!marker) return;
    const lat = Number($("lat").value);
    const lng = Number($("lng").value);
    if ($("lat").value.trim() === "" || $("lng").value.trim() === "") return;
    if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      marker.setLatLng([lat, lng]);
      map.panTo([lat, lng]);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setStatus("Geolocation is not supported by this browser.", true);
      return;
    }
    setStatus("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        moveTo(pos.coords.latitude, pos.coords.longitude, true);
        if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 17);
        setStatus("Location set.");
      },
      (err) => setStatus("Could not get location: " + (err && err.message ? err.message : "permission denied"), true),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  /* ------------------------------------------------------- reverse geocode */

  async function autoFillAddress() {
    const lat = Number($("lat").value);
    const lng = Number($("lng").value);
    if ($("lat").value.trim() === "" || $("lng").value.trim() === "" ||
        !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      setStatus("Enter valid coordinates first.", true);
      return;
    }
    const btn = $("autoAddressBtn");
    btn.disabled = true;
    setStatus("Looking up address…");
    try {
      const url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2" +
        `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}` +
        "&zoom=18&addressdetails=1&accept-language=en";
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("Address lookup failed (HTTP " + res.status + ").");
      const data = await res.json();
      const a = data && data.address;
      if (!a) throw new Error("No address found for these coordinates.");
      const locality = a.village || a.town || a.city || a.suburb || a.hamlet || a.county || "";
      const state = a.state || "";
      const country = a.country || "";
      const stateZip = [state, a.postcode].filter(Boolean).join(" ");
      $("placeTitle").value = [locality, state, country].filter(Boolean).join(", ");
      if (a.country_code) $("countryCode").value = String(a.country_code).toUpperCase().slice(0, 2);
      $("address").value = [plusCodeShort(lat, lng), locality, stateZip, country].filter(Boolean).join(", ");
      setStatus("Address filled from coordinates.");
      validationShown = false;
      scheduleRender();
    } catch (e) {
      reportError(e);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- export */

  // Strip diacritics / non-ASCII: piexif ASCII fields are single-byte.
  function toAscii(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?");
  }

  function toDmsRational(value) {
    const total = Math.round(Math.abs(value) * 3600 * 10000); // 1/10000 arc-seconds
    const deg = Math.floor(total / 36000000);
    const min = Math.floor((total - deg * 36000000) / 600000);
    const sec = total - deg * 36000000 - min * 600000;
    return [[deg, 1], [min, 1], [sec, 10000]];
  }

  const OFFSET_TAGS = { OffsetTime: 36880, OffsetTimeOriginal: 36881, OffsetTimeDigitized: 36882 };

  function ensureOffsetTags() {
    try {
      const T = piexif.TAGS && piexif.TAGS.Exif;
      if (!T) return false;
      Object.keys(OFFSET_TAGS).forEach((name) => {
        if (!T[OFFSET_TAGS[name]]) T[OFFSET_TAGS[name]] = { name, type: "Ascii" };
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function buildExif(st) {
    const d = parseDateStr(st.dateStr);
    const t = parseTimeStr(st.timeStr);
    const offMin = parseOffset(st.tzStr);
    const local = `${d.y}:${pad2(d.mo)}:${pad2(d.d)} ${pad2(t.h)}:${pad2(t.mi)}:${pad2(t.s)}`;
    const name = toAscii(CONFIG.appName);

    const zeroth = {};
    zeroth[piexif.ImageIFD.Make] = name;
    zeroth[piexif.ImageIFD.Software] = name;
    zeroth[piexif.ImageIFD.ImageDescription] = toAscii(st.address);
    zeroth[piexif.ImageIFD.Orientation] = 1;
    zeroth[piexif.ImageIFD.DateTime] = local;

    const exif = {};
    exif[piexif.ExifIFD.DateTimeOriginal] = local;
    exif[piexif.ExifIFD.DateTimeDigitized] = local;

    const utc = new Date(Date.UTC(d.y, d.mo - 1, d.d, t.h, t.mi, t.s) - offMin * 60000);
    const gps = {};
    gps[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
    gps[piexif.GPSIFD.GPSLatitudeRef] = st.lat < 0 ? "S" : "N";
    gps[piexif.GPSIFD.GPSLatitude] = toDmsRational(st.lat);
    gps[piexif.GPSIFD.GPSLongitudeRef] = st.lng < 0 ? "W" : "E";
    gps[piexif.GPSIFD.GPSLongitude] = toDmsRational(st.lng);
    gps[piexif.GPSIFD.GPSDateStamp] =
      `${utc.getUTCFullYear()}:${pad2(utc.getUTCMonth() + 1)}:${pad2(utc.getUTCDate())}`;
    gps[piexif.GPSIFD.GPSTimeStamp] = [[utc.getUTCHours(), 1], [utc.getUTCMinutes(), 1], [utc.getUTCSeconds(), 1]];
    gps[piexif.GPSIFD.GPSMapDatum] = "WGS-84";

    return { "0th": zeroth, Exif: exif, GPS: gps };
  }

  function dumpExif(st) {
    const dict = buildExif(st);
    try {
      if (!ensureOffsetTags()) throw new Error("offset tags unavailable");
      const off = st.tzStr;
      dict.Exif[OFFSET_TAGS.OffsetTime] = off;
      dict.Exif[OFFSET_TAGS.OffsetTimeOriginal] = off;
      dict.Exif[OFFSET_TAGS.OffsetTimeDigitized] = off;
      return piexif.dump(dict);
    } catch (e) {
      Object.values(OFFSET_TAGS).forEach((k) => delete dict.Exif[k]);
      return piexif.dump(dict);
    }
  }

  function dataUrlToBlob(dataUrl) {
    const bin = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/jpeg" });
  }

  async function download() {
    const btn = $("downloadBtn");
    btn.disabled = true;
    try {
      if (typeof piexif === "undefined") throw new Error("EXIF library failed to load.");
      clearTimeout(debounceTimer);
      setStatus("Preparing image…");
      const ok = await render();
      if (!ok) {
        if (!validationShown) setStatus("Rendering was interrupted. Please try again.", true);
        return;
      }
      const st = readState();
      const jpeg = canvas.toDataURL("image/jpeg", 0.92);
      const withExif = piexif.insert(dumpExif(st), jpeg);
      const blob = dataUrlToBlob(withExif);

      const d = parseDateStr(st.dateStr);
      const t = parseTimeStr(st.timeStr);
      const base = String(CONFIG.appName).replace(/[^A-Za-z0-9]/g, "") || "GeoStamp";
      const filename = `${base}_${d.y}${pad2(d.mo)}${pad2(d.d)}_${pad2(t.h)}${pad2(t.mi)}${pad2(t.s)}.jpg`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus("Saved " + filename);
    } catch (e) {
      const msg = e && e.name === "SecurityError"
        ? "The image could not be exported because a remote image (map or flag) blocked access. Try again or uncheck the flag."
        : (e && e.message) || String(e);
      setStatus(msg, true);
      validationShown = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    canvas = $("previewCanvas");
    ctx = canvas.getContext("2d");

    document.querySelectorAll(".app-name").forEach((el) => { el.textContent = CONFIG.appName; });
    const iconEl = $("appIcon");
    if (iconEl) iconEl.src = CONFIG.appIcon;
    document.title = document.title || CONFIG.appName;

    // defaults
    $("placeTitle").value = "Krishnan Kovil, Tamil Nadu, India";
    $("showFlag").checked = true;
    $("countryCode").value = "IN";
    $("address").value = "Hmfg+6hh, Krishnan Kovil, Tamil Nadu 626126, India";
    $("lat").value = "9.57258";
    $("lng").value = "77.676617";
    buildTzOptions();
    setNow();

    initMap();

    ["placeTitle", "address", "date", "time"].forEach((id) => $(id).addEventListener("input", scheduleRender));
    $("tzOffset").addEventListener("change", scheduleRender);
    $("showFlag").addEventListener("change", scheduleRender);
    $("countryCode").addEventListener("input", () => {
      const el = $("countryCode");
      const v = el.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (v !== el.value) el.value = v;
      scheduleRender();
    });
    ["lat", "lng"].forEach((id) =>
      $(id).addEventListener("input", () => { syncMapFromInputs(); scheduleRender(); })
    );

    $("photoInput").addEventListener("change", onPhotoChosen);
    $("autoAddressBtn").addEventListener("click", autoFillAddress);
    $("myLocationBtn").addEventListener("click", useMyLocation);
    $("nowBtn").addEventListener("click", () => { setNow(); scheduleRender(); });
    $("downloadBtn").addEventListener("click", download);

    render().catch(reportError);
  }

  const api = { encodeOLC, plusCodeShort, formatDateLine, render, buildExif, dumpExif, toDmsRational };
  root.GeoStamp = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }
})();
