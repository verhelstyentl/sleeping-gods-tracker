# Sleeping Gods campaign tracker

A single-page tracker for our Sleeping Gods campaign: the keywords we have, the locations we visited and the keyword options they offer, and the quests they gave us.

- `index.html` is the whole app (no build step).
- `data.json` holds the campaign data. Every save from the page commits this file.
- `atlas.json` maps every location number on the map to its atlas page and, for named places, its name, e.g. `"130": { "page": "2", "name": "Zikura Trading Post" }`. When you add a location, the page and name are filled in from this file unless you type your own. The data was extracted from the fan-made Sleeping Gods map PDF on BoardGameGeek: 203 locations, including the `R`-numbered ones.

## What it tracks

- **Keywords** we have, with their quest number (if known), where we gained them and where they are used. Tick a keyword off when its quest is complete. A completed keyword still counts as one we have.
- **Locations** by number, with an optional name and atlas page. Each location has **options**: an option that needs one or more keywords, or an option with no keyword (`none`). Tick an option off once you've done it.
- **Quests** a location gave us, each with an optional related keyword. Tick a quest off when it's done.

Status is worked out automatically:

| Status | Meaning |
| --- | --- |
| Ready | At least one option isn't ticked off and we have every keyword it needs (or it needs none). |
| Needs keyword | Options remain, but each one needs a keyword we don't have yet. |
| Done | Every option is ticked off. |

The overview lists locations we can go back to, the keywords we're still looking for, and open quests.

## Hosting on GitHub Pages

1. Push this folder to a **public** GitHub repository (free GitHub Pages needs a public repository).
2. In the repository, open **Settings → Pages** and choose **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The site is published at `https://<owner>.github.io/<repo>/`. Share that link with the group. Viewers see a read-only page.

## Editing (one editor)

1. Create a token on GitHub at **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:
   - Repository access: **Only select repositories** → this repository
   - Permissions → Repository permissions → **Contents: Read and write**
2. On the site, click **Editor login** at the bottom and paste the token. The owner and repository are filled in automatically when the site runs on `github.io`.
3. Make changes, then click **Save**. That commits `data.json`, and viewers see the update within a minute or two.

The token is stored only in the editor's browser. Unsaved changes are kept as a draft in that browser until you save them. Use **Log out** in the footer to remove the token.

**Edit locally instead** (in the login dialog) lets you edit without a token. **Download data.json** then exports your changes, and you commit the file yourself.

## Running locally

```sh
python3 -m http.server
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't work, because the page has to fetch `data.json`.
