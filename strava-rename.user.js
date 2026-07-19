// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Automatically names Strava activities as a travel narrative of map-prominent places the route passes ("Cottbus - Sielow - Werben - Burg - Dissen - Sielow - Cottbus"), geocoding via OpenStreetMap Nominatim
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const CONFIG = {
        seedKm:          5,   // Initial sample spacing; places traversed at least this long are always detected
        maxSeeds:       20,   // Cap on initial seed points (spacing grows on very long rides)
        minSegmentKm:    2,   // Boundary precision floor; actual precision = max(this, total / 25)
        maxApiCalls:    50,   // Hard cap on Nominatim requests per run (cache hits are free)
        maxPlacesInName: 7,   // Maximum number of UNIQUE places in the name (re-visits are free)
        maxCorners:      6,   // Max geometric turn points forced into sampling and naming
        minCornerKm:   0.5,   // A turn counts as a corner when the route deviates at least this far
        relabelKm:     1.5,   // A dropped stretch within this distance of a kept place reads as that place
        enterKm:       0.6,   // A village counts as visited only if the route comes this close to its centre
        stripParentheticals: true, // "Burg (Spreewald)" -> "Burg"
        coordPrecision:  3,   // Decimal places for caching coordinates (~110m resolution)
        rateLimit:    1050,   // Min ms between Nominatim API calls (policy: max 1 req/sec)
        nominatimZoom:  14,   // Reverse-geocoding detail: 14 = neighbourhood; coarser levels come along in the address
        successDelay: 1500,   // How long to show the success state before reverting (ms)
        errorDelay:   2000,   // How long to show the error state before reverting (ms)
    };

    // UI text for all button states
    const STRINGS = {
        idle:        'Generate from Geo',
        downloading: '⌛ Downloading...',
        analyzing:   '⌛ Analyzing...',
        geocoding:   '⌛ Geocoding',
        done:        '✔️ Done!',
        error:       '❌ Error',
        noGps:       'No GPS data found (manual entry or indoor activity?)',
        noId:        'Could not detect activity ID from URL.',
    };

    // What appears as a labelled place on a map: villages, towns, cities.
    // Hamlets and lone farmsteads are below the label threshold; urban
    // districts collapse into their city; municipalities are administrative
    // containers used only as a last resort.
    const MAJOR_PLACES  = ['village', 'town', 'city'];
    const MINOR_PLACES  = ['hamlet', 'isolated_dwelling', 'croft', 'farm'];
    const PARENT_PLACES = ['city', 'municipality'];
    const TIERS = {
        district: ['quarter', 'neighbourhood', 'suburb', 'city_district', 'borough'],
        region:   ['county', 'state'],
    };

    // Nominatim endpoint and localStorage prefixes
    const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
    const CACHE_PREFIX  = 'strava_geocode_v5_'; // v5: caches {addresstype, name, importance, feature lat/lon, address}
    const LEGACY_CACHE_PREFIX = 'strava_geocode_';

    const BUTTON_ID = 'strava-route-rename-btn';

    // --- HELPERS ---

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function cacheKey(lat, lon) {
        const r = CONFIG.coordPrecision;
        return `${CACHE_PREFIX}${parseFloat(lat).toFixed(r)}_${parseFloat(lon).toFixed(r)}`;
    }

    // Older versions cached less data per point; those entries are unusable now
    function cleanupLegacyCache() {
        const stale = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(LEGACY_CACHE_PREFIX) && !k.startsWith(CACHE_PREFIX)) stale.push(k);
        }
        stale.forEach(k => localStorage.removeItem(k));
    }

    // Set button text and state
    function setButtonState(btn, text, state = null) {
        btn.innerText = text;
        // Reset to default orange first
        btn.style.backgroundColor = '#fc4c02';
        btn.style.color = 'white';
        switch(state) {
            case 'is-loading':
                btn.style.backgroundColor = '#888';
                btn.style.color = '#fff';
                break;
            case 'is-success':
                btn.style.backgroundColor = '#4caf50';
                btn.style.color = '#fff';
                break;
            case 'is-error':
                btn.style.backgroundColor = '#f44336';
                btn.style.color = '#fff';
                break;
        }
    }

    // --- GEOMETRY ---

    // Calculate distance between two points using haversine formula (in km)
    function getDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Track index whose cumulative distance is closest to target (binary search)
    function indexAtDistance(dists, target) {
        let lo = 0, hi = dists.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (dists[mid] < target) lo = mid + 1; else hi = mid;
        }
        return (lo > 0 && Math.abs(dists[lo - 1] - target) < Math.abs(dists[lo] - target)) ? lo - 1 : lo;
    }

    // Point farthest from the start — the "destination" of an out-and-back route
    function farthestPointIndex(lats, lons) {
        let best = 0, bestD = -1;
        for (let i = 0; i < lats.length; i++) {
            const d = getDistance(lats[0], lons[0], lats[i], lons[i]);
            if (d > bestD) { bestD = d; best = i; }
        }
        return best;
    }

    // Corner points where the route significantly changes direction — the spots
    // the rider deliberately steered towards. Douglas-Peucker ranking: each
    // corner is scored by how far it deviates from the straight line between
    // its anchors; the strongest corners win. Returned sorted by importance.
    function findCorners(track) {
        const n = track.lats.length;
        if (n < 3) return [];
        // Local equirectangular projection to km
        const kx = 111.32 * Math.cos(track.lats[0] * Math.PI / 180), ky = 110.57;
        const xs = track.lons.map(l => l * kx), ys = track.lats.map(l => l * ky);
        const tolerance = Math.max(CONFIG.minCornerKm, track.total * 0.015);

        const corners = [];
        const stack = [];
        if (track.isLoop && track.farthestIdx > 0 && track.farthestIdx < n - 1) {
            // Closed loop: a start-end baseline is degenerate, anchor at the farthest point
            corners.push({ idx: track.farthestIdx, dev: Infinity });
            stack.push([0, track.farthestIdx], [track.farthestIdx, n - 1]);
        } else {
            stack.push([0, n - 1]);
        }
        while (stack.length) {
            const [a, b] = stack.pop();
            if (b - a < 2) continue;
            const ax = xs[a], ay = ys[a], dx = xs[b] - ax, dy = ys[b] - ay;
            const len2 = dx * dx + dy * dy;
            let best = -1, bestD = 0;
            for (let i = a + 1; i < b; i++) {
                let d;
                if (len2 === 0) {
                    d = Math.hypot(xs[i] - ax, ys[i] - ay);
                } else {
                    const t = Math.max(0, Math.min(1, ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2));
                    d = Math.hypot(xs[i] - (ax + t * dx), ys[i] - (ay + t * dy));
                }
                if (d > bestD) { bestD = d; best = i; }
            }
            if (best >= 0 && bestD >= tolerance) {
                corners.push({ idx: best, dev: bestD });
                stack.push([a, best], [best, b]);
            }
        }
        corners.sort((p, q) => q.dev - p.dev);
        return corners.slice(0, CONFIG.maxCorners).map(c => c.idx);
    }

    // --- PLACE NAMES ---

    // Bilingual regions (e.g. Lusatia) combine two language variants in one
    // OSM name ("Dissen - Dešno"); keep the first variant. Optionally strip
    // trailing disambiguation ("Burg (Spreewald)" -> "Burg"). Hyphenated
    // compounds without surrounding spaces (Baden-Baden) are left alone.
    function cleanPlaceName(name) {
        let n = name.split(/\s+[-–—]\s+|\s*\/\s*/)[0];
        if (CONFIG.stripParentheticals) n = n.replace(/\s*\([^)]*\)\s*$/, '');
        return n.trim() || name;
    }

    // The place as the map would label it: a village/town under its own name;
    // urban districts collapse to their city; hamlets and farms are marked
    // minor (below the label threshold). On loop rides the start/finish reads
    // as the home city ("Cottbus"), not the home suburb ("Klein Ströbitz").
    // Returns { name, imp, minor? } or null.
    function waypointOf(geo, edge) {
        if (!geo) return null;
        const a = geo.a || {};
        const base = { imp: geo.i || 0, cy: geo.y, cx: geo.x };
        if (edge && a.city) return { ...base, name: cleanPlaceName(a.city) };
        if (MAJOR_PLACES.includes(geo.t) && geo.n) {
            // cc: village/town claims are verified against their centre later
            // ("crossed its land" is not "went there"); a city you are inside
            // of needs no such check
            return { ...base, name: cleanPlaceName(geo.n), cc: geo.t !== 'city' };
        }
        if (a.village) return { ...base, name: cleanPlaceName(a.village), cc: true };
        if (a.town) return { ...base, name: cleanPlaceName(a.town), cc: true };
        if (MINOR_PLACES.includes(geo.t) && geo.n) return { ...base, name: cleanPlaceName(geo.n), minor: true };
        if (a.hamlet) return { ...base, name: cleanPlaceName(a.hamlet), minor: true };
        for (const f of PARENT_PLACES) if (a[f]) return { ...base, name: cleanPlaceName(a[f]) };
        return null;
    }

    // Name of the place at exactly this fallback tier
    function nameAt(geo, tier) {
        if (!geo || !geo.a) return null;
        for (const field of TIERS[tier]) {
            if (geo.a[field]) return cleanPlaceName(geo.a[field]);
        }
        return null;
    }

    // Identity used to decide whether two samples are "in the same place"
    // during refinement; falls through to coarser data so stretches with no
    // name (forest, water) don't trigger endless bisection
    const KEYERS = {
        settlement: geo => waypointOf(geo)?.name ?? nameAt(geo, 'district') ?? nameAt(geo, 'region'),
        district:   geo => nameAt(geo, 'district') ?? waypointOf(geo)?.name ?? nameAt(geo, 'region'),
    };

    // --- GEOCODING ---

    // Rate-limited, budgeted Nominatim client caching the useful parts of the
    // response, so naming decisions can be revisited without extra requests.
    function createGeocoder(onProgress) {
        let lastCallAt = 0;
        let apiCalls = 0;
        return {
            get apiCalls() { return apiCalls; },
            hasBudget() { return apiCalls < CONFIG.maxApiCalls; },
            isCached(lat, lon) { return localStorage.getItem(cacheKey(lat, lon)) !== null; },
            async reverse(lat, lon) {
                const key = cacheKey(lat, lon);
                const stored = localStorage.getItem(key);
                if (stored !== null) {
                    try { return JSON.parse(stored); } catch (e) { localStorage.removeItem(key); }
                }

                const wait = CONFIG.rateLimit - (Date.now() - lastCallAt);
                if (wait > 0) await sleep(wait); // Respect Nominatim's 1 req/sec policy

                apiCalls++;
                onProgress?.(apiCalls);
                const params = new URLSearchParams({
                    lat: String(lat),
                    lon: String(lon),
                    format: 'json',
                    zoom: String(CONFIG.nominatimZoom),
                    addressdetails: '1',
                    'accept-language': 'en',
                });
                try {
                    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
                        headers: { 'User-Agent': 'StravaActivityRouteRenamer/3.4' }
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    const geo = {
                        t: data.addresstype ?? null,   // type of the feature found (village, suburb, ...)
                        n: data.name || null,          // its own name
                        i: data.importance ?? null,    // map prominence (0..1)
                        y: data.lat ? parseFloat(data.lat) : null, // feature centre
                        x: data.lon ? parseFloat(data.lon) : null,
                        a: data.address ?? null,       // full address hierarchy
                    };
                    try { localStorage.setItem(key, JSON.stringify(geo)); } catch (e) { /* cache full */ }
                    return geo;
                } catch (e) {
                    console.error('[Strava Renamer] Geocoding error:', e);
                    return null; // Not cached — will be retried on the next run
                } finally {
                    lastCallAt = Date.now();
                }
            },
        };
    }

    // --- SAMPLING ---

    // Initial sample positions: every seedKm along the track, plus start, end,
    // the farthest point and every corner, deduplicated and sorted
    function seedIndices(track, cornerIdxs) {
        const step = Math.max(CONFIG.seedKm, track.total / (CONFIG.maxSeeds - 1));
        const indices = new Set([0, track.dists.length - 1, track.farthestIdx, ...cornerIdxs]);
        for (let target = step; target < track.total; target += step) {
            indices.add(indexAtDistance(track.dists, target));
        }
        return [...indices].sort((a, b) => a - b);
    }

    // Recursively bisect segments whose endpoints resolve to different places,
    // until each boundary is localized. Homogeneous stretches cost no
    // requests; boundaries get all the detail.
    async function refineSamples(samples, tier, track, geocoder) {
        const keyOf = KEYERS[tier];
        // Boundary precision scales with ride length: exact boundaries don't
        // matter for naming, only which places exist and roughly how much of
        // the ride they cover — this keeps long rides within the API budget
        const boundaryKm = Math.max(CONFIG.minSegmentKm, track.total / 25);
        let i = 0;
        while (i < samples.length - 1) {
            const a = samples[i], b = samples[i + 1];
            // A failed geocode (geo null) is unknown, not a place change
            if (!a.geo || !b.geo) { i++; continue; }
            const gapKm = track.dists[b.idx] - track.dists[a.idx];
            if (keyOf(a.geo) === keyOf(b.geo)
                || gapKm < boundaryKm || b.idx - a.idx < 2) { i++; continue; }

            const midIdx = indexAtDistance(track.dists, (track.dists[a.idx] + track.dists[b.idx]) / 2);
            if (midIdx <= a.idx || midIdx >= b.idx) { i++; continue; }

            const lat = track.lats[midIdx], lon = track.lons[midIdx];
            if (!geocoder.isCached(lat, lon) && !geocoder.hasBudget()) { i++; continue; }

            samples.splice(i + 1, 0, { idx: midIdx, geo: await geocoder.reverse(lat, lon) });
            // No i++ — re-examine the left half of the split segment next iteration
        }
    }

    // --- NAMING ---

    // Assemble a travel narrative from per-sample places produced by
    // nameFor(geo, edge) -> { name, imp, minor? } | null: places in the order
    // passed, consecutive repeats merged, later re-visits kept ("A - B - C -
    // B - A"). At most maxPlacesInName UNIQUE places appear, chosen by route
    // anchors first, then map prominence. Returns { text, count } or null.
    function buildRouteName(samples, track, cornerIdxs, nameFor) {
        const d = i => track.dists[samples[i].idx];

        // Each sample "covers" the stretch of track closer to it than to its
        // neighbours; that coverage weights the place it resolves to
        const entries = samples.map((s, i) => {
            const edge = track.isLoop && (i === 0 || i === samples.length - 1);
            const wp = nameFor(s.geo, edge);
            return wp && {
                name: wp.name, imp: wp.imp || 0, minor: !!wp.minor, idx: s.idx,
                cc: !!wp.cc, cy: wp.cy, cx: wp.cx,
                km: (i === samples.length - 1 ? track.total : (d(i) + d(i + 1)) / 2)
                  - (i === 0 ? 0 : (d(i - 1) + d(i)) / 2),
            };
        }).filter(Boolean);
        if (entries.length === 0) return null;

        // Travel narrative: merge consecutive repeats only
        const runs = [];
        for (const e of entries) {
            const last = runs[runs.length - 1];
            if (last && last.name === e.name) { last.km += e.km; last.idxs.push(e.idx); }
            else runs.push({ name: e.name, km: e.km, idxs: [e.idx] });
        }

        // Stats per unique place
        const byName = new Map();
        for (const e of entries) {
            const centre = e.cc && e.cy != null ? [`${e.cy},${e.cx}`] : [];
            const p = byName.get(e.name);
            if (p) {
                p.km += e.km; p.imp = Math.max(p.imp, e.imp);
                p.minor = p.minor && e.minor; p.cc = p.cc && e.cc;
                centre.forEach(c => p.centres.add(c));
            } else {
                byName.set(e.name, { name: e.name, km: e.km, imp: e.imp,
                    minor: e.minor, cc: e.cc, centres: new Set(centre) });
            }
        }
        // A village crossed only administratively — the route never comes
        // near its centre — wasn't really visited: demote it below the label
        // threshold (it can still read as a nearby kept place, like hamlets)
        const stride = Math.max(1, Math.floor(track.lats.length / 500));
        const centreDist = c => {
            const [cy, cx] = c.split(',').map(Number);
            let m = Infinity;
            for (let i = 0; i < track.lats.length; i += stride) {
                m = Math.min(m, getDistance(track.lats[i], track.lons[i], cy, cx));
            }
            return m;
        };
        for (const p of byName.values()) {
            if (p.minor || !p.cc || p.centres.size === 0) continue;
            if (Math.min(...[...p.centres].map(centreDist)) > CONFIG.enterKm) p.minor = true;
        }
        // Minor places (hamlets, farms, not-really-visited villages) only
        // qualify when there is nothing bigger on the whole route
        let candidates = [...byName.values()].filter(p => !p.minor);
        if (candidates.length < 2) candidates = [...byName.values()];
        const candidateNames = new Set(candidates.map(p => p.name));

        const keep = new Set();
        const addIf = (name, force) => {
            if (name && keep.size < CONFIG.maxPlacesInName && byName.has(name)
                && (force || candidateNames.has(name))) keep.add(name);
        };
        const nameNear = idx => {
            const s = samples.reduce((best, c) =>
                Math.abs(c.idx - idx) < Math.abs(best.idx - idx) ? c : best);
            return nameFor(s.geo, false)?.name;
        };
        // Start and finish anchor the narrative; the farthest point and the
        // two sharpest corners define the route's shape; remaining slots go
        // by coverage — how much of the ride each place accounts for (an
        // out-and-back corridor counts both legs). Nominatim importance is
        // only a tiebreak: it is too noisy among equally-sized villages.
        addIf(runs[0].name, true);
        addIf(runs[runs.length - 1].name, true);
        addIf(nameNear(track.farthestIdx), false);
        let cornerSlots = 2;
        for (const cornerIdx of cornerIdxs) {
            if (cornerSlots <= 0) break;
            const n = nameNear(cornerIdx);
            if (n && !keep.has(n)) { addIf(n, false); if (keep.has(n)) cornerSlots--; }
        }
        for (const p of [...candidates].sort((x, y) => (y.km - x.km) || (y.imp - x.imp))) {
            addIf(p.name, false);
        }

        // A dropped stretch that hugs a kept place still reads as that place
        // on the map (its label covers the surroundings) — e.g. a return leg
        // sampled just across a village boundary. Reassign such runs to the
        // nearby kept place instead of silently skipping them.
        const posOf = new Map();
        for (const e of entries) {
            if (!posOf.has(e.name)) posOf.set(e.name, []);
            posOf.get(e.name).push(e.idx);
        }
        const nearestKept = run => {
            let best = null, bestD = CONFIG.relabelKm;
            for (const name of keep) {
                for (const pi of posOf.get(name) ?? []) {
                    for (const ri of run.idxs) {
                        const dd = getDistance(track.lats[ri], track.lons[ri],
                                               track.lats[pi], track.lons[pi]);
                        if (dd <= bestD) { bestD = dd; best = name; }
                    }
                }
            }
            return best;
        };

        // Walk the narrative; re-merge what touches
        const seq = [];
        for (const r of runs) {
            const label = keep.has(r.name) ? r.name : nearestKept(r);
            if (!label) continue;
            if (seq[seq.length - 1] !== label) seq.push(label);
        }
        console.log('[Strava Renamer] Runs: ' + runs.map(r =>
            `${keep.has(r.name) ? '' : '~'}${r.name}:${r.km.toFixed(1)}`).join(' | '));
        return { text: seq.join(' - '), count: keep.size };
    }

    // --- DOM HELPERS ---

    // Extract activity ID from URL
    function getActivityId() {
        const m = window.location.href.match(/activities\/(\d+)/);
        return m ? m[1] : null;
    }

    // --- MAIN FUNCTION ---

    /**
     * How the algorithm works:
     * 1. Download the GPX track, parse points, compute cumulative distances
     * 2. Find geometric corner points (Douglas-Peucker) — where the rider
     *    deliberately turned
     * 3. Seed sample points every seedKm plus start, end, farthest point and
     *    corners; reverse-geocode via Nominatim (response cached), then
     *    recursively bisect segments whose endpoints lie in different places
     * 4. Each sample becomes the place a map would label there: village/town
     *    under its own name, urban districts collapsed to their city,
     *    hamlets/farms marked as below the label threshold
     * 5. Name = travel narrative: places in the order passed, consecutive
     *    repeats merged, re-visits kept ("Cottbus - Sielow - Werben - Burg -
     *    Dissen - Sielow - Cottbus"). At most maxPlacesInName unique places:
     *    start/finish first (on loops promoted to the home city), then the
     *    farthest point and corner places, then map prominence. Falls back to
     *    district naming within one city, then to county/state
     * 6. Fill in the name field and focus it
     */
    async function generateAndFillName(btn) {
        const activityId = getActivityId();
        if (!activityId) { alert(STRINGS.noId); return; }

        const nameInput = document.querySelector('input[name="activity[name]"]');
        if (!nameInput) { alert('Could not find activity name field'); return; }

        btn.disabled = true;
        setButtonState(btn, STRINGS.downloading, 'is-loading');

        try {
            // Step 1: Download GPX and parse track points
            const gpxRes = await fetch(`/activities/${activityId}/export_gpx`);
            if (!gpxRes.ok) throw new Error('Failed to download GPX. Are you logged in?');

            setButtonState(btn, STRINGS.analyzing, 'is-loading');
            const xml = new DOMParser().parseFromString(await gpxRes.text(), 'text/xml');
            const trkpts = xml.getElementsByTagName('trkpt');
            if (trkpts.length === 0) { alert(STRINGS.noGps); return; }

            const lats = Array.from(trkpts).map(p => parseFloat(p.getAttribute('lat')));
            const lons = Array.from(trkpts).map(p => parseFloat(p.getAttribute('lon')));

            const dists = [0];
            for (let i = 1; i < lats.length; i++) {
                dists.push(dists[i - 1] + getDistance(lats[i-1], lons[i-1], lats[i], lons[i]));
            }
            const track = {
                lats, lons, dists,
                total: dists[dists.length - 1],
                farthestIdx: farthestPointIndex(lats, lons),
                isLoop: getDistance(lats[0], lons[0], lats[lats.length - 1], lons[lats.length - 1]) < 1,
            };

            // Step 2: Corner detection
            const corners = findCorners(track);
            console.log(`[Strava Renamer] ${track.total.toFixed(1)} km, ${trkpts.length} trackpoints, ${corners.length} corners`);

            // Step 3: Seed samples and refine place boundaries
            setButtonState(btn, `${STRINGS.geocoding}...`, 'is-loading');
            const geocoder = createGeocoder(n =>
                setButtonState(btn, `${STRINGS.geocoding} ${n}/${CONFIG.maxApiCalls}...`, 'is-loading'));

            const samples = [];
            for (const idx of seedIndices(track, corners)) {
                if (!geocoder.isCached(lats[idx], lons[idx]) && !geocoder.hasBudget()) continue;
                samples.push({ idx, geo: await geocoder.reverse(lats[idx], lons[idx]) });
            }
            await refineSamples(samples, 'settlement', track, geocoder);

            // District-level detail is only needed when the whole ride
            // resolves to a single city
            const wpCount = new Set(
                samples.map(s => waypointOf(s.geo)?.name).filter(Boolean)).size;
            if (wpCount <= 1) await refineSamples(samples, 'district', track, geocoder);
            console.log(`[Strava Renamer] ${samples.length} samples, ${geocoder.apiCalls} API calls`
                + (geocoder.hasBudget() ? '' : ' (budget exhausted, boundaries localized coarsely)'));

            // Steps 4-5: Build the name: waypoint narrative, then fallbacks
            const asTier = tier => geo => {
                const n = nameAt(geo, tier);
                return n ? { name: n, imp: 0 } : null;
            };
            const wp = buildRouteName(samples, track, corners, waypointOf);
            let newName = (wp && wp.count >= 2) ? wp.text : null;
            if (!newName) {
                const districts = buildRouteName(samples, track, corners, asTier('district'));
                if (districts && districts.count >= 2) newName = districts.text;
            }
            if (!newName && wp) newName = wp.text; // Ride within one city with no district data
            if (!newName) newName = buildRouteName(samples, track, corners, asTier('region'))?.text;
            newName = newName || 'Route Activity';
            console.log(`[Strava Renamer] Name: ${newName}`);

            // Step 6: Fill in and focus the input
            nameInput.value = newName;
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.focus();
            setButtonState(btn, STRINGS.done, 'is-success');
            await sleep(CONFIG.successDelay);

        } catch (err) {
            console.error('[Strava Renamer]', err);
            alert(`Error:\n${err.message}`);
            setButtonState(btn, STRINGS.error, 'is-error');
            await sleep(CONFIG.errorDelay);
        } finally {
            btn.disabled = false;
            setButtonState(btn, STRINGS.idle);
        }
    }

    // --- BUTTON ---

    function injectButton() {
        if (document.querySelector(`#${BUTTON_ID}`)) return;

        const isEditPage = window.location.pathname.includes('/edit');
        if (!isEditPage) return; // Only show button on edit page

        // Place button after the Title label
        const titleLabel = document.querySelector('label[for="activity_name"]');
        if (titleLabel) {
            const btn = document.createElement('button');
            btn.id = BUTTON_ID;
            btn.innerText = STRINGS.idle;
            btn.title = 'Generate name from GPS track';
            btn.style.marginLeft = 'auto';
            btn.style.verticalAlign = 'middle';
            btn.style.fontSize = '12px';
            btn.style.padding = '3px 10px';
            btn.style.backgroundColor = '#fc4c02'; // Strava orange
            btn.style.color = 'white';
            btn.style.border = 'none';
            btn.style.borderRadius = '3px';
            btn.style.cursor = 'pointer';
            btn.type = 'button';
            btn.addEventListener('mouseenter', () => {
                btn.style.backgroundColor = '#e34402'; // Darker on hover
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.backgroundColor = '#fc4c02';
            });
            btn.addEventListener('click', e => {
                e.preventDefault();
                void generateAndFillName(btn);
            });

            // Wrap label and button in flex container to align right
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.alignItems = 'center';

            titleLabel.parentNode.insertBefore(wrapper, titleLabel);
            wrapper.appendChild(titleLabel);
            wrapper.appendChild(btn);

            console.log('[Strava Renamer] Button injected');
        }
    }

    cleanupLegacyCache();

    // Watch for DOM changes (in case page loads dynamically)
    new MutationObserver(injectButton).observe(document.body, { childList: true, subtree: true });
    injectButton();
})();
