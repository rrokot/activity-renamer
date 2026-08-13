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
2. Open [Activity Renamer](https://raw.githubusercontent.com/rrokot/activity-renamer/master/activity-renamer.user.js).
3. Confirm the installation.

## Usage

1. Open a Strava activity's edit page.
2. Click **Build Name**.
3. Optionally edit the result with **✎ Edit Name**.
4. Save the activity.

## Edit Name

- Add, rename or remove places for the current activity.
- Save preferred place names for future activities.
- Block unwanted names.
- Back up or restore saved places and blocked names.
