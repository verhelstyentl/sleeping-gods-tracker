# Sleeping Gods campaign tracker

A single-page tracker for our Sleeping Gods campaign: the keywords we have, the locations we visited and the keyword options they offer, and the quests they gave us.

- `index.html` and `app.js` are the whole app (no build step). The Content-Security-Policy in `index.html` only lets scripts load from this site (no inline scripts or `onclick` handlers) and only lets the page connect to this site and the GitHub API; update it if you add an external script or service.
- `data.json` holds the campaign data. Every save from the page commits this file.
- `atlas.json` maps every location number on the map to its atlas page and, for named places, its name, e.g. `"130": { "page": "2", "name": "Zikura Trading Post", "port": true }`, with `"dungeon": true` on the six dungeon locations. When you add a location, the page and name are filled in from this file unless you type your own. The data was extracted from the fan-made Sleeping Gods map PDF on BoardGameGeek and checked against the Sleeping Gods Complete Map guide on Scribd: 204 locations, including the `R`-numbered ones.

## What it tracks

- **Keywords & quests**: every quest is a keyword plus its quest card number (leave the number empty if you don't know it yet). Each keyword records the location it was gained at and the locations whose options use it. Tick a keyword off when its quest is complete; a completed keyword still counts as one we have.
- **Locations** by number, with an optional name and atlas page. Each location has **options**: an option that needs one or more keywords, or an option with no keyword (`none`). Tick an option off once you've done it. A location can also hold **adventure cards**, each with a card number and a name. Locations with a dungeon (Dungeons expansion: 52, 92, 104, 146, 181, 217) get a dungeon marker automatically, with a tick for when the dungeon is done. Ports (the 20 places with a building icon on the map, e.g. 130 Zikura Trading Post) get `Port: <name>` at the top of their notes when you add them, and 188 gets `Zoo (marketplace)`. A location also lists the quests (keywords) gained there; you can add them from the location's edit screen.

Status is worked out automatically:

| Status | Meaning |
| --- | --- |
| Ready | At least one option isn't ticked off and we have every keyword it needs (or it needs none), or the location's dungeon isn't done yet. |
| Needs keyword | Options remain, but each one needs a keyword we don't have yet. |
| Done | Every option is ticked off. |

Every location keeps a timestamp for each **visit**. Adding a location logs the first visit (now, unless you change the time in the dialog); **Log visit** on a location's card logs a revisit. The Visits list in the edit dialog lets you fix a time, add a visit afterwards or remove one logged by mistake. Editing a location without logging a visit doesn't count as one.

Locations are listed most recently visited first; the Sort buttons switch to number or status, and the **More…** menu next to them to recently added, recently modified (saving a location or ticking one of its options or its dungeon counts as a change) or atlas page. Times are shown in 24-hour format.

The overview lists locations we can go back to, the adventure cards we've collected, the keywords we're still looking for, and open quests by card number.

## Hosting on GitHub Pages

1. Push this folder to a **public** GitHub repository (free GitHub Pages needs a public repository).
2. In the repository, open **Settings → Pages** and choose **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The site is published at `https://<owner>.github.io/<repo>/`. Share that link with the group. Viewers see a read-only page.

## Editing (one editor)

1. Create a token on GitHub at **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:
   - Repository access: **Only select repositories** → this repository
   - Permissions → Repository permissions → **Contents: Read and write**
2. On the site, click **Editor login** at the bottom and paste the token. The owner and repository are filled in automatically when the site runs on `github.io`.
3. Adding, editing or deleting a location or keyword, and logging a visit, saves straight away. Ticking boxes is saved when you click **Save**. Every save commits `data.json`, and viewers see the update within a minute or two.

The token is stored only in the editor's browser. Unsaved changes are kept as a draft in that browser until you save them. Use **Log out** in the footer to remove the token.

**Edit locally instead** (in the login dialog) lets you edit without a token. **Download data.json** then exports your changes, and you commit the file yourself.

## Running locally

```sh
python3 -m http.server
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't work, because the page has to fetch `data.json`.
