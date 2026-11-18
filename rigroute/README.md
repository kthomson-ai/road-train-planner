# RigRoute – Heavy Vehicle Navigation (WA)

*Smarter routes for heavier vehicles.*

Mobile-first web app (installable on Android from Chrome → "Add to Home screen").

## What's live vs demo
| Feature | Source | Status |
|---|---|---|
| RAV networks, conditions, intersection rules | Main Roads WA HVS ArcGIS | Live |
| Low structures (drive-under heights) | Main Roads WA HVS | Live |
| Closures, incidents, flooding, roadworks | Main Roads WA Travel Map (WebEOC) | Live, refreshed every 5 min |
| Rest areas, roadhouses, RTAAs | Main Roads WA HVS facilities | Live |
| Diesel, weighbridges, showers, mechanical, truck wash | Google Places | Live (business listings, not verified for truck access) |
| Bushfire warnings | Emergency WA | Link only (feed needs SLIP approval) |
| Permit guidance | Rules from Main Roads guidance | Indicative, not a permit |

## Structure
- `js/core.js` routing engine (graph build, turn bans, Dijkstra, alternatives)
- `js/nav.js` driving mode (GPS, voice, junction view)
- `js/services/` config, store, mainroads, google, vehicles, routing, alerts (backend-ready seams)
- `js/ui/` icons, map, app controller
