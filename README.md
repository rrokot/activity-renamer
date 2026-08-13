# Activity Renamer

Activity Renamer is a Tampermonkey userscript that creates a Strava activity
name from the places visited along the route:

    Cottbus - Sielow - Guhrow - Burg - Dissen - Sielow - Cottbus

## How the name is generated

- Consecutive points near one place become a single visit; later revisits stay.
- Settlements take priority; named roads only fill gaps.
- 3–7 geographically spread stops represent the route, including its ends.
- Saved and manual choices override the selection; middle stops go first if the
  title is too long.

## Installation

1. Open the Tampermonkey dashboard and create a new userscript.
2. Replace its contents with `activity-renamer.user.js`.
3. Save the script.

## Usage

1. Open the edit page of a Strava activity.
2. Click **Generate from Geo** next to the title.
3. Review the generated name and, if needed, click **✎ Adjust**.
4. Save the activity in Strava.

## Adjusting a name

The **✎ Adjust** dialog lets you:

- rename or remove a place from the current activity;
- add another place passed along the route;
- save a preferred place name for future activities;
- prevent an unwanted place from appearing in generated names;
- back up and restore saved places and blocked names.
