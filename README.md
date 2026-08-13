# Activity Renamer

Tampermonkey userscript that names Strava activities by places along the route.

```text
Cottbus - Sielow - Guhrow - Burg - Dissen - Sielow - Cottbus
```

## Naming

- Orders visited places along the route.
- Merges one continuous visit but preserves later revisits.
- Prioritizes settlements; named roads fill gaps.
- Selects geographically spread places and keeps the route ends.
- Applies saved and manual choices; removes middle places if the title is too
  long.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. In Chrome or Edge 138+, open Tampermonkey's extension settings and enable
   **Allow User Scripts**.
3. Open [Activity Renamer](https://raw.githubusercontent.com/rrokot/activity-renamer/master/activity-renamer.user.js).
4. Confirm the installation.

## Usage

1. Open a Strava activity's edit page.
2. Click **Build Name**.
3. Optionally edit the result with **✎ Edit Name**.
4. Save the activity.

## Edit Name

- Add, rename or remove places for the current activity.
- Set the maximum number of places in generated names (2 or more).
- Browse named roads in a separate collapsible list.
- Save preferred place names for future activities in **Favorites**.
- Manage unwanted names separately in **Never in a name**.
