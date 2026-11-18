# WA Road Train Route Planner (prototype)

Plans routes for restricted access vehicles (road trains) using only roads on Main Roads WA's approved Tandem Drive RAV networks (Networks 6–10), with spoken turn-by-turn driving mode.

**Live page:** https://kthomson-ai.github.io/road-train-planner/

- Network data is loaded live from Main Roads WA open data (CC BY 4.0) and cached in the browser for 7 days.
- Routing runs in the browser (Main Roads data, not Google).
- Map and address search use Google Maps (demo key) with Esri / OpenStreetMap Nominatim as backup.

**Planning aid only.** Always check the official Main Roads RAV Map, your notice or permit, and current road conditions.

## Editing
Source files are in `src/`. After changing them, run `python3 build.py` inside `src/` to rebuild `index.html`.
