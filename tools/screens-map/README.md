# The map of the screens

Every screen of the web app, flow by flow, as a map you can pan and zoom (React Flow). Each flow is a row of its screens in order, and the arrows say what leads from one to the next. You can switch between the desktop and the iPhone, and open any screen full size.

```sh
cargo build --release -p plim-server -p plim-cli         # (the web flows also run the connector, plim mcp --http)
cd tools/screenshots && npm ci && npm run web:shots   # desktop and iPhone (Chromium): out/map/screens.json, out/map/images/
node ios.mjs                                           # real iOS Safari, on a Mac's iOS Simulator (see ios.mjs)
node ../screens-map/build.mjs                          # the page: out/map/index.html
```

`tools/screenshots/out/` isn't in git: the screens live with the map, not in the repository. Each tool records its own device's screens (`screens-<device>.json`, through `map.mjs`) and rebuilds `screens.json` from them all, so either can be run again on its own. `ONLY=tour,keyboard node ios.mjs` takes those flows again and keeps the rest.

- **Desktop and iPhone (Chromium)** come from the web flows, `tools/screenshots/web/NN-name.mjs` (run by `web.mjs`). Each `shot()` there (usually through `s(page, name, via)`) is a screen on the map: its flow is the number its name starts with (`FLOWS` in `web/harness.mjs` lists their titles), its device is the page's (`newPage(…, { device })`), and `via` labels the arrow to it when the step isn't plain.
- **iOS Safari** comes from `tools/screenshots/ios.mjs`: each of its flows is a row (`TITLES`), from "Around the app" (the main screens in real Safari) to the keyboard, tapping, a long note, links and selecting text. Each `look()` or `shot()` is a screen.
- **Captions and arrows:** `captions.json` has a caption for each web screen (`screens`, by its name), what each flow is about (`flows`, by its number), and what you do to get to each screen (`via`, by its name, web and iOS Safari): the label of the arrow to it, with the device too when it changes. Add a caption and a `via` when you add a `shot()` or a `look()`. A `via` passed to `shot()` itself wins.
- **Reviews:** a `reviews.json` beside the page, `{ "desktop/03-notes-4-row-menu": { "status": "look" | "ok", "note": "…" } }`, puts a badge on those screens and the note beside them.
- **Hosting it yourself:** `node build.mjs --standalone` writes the page as a whole HTML document. Serve `out/map/` as static files. The page loads React and React Flow from public CDNs (cdnjs, jsdelivr). React Flow's stylesheet is inlined from `vendor/` (MIT, see `vendor/xyflow-LICENSE`).
