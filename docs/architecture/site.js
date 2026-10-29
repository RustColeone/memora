"use strict";
// What is Memora's own on the architecture page: the top map (where Memora runs, the web app they all show, the
// server it syncs with, the mods it loads), the guides "How a mod goes in" and "How sync works", and how a mod looks
// among the folders. app.js, diagram.js and style.css are the viewer shared with DiscordStudyBot's page.
window.SITE = (() => {
  const MODS = "guide/mods";
  const SYNC = "guide/sync";
  const JS = "src/static/js/memo/";

  function topChart(h) {
    const { A, link, fileLink, symbolLink } = h;
    const chart = new h.Chart("DOWN", { overview: true });
    const shells = chart.group("Where Memora runs: one web app, three shells", () => {
      chart.node("Android app", { kind: "gateway", sub: "Capacitor · WebView · native plugins", target: link("android"),
                                  tip: "Sold on Google Play; anyone may build it from this repository." });
      chart.node("Desktop app", { kind: "gateway", sub: "Electron · Windows · macOS · Linux", target: fileLink("desktop/main.cjs") });
      chart.node("A browser", { kind: "gateway", sub: "pages served by a Memora server", target: fileLink("backend/api/frontend_routes.py") });
    }, { kind: "interfaces", pack: true });
    const parts = {};
    const app = chart.group("The web app (src/): the same pages everywhere", () => {
      parts.pages = chart.node("Pages", { kind: "startup", sub: "notes · spending · planner, one shell", target: link("src") });
      parts.shell = chart.node("Shell", { kind: "manager", sub: "menu · dialogs · tap outside · navigation", target: fileLink(`${JS}memo-shell.js`) });
      parts.notes = chart.node("Notes and spending", { kind: "module", sub: "memo-core · the two page variants", target: fileLink(`${JS}memo-core.js`) });
      parts.planner = chart.node("Planner", { kind: "module", sub: "calendar · to-dos · projects · habits · reminders", target: link("src/static/js/planner") });
      parts.ai = chart.node("AI contacts and chats", { kind: "module", sub: "bring your own key · tap-to-apply cards", target: fileLink(`${JS}memo-chats.js`) });
      parts.vault = chart.node("Vault · Discover", { kind: "module", sub: "encrypted items · search across pages", target: fileLink(`${JS}memo-vault.js`) });
      parts.tools = chart.node("Image tools and editor", { kind: "module", sub: "crop · curves · text · share safely", target: fileLink(`${JS}memo-tools.js`) });
      parts.mods = chart.node("Mods loader", { kind: "providers", sub: "folders you drop in, off until turned on", target: fileLink(`${JS}memo-mods.js`) });
    }, { kind: "core", pack: true });
    // The data path, outside the packed groups (an edge may not start inside one).
    parts.queue = chart.node("Operation queue", { kind: "gateway", sub: "every edit is an operation · last write wins", target: fileLink(`${JS}memo-operation-queue.js`) });
    parts.store = chart.node("Local store", { kind: "store", sub: "encrypted SQLite · sql.js in a browser", target: fileLink(`${JS}memo-state-db.js`) });
    const mods = chart.group("Mods (mods-examples/)", () => {
      for (const [folder, mod] of Object.entries(A.modules)) chart.node(mod.name || folder.split("/").pop(), { kind: "module", sub: "a mod", tip: mod.description, target: link(folder) });
      chart.node("How a mod goes in", { kind: "guide", sub: "write one of your own", target: link(MODS) });
    }, { kind: "capabilities", pack: true });
    const server = chart.group("Memora server (backend/): optional, yours", () => {
      parts.routes = chart.node("Routes", { kind: "startup", sub: "one blueprint per area", target: link("backend/api") });
      parts.log = chart.node("Sync log and database", { kind: "store", sub: "operations · snapshots · SQLite", target: fileLink("backend/services/operations_store.py") });
      parts.agent = chart.node("Agent API", { kind: "manager", sub: "tokens for outside agents · proposals as cards", target: fileLink("backend/api/agent_routes.py") });
      parts.serverAi = chart.node("The server's AI", { kind: "providers", sub: "only a key its owner sets", target: fileLink("backend/services/ai_step.py") });
      parts.one = chart.node("memora_server.py", { kind: "supervisor", sub: "one program · Docker · the desktop's built-in server", target: fileLink("backend/memora_server.py") });
    }, { kind: "engines", pack: true });
    const providers = chart.node("AI providers", { kind: "external", sub: "DeepSeek · Gemini · OpenAI · Claude · your own" });
    chart.group("Also", () => {
      chart.node("How sync works", { kind: "guide", sub: "operations, offline, last write wins", target: link(SYNC) });
      for (const root of A.roots.filter((item) => ["build_tools", "tests", "docs"].includes(item))) {
        chart.node(`${root}/`, { kind: "folder", sub: h.plural(h.filesUnder(root).length, "file"), target: link(root) });
      }
    }, { kind: "plain", pack: true });
    chart.edge(shells, app, { label: "show" });
    chart.edge(app, parts.queue, { label: "every edit" });
    chart.edge(parts.queue, parts.store, { arrow: "both", label: "saved first" });
    chart.edge(parts.queue, server, { arrow: "both", label: "push · pull operations" });
    chart.edge(mods, app, { label: "turned on in Settings" });
    chart.edge(app, providers, { dashed: true, label: "your key" });
    chart.edge(server, providers, { dashed: true, label: "its owner's key" });
    return chart;
  }

  function topPane(h) {
    const { make, link, linkList, heading } = h;
    const pane = [...heading("Architecture", "Memora")];
    pane.push(make("div", "doc", "Notes, spending and plans in one private notebook. Every box is a real folder, file, class or " +
      "function, read from the code by build_tools/architecture.cjs. Tap a box (or search above) to go in: a folder, a file " +
      "(its objects drawn around their functions), then one function, whose code shows here."));
    pane.push(make("p", "meta", h.counts()));
    pane.push(make("h3", "", "Read first"));
    pane.push(linkList([["How a mod goes in", link(MODS)], ["How sync works", link(SYNC)],
                        ["README: get Memora, build it", h.github("README.md")], ["Running the server", h.github("SERVER.md")],
                        ["Writing a mod: the reference", h.github("docs/MODS.md")]]));
    pane.push(make("h3", "", "Where Memora runs"));
    pane.push(linkList([["Android app", link("android"), "the web app in a WebView, with native plugins"],
                        ["Desktop app", link("desktop"), "Electron, with the built-in server"],
                        ["Server", link("backend"), "Flask; also serves the web app to a browser"]]));
    pane.push(make("h3", "", "The web app"));
    pane.push(linkList([["src/", link("src"), "pages, shared parts, scripts"],
                        ["The scripts every page loads, in order", link("src/partials/scripts-core.html")],
                        ["src/static/js/memo/", link("src/static/js/memo"), "one script per part"],
                        ["src/static/js/planner/", link("src/static/js/planner"), "the Planner page"]]));
    return pane;
  }

  // ---- the guide: how a mod goes in --------------------------------------------------------------------------
  function modsChart(h) {
    const { A, fileLink, symbolLink, link } = h;
    const chart = new h.Chart("DOWN", { overview: true });
    const example = Object.keys(A.modules)[0];
    const where = chart.group("Where the folder goes", () => {
      chart.node("Desktop app", { kind: "folder", sub: "<profile>/mods · Settings → Open mods folder", target: symbolLink("desktop/main.cjs", "mods") });
      chart.node("Android app", { kind: "folder", sub: "Android/data/<app>/files/mods, over USB", target: fileLink("android/app/src/main/java/com/laplacengan/memora/ModsPlugin.java") });
      chart.node("A Memora server", { kind: "folder", sub: "<base-dir>/mods, for its pages", target: fileLink("backend/api/mods_routes.py") });
    }, { kind: "plain", pack: true });
    const folder = chart.group("Your mod: one folder", () => {
      chart.node("mod.json", { kind: "data", sub: "id · name · memora: 1 · scripts · styles", target: example ? fileLink(`${example}/mod.json`) : "" });
      chart.node("main.js", { kind: "file", sub: "Memora.mod(id, setup)", target: example ? fileLink(`${example}/main.js`) : "" });
      chart.node("style.css", { kind: "file", sub: "optional" });
    }, { kind: "plain" });
    const settings = chart.node("Settings → Mods", { kind: "startup", sub: "off until you turn it on, on each device", target: symbolLink(`${JS}memo-mods.js`, "render") });
    const loader = chart.node("start()", { kind: "function", sub: "lists the folder, checks mod.json, loads the ones on", target: symbolLink(`${JS}memo-mods.js`, "start") });
    const setup = chart.node("setup(memora)", { kind: "function", sub: "what api() hands the mod", target: symbolLink(`${JS}memo-mods.js`, "api") });
    const gives = chart.group("What a mod can use", () => {
      chart.node("data.list · add · update", { kind: "store", sub: "notes · spending · plans, saved like any edit", target: symbolLink(`${JS}memo-operation-queue.js`, "OperationQueue.addOperation") });
      chart.node("menu.add · ui.sheet", { kind: "manager", sub: "a row in the menu, a sheet of its own", target: symbolLink(`${JS}memo-mods.js`, "renderMenu") });
      chart.node("tools.register", { kind: "providers", sub: "an image tool in the Tools sheet", target: fileLink(`${JS}memo-tools.js`) });
      chart.node("i18n · on · settings · url", { kind: "contracts", sub: "translations, events, its own values and files" });
    }, { kind: "core", pack: true });
    chart.edge(where, folder, { label: "put it in" });
    chart.edge(folder, settings, { label: "listed" });
    chart.edge(settings, loader, { label: "Apply changes" });
    chart.edge(loader, setup);
    chart.edge(setup, gives, { label: "gets" });
    return chart;
  }

  function modsPane(h) {
    const { A, files, make, link, linkList, heading, code } = h;
    const pane = [...heading("Guide", "How a mod goes in")];
    pane.push(make("div", "doc", "A mod adds to Memora from a folder: a menu item with a sheet of its own, an image tool, " +
      "translations, or anything its script does with what Memora gives it. No rebuild and no store: drop the folder in, " +
      "turn it on in Settings → Mods, tap Apply changes. The full reference is docs/MODS.md."));
    const steps = [
      ["1. Make a folder in the mods folder", "Desktop: %APPDATA%\\Memora\\mods on Windows, ~/Library/Application Support/Memora/mods " +
        "on macOS, ~/.config/Memora/mods on Linux (Settings → Mods → Open mods folder). Android: Android/data/com.laplacengan.memora/" +
        "files/mods, from a computer over USB. Server: <base-dir>/mods, for the pages it serves."],
      ["2. Describe it in mod.json", "{ \"id\": \"my-mod\", \"name\": \"My mod\", \"version\": \"1.0\", \"memora\": 1, \"description\": \"…\", " +
        "\"scripts\": [\"main.js\"], \"styles\": [\"style.css\"] }. memora is the mod API version; a mod for another version is " +
        "listed but not loaded. Files stay inside the folder (no ..)."],
      ["3. Register it from the script", "Memora.mod('my-mod', function (memora) { … }). setup runs once, after the notebook has " +
        "loaded, and may be async. memora.data.list('notes' | 'spending' | 'plans') gives copies (deleted and privacy-locked " +
        "entries left out); data.add and data.update save through the operation queue, so they sync like any edit. " +
        "menu.add puts a row in the menu's Mods section; ui.sheet opens a sheet; tools.register adds an image tool; " +
        "i18n.add takes rows of [English, Español, Français, Deutsch, 中文]; on('saved' | 'resume' | 'localechange'); " +
        "settings.get/set keep small values; url(file) is the address of a file in the folder."],
      ["4. Turn it on", "A mod runs with Memora's rights: it can read everything, the Vault included. So it is off until you " +
        "turn it on, on each device; a broken one shows its problem in Settings → Mods and never stops the app."],
    ];
    for (const [title, text] of steps) pane.push(make("h3", "", title), make("div", "doc", text));
    const example = Object.keys(A.modules)[0];
    if (example && files[`${example}/main.js`]) {
      pane.push(make("h3", "", `The example: ${example}/main.js`), code(`${example}/main.js`, 1, files[`${example}/main.js`].lines));
    }
    pane.push(make("h3", "", "Read more"));
    pane.push(linkList([["Writing a mod: the reference", h.github("docs/MODS.md")], ["The loader", link(`${JS}memo-mods.js`)],
                        ["The desktop app's mods folder", link("desktop/main.cjs", "mods")], ["The server's mods routes", link("backend/api/mods_routes.py")]]));
    return pane;
  }

  // ---- the guide: how sync works ---------------------------------------------------------------------------
  function syncChart(h) {
    const { symbolLink, fileLink } = h;
    const Q = `${JS}memo-operation-queue.js`;
    const chart = new h.Chart("RIGHT", { overview: true });
    const device = chart.group("This device", () => {
      chart.node("an edit", { kind: "startup", sub: "a note saved, a to-do ticked, an AI card tapped" });
      chart.node("addOperation()", { kind: "function", sub: "applies it here at once, queues it", target: symbolLink(Q, "OperationQueue.addOperation") });
      chart.node("Local store", { kind: "store", sub: "saved before anything is sent", target: fileLink(`${JS}memo-state-db.js`) });
      chart.node("processQueue()", { kind: "function", sub: "when online: push, then pull", target: symbolLink(Q, "OperationQueue.processQueue") });
    }, { kind: "interfaces" });
    const srv = chart.group("Your server", () => {
      chart.node("/api/operations", { kind: "gateway", sub: "push · pull since the last one seen", target: fileLink("backend/api/operations_routes.py") });
      chart.node("Operations log", { kind: "store", sub: "numbered, with snapshots", target: symbolLink("backend/services/operations_store.py", "OperationsStore") });
    }, { kind: "engines" });
    const other = chart.group("Your other devices", () => {
      chart.node("pullServerOperations()", { kind: "function", sub: "the operations since their last pull", target: symbolLink(Q, "OperationQueue.pullServerOperations") });
      chart.node("applyPull()", { kind: "function", sub: "last write wins, per entry", target: symbolLink(Q, "OperationQueue.applyPull") });
    }, { kind: "capabilities" });
    chart.edge(device, srv, { label: "push" });
    chart.edge(srv, other, { label: "pull" });
    return chart;
  }

  function syncPane(h) {
    const { make, link, linkList, heading } = h;
    const pane = [...heading("Guide", "How sync works")];
    const steps = [
      ["Every edit is an operation", "Saving a note, ticking a to-do or tapping an AI card adds an operation (create, update or " +
        "delete of one entry) to the queue. It applies on this device at once and is saved with the notebook before anything " +
        "is sent, so nothing waits for the network."],
      ["Push, then pull", "With a server set, the queue pushes the operations the server has not seen and pulls the ones since " +
        "its last pull. Offline, they wait; a failed push is retried and never overtaken by a later operation on the same entry."],
      ["Last write wins", "When two devices change the same entry, the later change wins for that entry. There are no merges and " +
        "no locks: simple on purpose."],
      ["Pages and collections", "Notes, spending and plans each have their own log, and so do the Vault, AI contacts and their " +
        "messages. Vault items arrive encrypted; the server never sees their text."],
      ["The password", "A server can ask for a sync password (X-Sync-Password). Outside agents get their own tokens through the " +
        "Agent API instead, with read, propose or write per page."],
    ];
    for (const [title, text] of steps) pane.push(make("h3", "", title), make("div", "doc", text));
    pane.push(make("h3", "", "Read more"));
    pane.push(linkList([["The operation queue", link(`${JS}memo-operation-queue.js`)], ["The server's routes", link("backend/api/operations_routes.py")],
                        ["Running a server", h.github("SERVER.md")], ["API reference", h.github("API_DOCUMENTATION.md")]]));
    return pane;
  }

  // ---- a mod among the folders ----------------------------------------------------------------------------------
  function folderBox(h, folder) {
    const mod = h.A.modules[folder];
    return mod ? { kind: "module", tip: mod.description, sub: "a mod" } : null;
  }
  function folderPane(h, folder) {
    const mod = h.A.modules[folder];
    if (!mod) return null;
    return { kind: "Mod", nodes: [h.make("p", "doc", mod.description)] };
  }

  return {
    name: "Memora",
    top: { chart: topChart, pane: topPane, title: "The whole of Memora",
           hint: "Where it runs, the web app they all show, the server it syncs with, and the mods it loads. Tap a box to go in." },
    guides: [{ path: MODS, label: "How a mod goes in", keywords: "mod mods plugin extension folder guide", chart: modsChart, pane: modsPane,
               title: "How a mod goes in", hint: "From one folder to what a mod can use. Tap a box for the real code; the steps are in the details." },
             { path: SYNC, label: "How sync works", keywords: "sync server operations queue offline last write wins push pull",
               chart: syncChart, pane: syncPane, title: "How sync works", hint: "An edit on one device, through your server, to the others." }],
    deep: ["src", "backend", "android"],
    folderBox, folderPane,
  };
})();
