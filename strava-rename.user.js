// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Automatically renames Strava activities based on significant GPS waypoints (distance-adaptive sampling + geocoding via OpenStreetMap Nominatim)
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const CONFIG = {
        kmPerSample:    3,    // One sample point every N km along the track
        minSamples:     4,    // Minimum number of sample points (for very short activities)
        maxSamples:    20,    // Maximum number of sample points (caps API calls on long rides)
        maxPlacesInName: 5,   // Maximum number of unique places in the final name
        coordPrecision:  3,   // Decimal places for caching coordinates (~110m resolution)
        rateLimit:    1050,   // Min ms between Nominatim API calls (policy: max 1 req/sec)
        successDelay: 1500,   // How long to show the success state before reverting (ms)
        errorDelay:   2000,   // How long to show the error state before reverting (ms)
    };

    // UI text for all button states
    const STRINGS = {
        idle:        'Generate from Geo',
        downloading: '⌛ Downloading...',
        analyzing:   '⌛ Analyzing...',
        geocoding:   '⌛ Geocoding...',
        done:        '✔️ Done!',
        error:       '❌ Error',
        noGps:       'No GPS data found (manual entry or indoor activity?)',
        noId:        'Could not detect activity ID from URL.',
    };

    // Address fields to extract from Nominatim, ordered most → least granular
    // Edit this array to change what level of detail appears in activity names
    const ADDRESS_PRIORITY = [
        'quarter',        // Very specific urban quarter (rare)
        'neighbourhood',  // Urban neighbourhood
        'suburb',         // Stadtteil / suburb
        'hamlet',         // Weiler (smaller than village)
        'village',        // Dorf / village
        'town',           // Town
        'city_district',  // City district
        'city',           // City
        'municipality',   // Municipality (Gemeinde)
        'county',         // County (Landkreis)
        'state',          // State (Bundesland)
    ];

    // Nominatim endpoint and localStorage prefix
    const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
    const CACHE_PREFIX  = 'strava_geocode_';

    const BUTTON_ID = 'strava-route-rename-btn';

    // --- HELPERS ---

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function cacheKey(lat, lon) {
        const r = CONFIG.coordPrecision;
        return `${CACHE_PREFIX}${parseFloat(lat).toFixed(r)}_${parseFloat(lon).toFixed(r)}`;
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

    // --- GEOCODING ---

    // Extract place name from Nominatim address using priority order
    function extractLocationName(address) {
        if (!address) return null;
        for (const field of ADDRESS_PRIORITY) {
            if (address[field]) return address[field];
        }
        return null;
    }

    // Get place name from coordinates (with caching)
    async function getPlaceName(lat, lon) {
        const key = cacheKey(lat, lon);
        const stored = localStorage.getItem(key);
        if (stored !== null) return stored || null; // Use cached value if available

        const params = new URLSearchParams({ lat, lon, format: 'json', 'accept-language': 'en' });
        try {
            const res = await fetch(`${NOMINATIM_URL}?${params}`, {
                headers: { 'User-Agent': `StravaActivityRouteRenamer/2.3` }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const place = extractLocationName(data.address);
            localStorage.setItem(key, place ?? ''); // Cache the result
            return place;
        } catch (e) {
            console.error('[Strava Renamer] Geocoding error:', e);
            return null;
        }
    }

    // Geocode all sample points with rate limiting
    async function geocodeAll(points) {
        const names = [];
        let lastApiCallAt = 0;

        for (const { lat, lon } of points) {
            const isCached = localStorage.getItem(cacheKey(lat, lon)) !== null;
            if (!isCached) {
                const wait = CONFIG.rateLimit - (Date.now() - lastApiCallAt);
                if (wait > 0) await sleep(wait); // Wait to respect rate limits
            }
            const name = await getPlaceName(lat, lon);
            if (!isCached) lastApiCallAt = Date.now();
            names.push(name);
        }
        return names;
    }

    // --- SAMPLING ---

    // Select evenly spaced points by distance using binary search
    function sampleByDistance(distances, numSamples) {
        const n = distances.length;
        const total = distances[n - 1];
        const seen = new Set();
        const result = [];

        for (let k = 0; k < numSamples; k++) {
            const target = (k / (numSamples - 1)) * total; // Target distance
            let lo = 0, hi = n - 1;
            // Binary search for closest point
            while (lo < hi) {
                const mid = (lo + hi) >> 1; // Bit shift = divide by 2
                if (distances[mid] < target) lo = mid + 1; else hi = mid;
            }
            // Check which point is closer: lo or lo-1
            const idx = (lo > 0 && Math.abs(distances[lo - 1] - target) < Math.abs(distances[lo] - target))
                ? lo - 1 : lo;
            if (!seen.has(idx)) { seen.add(idx); result.push(idx); }
        }
        return result.sort((a, b) => a - b); // Sort in track order
    }

    // Remove consecutive duplicate place names
    function dedupeConsecutive(arr) {
        return arr.filter((v, i) => v && v !== arr[i - 1]);
    }

    // Subsample array to max length while maintaining distribution
    function subsample(arr, maxLen) {
        if (arr.length <= maxLen) return arr;
        const step = (arr.length - 1) / (maxLen - 1);
        const result = Array.from({ length: maxLen }, (_, k) => arr[Math.round(k * step)]);
        return dedupeConsecutive(result); // Clean duplicates again just in case
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
     * 1. Download GPX track for the activity
     * 2. Parse all GPS track points
     * 3. Calculate cumulative distances between points
     * 4. Select evenly spaced sample points (every N km)
     * 5. Geocode sample points using Nominatim to get place names
     * 6. Remove consecutive duplicate places
     * 7. Keep only maxPlacesInName to avoid too long names
     * 8. Fill in the name field and focus it
     */
    async function generateAndFillName(btn) {
        const activityId = getActivityId();
        if (!activityId) { alert(STRINGS.noId); return; }

        const nameInput = document.querySelector('input[name="activity[name]"]');
        if (!nameInput) { alert('Could not find activity name field'); return; }

        btn.disabled = true;
        setButtonState(btn, STRINGS.downloading, 'is-loading');

        try {
            // Step 1: Download GPX
            const gpxRes = await fetch(`/activities/${activityId}/export_gpx`);
            if (!gpxRes.ok) throw new Error('Failed to download GPX. Are you logged in?');

            // Step 2: Parse track points
            setButtonState(btn, STRINGS.analyzing, 'is-loading');
            const xml = new DOMParser().parseFromString(await gpxRes.text(), 'text/xml');
            const trkpts = xml.getElementsByTagName('trkpt');
            if (trkpts.length === 0) { alert(STRINGS.noGps); return; }

            const lats = Array.from(trkpts).map(p => parseFloat(p.getAttribute('lat')));
            const lons = Array.from(trkpts).map(p => parseFloat(p.getAttribute('lon')));

            // Step 3: Calculate cumulative distances
            const dists = [0];
            for (let i = 1; i < lats.length; i++) {
                dists.push(dists[i - 1] + getDistance(lats[i-1], lons[i-1], lats[i], lons[i]));
            }
            const totalKm = dists[dists.length - 1];
            console.log(`[Strava Renamer] ${totalKm.toFixed(1)} km, ${trkpts.length} trackpoints`);

            // Step 4: Select sample points
            const numSamples = Math.max(
                CONFIG.minSamples,
                Math.min(CONFIG.maxSamples, Math.round(totalKm / CONFIG.kmPerSample))
            );
            const indices = sampleByDistance(dists, numSamples);
            const coords = indices.map(i => ({ lat: lats[i], lon: lons[i] }));
            console.log(`[Strava Renamer] ${numSamples} sample points`);

            // Step 5: Geocode points
            setButtonState(btn, STRINGS.geocoding, 'is-loading');
            const rawNames = await geocodeAll(coords);
            console.log(`[Strava Renamer] Raw: ${rawNames.join(', ')}`);

            // Step 6: Clean up and select final places
            const places = subsample(dedupeConsecutive(rawNames), CONFIG.maxPlacesInName);
            console.log(`[Strava Renamer] Final: ${places.join(', ')}`);

            const newName = places.length > 0 ? places.join(' - ') : 'Route Activity';

            // Step 7: Fill in and focus the input
            nameInput.value = newName;
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
                generateAndFillName(btn);
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

    // Watch for DOM changes (in case page loads dynamically)
    new MutationObserver(injectButton).observe(document.body, { childList: true, subtree: true });
    injectButton();
})();
