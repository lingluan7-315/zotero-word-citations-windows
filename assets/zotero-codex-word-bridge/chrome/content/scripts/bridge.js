"use strict";

(function () {
  const BRIDGE_VERSION = "0.2.0";
  const DEFAULT_STYLE_ID = "http://www.zotero.org/styles/apa";
  const WORD_AGENT = "MacWord16";
  const WORD_DOCUMENT_ID = __CODEX_WORD_DOCUMENT_ID__;
  const JSON_MIME = "application/json";
  const TEMPLATE_VERSION = 2;
  const WINDOW_TIMEOUT_MS = 20000;
  const COMMAND_TIMEOUT_MS = 120000;
  let LAST_TASK = {
    state: "idle",
    label: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };

  const ENDPOINTS = [
    "/codex/zotero-word/ping",
    "/codex/zotero-word/status",
    "/codex/zotero-word/addons",
    "/codex/zotero-word/addons/enable",
    "/codex/zotero-word/insert",
    "/codex/zotero-word/style",
    "/codex/zotero-word/refresh",
    "/codex/zotero-word/bibliography",
    "/codex/zotero-word/debug/echo",
    "/codex/zotero-word/debug/parse",
    "/codex/zotero-word/debug/background",
    "/codex/zotero-word/debug/echo-get",
    "/codex/zotero-word/debug/parse-get",
    "/codex/zotero-word/debug/background-get",
    "/codex/zotero-word/insert-get",
    "/codex/zotero-word/inject-current-get",
  ];

  function jsonResponse(status, payload) {
    return [status, JSON_MIME, JSON.stringify(payload)];
  }

  function ok(payload) {
    return jsonResponse(200, Object.assign({ ok: true }, payload || {}));
  }

  function wrapInit(handler) {
    return async function (request) {
      try {
        return await handler(request);
      } catch (error) {
        Zotero.logError(error);
        return jsonResponse(500, {
          ok: false,
          error: error && error.message ? error.message : `${error}`,
        });
      }
    };
  }

  function sleep(ms) {
    return Zotero.Promise.delay(ms);
  }

  function getCurrentWindow() {
    const win = Zotero.Integration.currentWindow;
    if (!win || win.closed) {
      return null;
    }
    return win;
  }

  function getWindowURL(win) {
    try {
      return `${win.location}`;
    } catch (error) {
      return "";
    }
  }

  function isDocPrefsWindow(win) {
    return getWindowURL(win).includes("integrationDocPrefs.xhtml");
  }

  function isQuickFormatWindow(win) {
    const url = getWindowURL(win);
    return url.includes("quickFormat.xhtml") || url.includes("citationDialog.xhtml");
  }

  function isEditBibliographyWindow(win) {
    return getWindowURL(win).includes("editBibliographyDialog.xhtml");
  }

  function summarizeIntegrationState() {
    const win = getCurrentWindow();
    const session = Zotero.Integration.currentSession || null;
    return {
      busy: Boolean(Zotero.Integration.currentDoc),
      currentWindowURL: win ? getWindowURL(win) : null,
      currentWindowTitle: win && win.document ? win.document.title || null : null,
      currentSessionStyleID: session && session.data && session.data.style
        ? session.data.style.styleID || null
        : null,
      currentSessionFieldType: session && session.data && session.data.prefs
        ? session.data.prefs.fieldType || null
        : null,
      lastTask: LAST_TASK,
    };
  }

  function runBackground(label, task) {
    LAST_TASK = {
      state: "running",
      label,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    setTimeout(() => {
      Promise.resolve().then(task).then(
        (result) => {
          LAST_TASK = Object.assign({}, LAST_TASK, {
            state: "completed",
            finishedAt: new Date().toISOString(),
            result: result || null,
            error: null,
          });
        },
        (error) => {
          Zotero.logError(error);
          LAST_TASK = Object.assign({}, LAST_TASK, {
            state: "failed",
            finishedAt: new Date().toISOString(),
            result: null,
            error: error && error.message ? error.message : `${error}`,
          });
        }
      );
    }, 100);
    return LAST_TASK;
  }

  function getAddonManager() {
    if (typeof ChromeUtils !== "undefined" && ChromeUtils.importESModule) {
      return ChromeUtils.importESModule(
        "resource://gre/modules/AddonManager.sys.mjs"
      ).AddonManager;
    }
    return ChromeUtils.import("resource://gre/modules/AddonManager.jsm").AddonManager;
  }

  function serializeAddon(addon) {
    return {
      id: addon.id || null,
      name: addon.name || null,
      version: addon.version || null,
      type: addon.type || null,
      isActive: Boolean(addon.isActive),
      appDisabled: Boolean(addon.appDisabled),
      userDisabled: Boolean(addon.userDisabled),
      hidden: Boolean(addon.hidden),
      installDate: addon.installDate
        ? new Date(addon.installDate).toISOString()
        : null,
      updateDate: addon.updateDate
        ? new Date(addon.updateDate).toISOString()
        : null,
    };
  }

  async function listInstalledAddons() {
    const AddonManager = getAddonManager();
    const addons = await AddonManager.getAllAddons();
    return addons
      .filter((addon) => addon.type === "extension")
      .map((addon) => serializeAddon(addon))
      .sort((left, right) =>
        (left.name || left.id || "").localeCompare(right.name || right.id || "")
      );
  }

  async function enableAddons(ids) {
    const AddonManager = getAddonManager();
    const updated = [];
    for (const id of ids) {
      const addon = await AddonManager.getAddonByID(id);
      if (!addon) {
        throw new Error(`Add-on not found: ${id}`);
      }
      await addon.enable();
      updated.push(serializeAddon(addon));
    }
    return updated.sort((left, right) =>
      (left.name || left.id || "").localeCompare(right.name || right.id || "")
    );
  }

  function trackPromise(promise) {
    const tracked = {
      settled: false,
      rejected: false,
      error: null,
      result: null,
      promise: null,
    };

    tracked.promise = Promise.resolve(promise).then(
      (result) => {
        tracked.settled = true;
        tracked.result = result;
        return result;
      },
      (error) => {
        tracked.settled = true;
        tracked.rejected = true;
        tracked.error = error;
        throw error;
      }
    );

    return tracked;
  }

  async function waitForWindowOrCompletion(tracked, kinds, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tracked.rejected) {
        throw tracked.error;
      }

      const win = getCurrentWindow();
      if (win) {
        if (kinds.includes("docPrefs") && isDocPrefsWindow(win)) {
          return { kind: "docPrefs", win };
        }
        if (kinds.includes("quickFormat") && isQuickFormatWindow(win)) {
          return { kind: "quickFormat", win };
        }
        if (kinds.includes("editBibliography") && isEditBibliographyWindow(win)) {
          return { kind: "editBibliography", win };
        }
      }

      if (tracked.settled) {
        return { kind: "completed" };
      }

      await sleep(100);
    }

    if (tracked.rejected) {
      throw tracked.error;
    }

    throw new Error(`Timed out waiting for ${label}`);
  }

  async function waitForCondition(getValue, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) {
        return value;
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function resolveStyleID(requestedStyle) {
    const raw = `${requestedStyle || ""}`.trim();
    const normalized = raw.toLowerCase();

    await Zotero.Styles.init();

    if (
      !raw ||
      normalized === "apa" ||
      normalized === "apa 7" ||
      normalized === "apa7" ||
      normalized === "american psychological association 7th edition" ||
      normalized === "apa style 7th edition"
    ) {
      return DEFAULT_STYLE_ID;
    }

    if (Zotero.Styles.get(raw)) {
      return raw;
    }

    const styles = Array.from(Zotero.Styles.getVisible());
    const exact = styles.find((style) => style.title.toLowerCase() === normalized);
    if (exact) {
      return exact.styleID;
    }

    const partialMatches = styles.filter((style) => {
      const title = style.title.toLowerCase();
      return title.includes(normalized) || normalized.includes(title);
    });
    if (partialMatches.length === 1) {
      return partialMatches[0].styleID;
    }

    if (/^https?:\/\//i.test(raw)) {
      const installed = await Zotero.Styles.install({ url: raw }, raw, true);
      if (installed && installed.styleID) {
        return installed.styleID;
      }
    }

    throw new Error(`Citation style not found: ${raw}`);
  }

  async function buildCitationItem(raw) {
    if (typeof raw === "number" || typeof raw === "string") {
      raw = { id: raw };
    } else if (!raw || typeof raw !== "object") {
      throw new Error("Each citation item must be a Zotero item ID or an object");
    }

    const itemID = Number.parseInt(raw.id ?? raw.itemID, 10);
    if (!Number.isInteger(itemID) || itemID <= 0) {
      throw new Error(`Invalid Zotero item ID: ${raw.id ?? raw.itemID}`);
    }

    const item = (await Zotero.Items.getAsync(itemID)) || Zotero.Items.get(itemID);
    if (!item || item.deleted) {
      throw new Error(`Zotero item not found: ${itemID}`);
    }

    const citationItem = { id: itemID };
    for (const key of ["locator", "label", "prefix", "suffix"]) {
      if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") {
        citationItem[key] = `${raw[key]}`;
      }
    }

    if (raw["suppress-author"] || raw.suppressAuthor) {
      citationItem["suppress-author"] = true;
    }
    if (raw["author-only"] || raw.authorOnly) {
      citationItem["author-only"] = true;
    }
    if (raw.ignoreRetraction) {
      citationItem.ignoreRetraction = true;
    }

    return citationItem;
  }

  async function parseCitationItems(payload) {
    let rawItems = [];
    if (Array.isArray(payload.citationItems) && payload.citationItems.length) {
      rawItems = payload.citationItems;
    } else if (Array.isArray(payload.itemIDs) && payload.itemIDs.length) {
      rawItems = payload.itemIDs;
    } else if (payload.itemID !== undefined && payload.itemID !== null) {
      rawItems = [payload.itemID];
    }

    if (!rawItems.length) {
      throw new Error("No citation items provided");
    }

    return Promise.all(rawItems.map(buildCitationItem));
  }

  function triggerWordCommand(commandName) {
    if (Zotero.Integration.currentDoc) {
      throw new Error("Another Zotero word integration request is already running");
    }
    return trackPromise(
      Zotero.Integration.execCommand(
        WORD_AGENT,
        commandName,
        WORD_DOCUMENT_ID,
        TEMPLATE_VERSION
      )
    );
  }

  async function configureDocPrefsWindow(win, options) {
    const styleID = await resolveStyleID(options.style || DEFAULT_STYLE_ID);
    const io =
      win.arguments &&
      win.arguments[0] &&
      (win.arguments[0].wrappedJSObject || win.arguments[0]);
    const styleConfigurator = await waitForCondition(
      () => {
        if (win.closed) {
          throw new Error("Document Preferences dialog closed before automation");
        }
        const element = win.document.querySelector("#style-configurator");
        if (!element || !element.initialized) {
          return null;
        }
        return element;
      },
      WINDOW_TIMEOUT_MS,
      "Document Preferences dialog to initialize"
    );

    if (io) {
      io.style = styleID;
      io.locale = options.locale !== undefined ? options.locale : null;
      if (io.primaryFieldType) {
        io.fieldType = io.primaryFieldType;
      }
      io.delayCitationUpdates = false;
      io.automaticJournalAbbreviations = false;
    }

    styleConfigurator.style = styleID;
    if (options.locale !== undefined) {
      styleConfigurator.locale = options.locale;
    }

    const bookmarks = win.document.getElementById("formatUsingBookmarks");
    if (bookmarks) {
      bookmarks.checked = false;
    }

    const citationUpdates = win.document.getElementById("automaticCitationUpdates-checkbox");
    if (citationUpdates) {
      citationUpdates.checked = true;
    }

    const abbreviations = win.document.getElementById("automaticJournalAbbreviations");
    if (abbreviations) {
      abbreviations.checked = false;
    }

    const dialog = win.document.querySelector("dialog");
    if (!dialog || typeof dialog.acceptDialog !== "function") {
      throw new Error("Could not find Document Preferences accept dialog");
    }
    dialog.acceptDialog();

    return styleID;
  }

  function buildBubbleLabel(citationItem) {
    const item = Zotero.Items.get(citationItem.id);
    if (!item) {
      return `${citationItem.id}`;
    }

    let label = item.getField("firstCreator");
    const title = item.getDisplayTitle();
    if (!label) {
      const truncated = title.substr(0, 32) + (title.length > 32 ? "…" : "");
      label = `“${truncated}”`;
    }

    const date = item.getField("date", true, true);
    if (date) {
      const year = date.substr(0, 4);
      if (year !== "0000") {
        label += `, ${parseInt(year, 10)}`;
      }
    }

    if (citationItem.locator) {
      const locatorLabel = citationItem.label || "page";
      const shortLabel =
        Zotero.Cite.getLocatorString(locatorLabel, "short") || locatorLabel;
      label += `, ${shortLabel.toLowerCase()} ${citationItem.locator}`;
    }

    return label;
  }

  function populateQuickFormatWindow(win, citationItems) {
    const editor = win.document.querySelector(".citation-dialog.editor");
    if (!editor) {
      throw new Error("Quick Format editor not found");
    }

    editor.querySelectorAll(".bubble").forEach((node) => node.remove());
    const input = editor.querySelector(".zotero-bubble-input");

    for (const citationItem of citationItems) {
      const bubble = win.document.createElement("div");
      bubble.className = "citation-dialog bubble";
      bubble.setAttribute("draggable", "true");
      bubble.setAttribute("role", "button");
      bubble.setAttribute("tabindex", "0");
      bubble.dataset.citationItem = JSON.stringify(citationItem);
      bubble.textContent = buildBubbleLabel(citationItem);
      editor.insertBefore(bubble, input || null);
    }
  }

  function dedupeCitationItems(citationItems) {
    const seen = new Set();
    const deduped = [];
    for (const citationItem of citationItems) {
      const key = JSON.stringify(citationItem);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(Object.assign({}, citationItem));
    }
    return deduped;
  }

  async function waitForQuickFormatEditor(win) {
    return waitForCondition(
      () => {
        if (win.closed) {
          throw new Error("Quick Format dialog closed before editor initialization");
        }

        const deck = win.document.querySelector(".citation-dialog.deck");
        const editor = win.document.querySelector(".citation-dialog.editor");
        const input = editor && editor.querySelector(".zotero-bubble-input");
        if (!deck || !win.Zotero_QuickFormat || !editor || !input) {
          return false;
        }

        return { deck, editor };
      },
      WINDOW_TIMEOUT_MS,
      "Quick Format dialog editor"
    );
  }

  async function acceptCitationDialogWindow(win, citationItems) {
    await waitForCondition(
      () => {
        if (win.closed) {
          throw new Error("Citation dialog closed before automation");
        }
        return win.DIALOG_STATE && win.DIALOG_STATE.loaded && win.IOManager && win.CitationDataManager;
      },
      WINDOW_TIMEOUT_MS,
      "Zotero 9 citation dialog API"
    );

    const items = [];
    for (const citationItem of citationItems) {
      const item = (await Zotero.Items.getAsync(citationItem.id)) || Zotero.Items.get(citationItem.id);
      if (!item || item.deleted) {
        throw new Error(`Zotero item not found: ${citationItem.id}`);
      }
      items.push(item);
    }

    await win.IOManager.addItemsToCitation(items, { noInputRefocus: true, index: null });

    for (const citationItem of citationItems) {
      if (!citationItem.locator && !citationItem.label && !citationItem.prefix && !citationItem.suffix && !citationItem["suppress-author"]) {
        continue;
      }
      const matches = win.CitationDataManager.getItems({ itemID: citationItem.id });
      const bubbleItem = matches[matches.length - 1];
      if (!bubbleItem) {
        continue;
      }
      if (citationItem.locator) bubbleItem.locator = citationItem.locator;
      if (citationItem.label) bubbleItem.label = citationItem.label;
      if (citationItem.prefix) bubbleItem.prefix = citationItem.prefix;
      if (citationItem.suffix) bubbleItem.suffix = citationItem.suffix;
      if (citationItem["suppress-author"]) bubbleItem.suppressAuthor = true;
    }
    win.IOManager.updateBubbleInput();

    if (typeof win.accept === "function") {
      await win.accept();
    } else {
      const acceptButton = win.document.getElementById("accept-button");
      if (!acceptButton) {
        throw new Error("Citation dialog accept button not found");
      }
      acceptButton.click();
    }
  }

  async function acceptQuickFormatWindow(win, citationItems) {
    if (win.DIALOG_STATE || getWindowURL(win).includes("citationDialog.xhtml")) {
      return acceptCitationDialogWindow(win, citationItems);
    }

    const io = await waitForCondition(
      () => {
        if (win.closed) {
          throw new Error("Quick Format dialog closed before automation");
        }
        return win.arguments && win.arguments[0] && win.arguments[0].wrappedJSObject;
      },
      WINDOW_TIMEOUT_MS,
      "Quick Format dialog arguments"
    );

    const { deck, editor } = await waitForQuickFormatEditor(win);
    const uniqueCitationItems = dedupeCitationItems(citationItems);

    // Wait for Zotero's own onLoad initialization to finish before injecting
    // bubbles, otherwise Zotero may render the same citation items a second time.
    io.citation.citationItems = [];
    io.citation.sortedItems = [];
    editor.querySelectorAll(".bubble").forEach((node) => node.remove());

    io.citation.citationItems = uniqueCitationItems;
    populateQuickFormatWindow(win, io.citation.citationItems);

    for (let attempt = 0; attempt < 40; attempt++) {
      win.Zotero_QuickFormat.accept();
      if (deck.selectedIndex === 1) {
        return;
      }
      await sleep(100);
    }

    throw new Error("Quick Format dialog did not accept injected citation items");
  }

  async function acceptEditBibliographyWindow(win) {
    const dialog = await waitForCondition(
      () => {
        if (win.closed) {
          throw new Error("Edit Bibliography dialog closed before automation");
        }
        return win.document.querySelector("dialog");
      },
      WINDOW_TIMEOUT_MS,
      "Edit Bibliography dialog"
    );
    dialog.acceptDialog();
  }

  async function runStyleAutomation(style) {
    const tracked = triggerWordCommand("setDocPrefs");
    const state = await waitForWindowOrCompletion(
      tracked,
      ["docPrefs"],
      WINDOW_TIMEOUT_MS,
      "Document Preferences dialog"
    );

    if (state.kind !== "docPrefs") {
      throw new Error("Document Preferences dialog did not open");
    }

    const styleID = await configureDocPrefsWindow(state.win, { style });
    await Promise.race([
      tracked.promise,
      sleep(COMMAND_TIMEOUT_MS).then(() => {
        throw new Error("Timed out waiting for Word style update to finish");
      }),
    ]);
    Zotero.Integration.currentSession = false;

    return {
      styleID,
      fieldType: "Field",
      updatedExistingFields: true,
    };
  }

  async function runInsertAutomation(citationItems, style) {
    const tracked = triggerWordCommand("addCitation");
    let state = await waitForWindowOrCompletion(
      tracked,
      ["docPrefs", "quickFormat"],
      WINDOW_TIMEOUT_MS,
      "Document Preferences or Quick Format dialog"
    );

    let styleID = null;
    if (state.kind === "docPrefs") {
      styleID = await configureDocPrefsWindow(state.win, { style });
      state = await waitForWindowOrCompletion(
        tracked,
        ["quickFormat"],
        WINDOW_TIMEOUT_MS,
        "Quick Format dialog"
      );
    }

    if (state.kind !== "quickFormat") {
      throw new Error("Quick Format dialog did not open");
    }

    await acceptQuickFormatWindow(state.win, citationItems);
    await Promise.race([
      tracked.promise,
      sleep(COMMAND_TIMEOUT_MS).then(() => {
        throw new Error("Timed out waiting for Word citation insertion to finish");
      }),
    ]);
    Zotero.Integration.currentSession = false;

    return {
      styleID: styleID || DEFAULT_STYLE_ID,
      fieldType: "Field",
      citations: [
        {
          citationID: null,
          itemIDs: citationItems.map((item) => item.id),
        },
      ],
    };
  }

  async function runInjectCurrentAutomation(citationItems, style) {
    let win = await waitForCondition(
      () => getCurrentWindow(),
      WINDOW_TIMEOUT_MS,
      "an open Zotero integration dialog"
    );

    let styleID = null;
    if (isDocPrefsWindow(win)) {
      styleID = await configureDocPrefsWindow(win, { style });
      win = await waitForCondition(
        () => {
          const current = getCurrentWindow();
          return current && isQuickFormatWindow(current) ? current : null;
        },
        WINDOW_TIMEOUT_MS,
        "Quick Format dialog after Document Preferences"
      );
    }

    if (!isQuickFormatWindow(win)) {
      throw new Error(`Current Zotero integration window is not Quick Format: ${getWindowURL(win)}`);
    }

    await acceptQuickFormatWindow(win, citationItems);
    if (Zotero.Integration.currentCommandPromise) {
      await Promise.race([
        Zotero.Integration.currentCommandPromise,
        sleep(COMMAND_TIMEOUT_MS).then(() => {
          throw new Error("Timed out waiting for Word citation insertion to finish");
        }),
      ]);
    } else {
      await waitForCondition(
        () => !Zotero.Integration.currentDoc,
        COMMAND_TIMEOUT_MS,
        "Word citation insertion to finish"
      );
    }

    return {
      styleID: styleID || DEFAULT_STYLE_ID,
      fieldType: "Field",
      citations: [
        {
          citationID: null,
          itemIDs: citationItems.map((item) => item.id),
        },
      ],
    };
  }

  async function runRefreshAutomation() {
    const tracked = triggerWordCommand("refresh");
    await Promise.race([
      tracked.promise,
      sleep(COMMAND_TIMEOUT_MS).then(() => {
        throw new Error("Timed out waiting for Word refresh to finish");
      }),
    ]);
    Zotero.Integration.currentSession = false;

    return {
      styleID: null,
      fieldType: "Field",
    };
  }

  async function runBibliographyAutomation(style) {
    const tracked = triggerWordCommand("addEditBibliography");
    let state = await waitForWindowOrCompletion(
      tracked,
      ["docPrefs", "editBibliography"],
      WINDOW_TIMEOUT_MS,
      "Document Preferences or Edit Bibliography dialog"
    );

    let styleID = null;
    if (state.kind === "docPrefs") {
      styleID = await configureDocPrefsWindow(state.win, { style });
      state = await waitForWindowOrCompletion(
        tracked,
        ["editBibliography"],
        5000,
        "bibliography command to finish"
      );
    }

    if (state.kind === "editBibliography") {
      await acceptEditBibliographyWindow(state.win);
    }

    await Promise.race([
      tracked.promise,
      sleep(COMMAND_TIMEOUT_MS).then(() => {
        throw new Error("Timed out waiting for Word bibliography update to finish");
      }),
    ]);
    Zotero.Integration.currentSession = false;

    return {
      styleID: styleID || DEFAULT_STYLE_ID,
      fieldType: "Field",
    };
  }

  function registerEndpoints() {
    Zotero.Server.Endpoints["/codex/zotero-word/ping"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/ping"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function () {
        return ok({
          bridgeVersion: BRIDGE_VERSION,
          zoteroVersion: Zotero.version,
          port: Zotero.Server.port,
        });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/status"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/status"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function () {
        return ok(
          Object.assign(
            {
              bridgeVersion: BRIDGE_VERSION,
              zoteroVersion: Zotero.version,
            },
            summarizeIntegrationState()
          )
        );
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/addons"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/addons"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function () {
        const addons = await listInstalledAddons();
        return ok({
          bridgeVersion: BRIDGE_VERSION,
          zoteroVersion: Zotero.version,
          count: addons.length,
          activeCount: addons.filter((addon) => addon.isActive).length,
          addons,
        });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/addons/enable"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/addons/enable"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function ({ data }) {
        const payload = data || {};
        const addons = await listInstalledAddons();
        const ids = payload.all
          ? addons.map((addon) => addon.id).filter(Boolean)
          : (payload.ids || []).filter(Boolean);
        if (!ids.length) {
          throw new Error("Provide add-on ids or set all=true");
        }
        const updated = await enableAddons(ids);
        return ok({
          updatedCount: updated.length,
          addons: updated,
        });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/debug/echo"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/debug/echo"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function ({ data }) {
        return ok({ data: data || {} });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/debug/parse"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/debug/parse"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function ({ data }) {
        return ok({ citationItems: await parseCitationItems(data || {}) });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/debug/background"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/debug/background"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function () {
        return ok(runBackground("debug", async function () {
          await sleep(250);
          return { done: true };
        }));
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/debug/echo-get"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/debug/echo-get"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function (request) {
        return ok({
          itemID: request.searchParams.get("itemID"),
          style: request.searchParams.get("style"),
        });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/insert-get"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/insert-get"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function (request) {
        const citationItem = { id: request.searchParams.get("itemID") };
        const locator = request.searchParams.get("locator");
        const label = request.searchParams.get("label");
        const prefix = request.searchParams.get("prefix");
        const suffix = request.searchParams.get("suffix");
        if (locator) citationItem.locator = locator;
        if (label) citationItem.label = label;
        if (prefix) citationItem.prefix = prefix;
        if (suffix) citationItem.suffix = suffix;
        const citationItems = await parseCitationItems({ citationItems: [citationItem] });
        return ok(runBackground("insert", () => runInsertAutomation(
          citationItems,
          request.searchParams.get("style") || DEFAULT_STYLE_ID
        )));
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/inject-current-get"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/inject-current-get"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function (request) {
        const citationItem = { id: request.searchParams.get("itemID") };
        const locator = request.searchParams.get("locator");
        const label = request.searchParams.get("label");
        const prefix = request.searchParams.get("prefix");
        const suffix = request.searchParams.get("suffix");
        if (locator) citationItem.locator = locator;
        if (label) citationItem.label = label;
        if (prefix) citationItem.prefix = prefix;
        if (suffix) citationItem.suffix = suffix;
        const citationItems = await parseCitationItems({ citationItems: [citationItem] });
        return ok(runBackground("inject-current", () => runInjectCurrentAutomation(
          citationItems,
          request.searchParams.get("style") || DEFAULT_STYLE_ID
        )));
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/debug/parse-get"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/debug/parse-get"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function (request) {
        const citationItems = await parseCitationItems({ citationItems: [{ id: request.searchParams.get("itemID") }] });
        return ok({ citationItems });
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/debug/background-get"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/debug/background-get"].prototype = {
      supportedMethods: ["GET"],
      init: wrapInit(async function () {
        return ok(runBackground("debug-get", async function () {
          await sleep(250);
          return { done: true };
        }));
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/insert"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/insert"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function ({ data }) {
        const payload = data || {};
        const citationItems = await parseCitationItems(payload);
        return ok(runBackground("insert", () => runInsertAutomation(
          citationItems,
          payload.style || payload.styleID || DEFAULT_STYLE_ID
        )));
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/style"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/style"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function ({ data }) {
        const payload = data || {};
        return ok(
          await runStyleAutomation(payload.style || payload.styleID || DEFAULT_STYLE_ID)
        );
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/refresh"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/refresh"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function () {
        return ok(await runRefreshAutomation());
      }),
    };

    Zotero.Server.Endpoints["/codex/zotero-word/bibliography"] = function () {};
    Zotero.Server.Endpoints["/codex/zotero-word/bibliography"].prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      init: wrapInit(async function ({ data }) {
        const payload = data || {};
        return ok(
          await runBibliographyAutomation(
            payload.style || payload.styleID || DEFAULT_STYLE_ID
          )
        );
      }),
    };
  }

  function unregisterEndpoints() {
    for (const path of ENDPOINTS) {
      delete Zotero.Server.Endpoints[path];
    }
  }

  async function onStartup() {
    unregisterEndpoints();
    Zotero.Server.init();
    registerEndpoints();
  }

  async function onShutdown() {
    unregisterEndpoints();
  }

  Zotero.CodexZoteroWordBridge = {
    hooks: {
      onStartup,
      onShutdown,
    },
  };
})();
