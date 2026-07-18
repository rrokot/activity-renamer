// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Automatically renames Strava activities based on the places the route passes through (adaptive boundary bisection + coverage-weighted naming, geocoding via OpenStreetMap Nominatim)
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const CONFIG = {
        seedKm:          5,   // Initial sample spacing; places traversed at least this long are always detected
        maxSeeds:       20,   // Cap on initial seed points (spacing grows on very long rides)
        minSegmentKm:    1,   // Stop bisecting a place boundary once localized within this distance
        maxApiCalls:    50,   // Hard cap on Nominatim requests per run (cache hits are free)
        maxPlacesInName: 5,   // Maximum number of unique places in the final name
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

    // Nominatim address fields grouped by granularity, most specific first within each tier.
    // The naming tier is chosen after geocoding: settlements if the route crosses several,
    // districts if the whole route stays inside one settlement.
    const TIERS = {
        district:   ['quarter', 'neighbourhood', 'suburb', 'city_district', 'borough'],
        settlement: ['hamlet', 'village', 'town', 'city', 'municipality'],
        region:     ['county', 'state'],
    };

    // Nominatim endpoint and localStorage prefixes
    const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
    const CACHE_PREFIX  = 'strava_geocode_v2_'; // v2: caches the full address object as JSON
    const LEGACY_CACHE_PREFIX = 'strava_geocode_';

    const BUTTON_ID = 'strava-route-rename-btn';

    // --- HELPERS ---

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function cacheKey(lat, lon) {
        const r = CONFIG.coordPrecision;
        return `${CACHE_PREFIX}${parseFloat(lat).toFixed(r)}_${parseFloat(lon).toFixed(r)}`;
    }

    // v1 cached bare name strings; those entries are useless for the v2 algorithm
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

    // --- PLACE NAMES ---

    // Name of the place at exactly this tier (no fallback — callers decide how to degrade)
    function nameAt(address, tier) {
        if (!address) return null;
        for (const field of TIERS[tier]) {
            if (address[field]) return address[field];
        }
        return null;
    }

    // Identity used to decide whether two samples are "in the same place" during
    // refinement. Falls back to coarser tiers so stretches with no data at the
    // requested tier (forest, water) don't trigger endless bisection.
    const KEY_FALLBACK = {
        district:   ['district', 'settlement', 'region'],
        settlement: ['settlement', 'region'],
    };
    function placeKey(address, tier) {
        for (const t of KEY_FALLBACK[tier]) {
            const name = nameAt(address, t);
            if (name) return `${t}:${name}`;
        }
        return null;
    }

    // --- GEOCODING ---

    // Rate-limited, budgeted Nominatim client caching the full address object,
    // so granularity decisions can be revisited without extra requests.
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
                        headers: { 'User-Agent': 'StravaActivityRouteRenamer/3.0' }
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    const address = data.address ?? null;
                    try { localStorage.setItem(key, JSON.stringify(address)); } catch (e) { /* cache full */ }
                    return address;
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

    // Initial sample positions: every seedKm along the track, plus start, end
    // and the farthest point (the likely destination), deduplicated and sorted
    function seedIndices(track) {
        const step = Math.max(CONFIG.seedKm, track.total / (CONFIG.maxSeeds - 1));
        const indices = new Set([0, track.dists.length - 1, track.farthestIdx]);
        for (let target = step; target < track.total; target += step) {
            indices.add(indexAtDistance(track.dists, target));
        }
        return [...indices].sort((a, b) => a - b);
    }

    // Recursively bisect segments whose endpoints resolve to different places,
    // until each boundary is localized within minSegmentKm. Homogeneous
    // stretches cost no requests; boundaries get all the detail.
    async function refineSamples(samples, tier, track, geocoder) {
        let i = 0;
        while (i < samples.length - 1) {
            const a = samples[i], b = samples[i + 1];
            const gapKm = track.dists[b.idx] - track.dists[a.idx];
            if (placeKey(a.address, tier) === placeKey(b.address, tier)
                || gapKm < CONFIG.minSegmentKm || b.idx - a.idx < 2) { i++; continue; }

            const midIdx = indexAtDistance(track.dists, (track.dists[a.idx] + track.dists[b.idx]) / 2);
            if (midIdx <= a.idx || midIdx >= b.idx) { i++; continue; }

            const lat = track.lats[midIdx], lon = track.lons[midIdx];
            if (!geocoder.isCached(lat, lon) && !geocoder.hasBudget()) { i++; continue; }

            samples.splice(i + 1, 0, { idx: midIdx, address: await geocoder.reverse(lat, lon) });
            // No i++ — re-examine the left half of the split segment next iteration
        }
    }

    // --- NAMING ---

    // Build the activity name at a given tier; null when nothing resolves at this tier
    function buildName(samples, tier, track) {
        const d = i => track.dists[samples[i].idx];

        // Each sample "covers" the stretch of track closer to it than to its
        // neighbours; that coverage weights the place it resolves to. Samples
        // without a name at this tier (e.g. only county/state) are dropped.
        const entries = samples.map((s, i) => ({
            name: nameAt(s.address, tier),
            km: (i === samples.length - 1 ? track.total : (d(i) + d(i + 1)) / 2)
              - (i === 0 ? 0 : (d(i - 1) + d(i)) / 2),
        })).filter(e => e.name);
        if (entries.length === 0) return null;

        // Merge repeat visits: first occurrence fixes the position, coverage
        // accumulates. Collapses out-and-back (A-B-C-B-A) and loop (A-B-C-A)
        // repeats while preserving travel order.
        const byName = new Map();
        for (const e of entries) {
            if (byName.has(e.name)) byName.get(e.name).km += e.km;
            else byName.set(e.name, { name: e.name, km: e.km });
        }
        const places = [...byName.values()];
        if (places.length <= CONFIG.maxPlacesInName) {
            return places.map(p => p.name).join(' - ');
        }

        // Too many places: always keep the start, the last new place (the
        // turnaround on out-and-back routes) and the place at the farthest
        // point; fill the rest with the largest coverage, restore travel order
        const keep = new Set([places[0].name, places[places.length - 1].name]);
        const farSample = samples.reduce((best, s) =>
            Math.abs(s.idx - track.farthestIdx) < Math.abs(best.idx - track.farthestIdx) ? s : best);
        const farName = nameAt(farSample.address, tier);
        if (farName) keep.add(farName);
        for (const p of [...places].sort((x, y) => y.km - x.km)) {
            if (keep.size >= CONFIG.maxPlacesInName) break;
            keep.add(p.name);
        }
        return places.filter(p => keep.has(p.name)).map(p => p.name).join(' - ');
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
     * 2. Seed sample points every seedKm (plus start, end and farthest point)
     * 3. Reverse-geocode seeds via Nominatim (full address cached), then
     *    recursively bisect segments whose endpoints lie in different
     *    settlements until each boundary is localized within minSegmentKm
     * 4. If the whole route stays inside one settlement, refine again at
     *    district level — same samples, finer naming
     * 5. Name = places in travel order, repeat visits merged (handles loops
     *    and out-and-back), weighted by kilometres covered; start, turnaround
     *    and farthest point always kept; too-coarse results filtered out
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
            };
            console.log(`[Strava Renamer] ${track.total.toFixed(1)} km, ${trkpts.length} trackpoints`);

            // Steps 2-3: Seed samples and refine place boundaries
            setButtonState(btn, STRINGS.geocoding, 'is-loading');
            const geocoder = createGeocoder(n =>
                setButtonState(btn, `${STRINGS.geocoding} ${n}/${CONFIG.maxApiCalls}...`, 'is-loading'));

            const samples = [];
            for (const idx of seedIndices(track)) {
                if (!geocoder.isCached(lats[idx], lons[idx]) && !geocoder.hasBudget()) continue;
                samples.push({ idx, address: await geocoder.reverse(lats[idx], lons[idx]) });
            }
            await refineSamples(samples, 'settlement', track, geocoder);

            // Step 4: Pick the naming tier from the whole picture
            const settlements = new Set(
                samples.map(s => placeKey(s.address, 'settlement')).filter(Boolean));
            let tier = 'settlement';
            if (settlements.size <= 1) {
                tier = 'district';
                await refineSamples(samples, 'district', track, geocoder);
            }
            console.log(`[Strava Renamer] ${samples.length} samples, ${geocoder.apiCalls} API calls, tier: ${tier}`);

            // Step 5: Build the name, degrading to coarser tiers if needed
            const tierChain = tier === 'district'
                ? ['district', 'settlement', 'region']
                : ['settlement', 'region'];
            let newName = null;
            for (const t of tierChain) {
                newName = buildName(samples, t, track);
                if (newName) break;
            }
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
        if (!isEditPage) return; // Only show button only on edit page

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
