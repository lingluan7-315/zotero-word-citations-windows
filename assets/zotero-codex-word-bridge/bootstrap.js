var chromeHandle;

function install(data, reason) {}

async function startup({ rootURI }, reason) {
  await Zotero.initializationPromise;

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "codex-zotero-word-bridge", rootURI + "chrome/content/"],
  ]);

  const ctx = {
    rootURI,
  };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}chrome/content/scripts/bridge.js`,
    ctx
  );
  await Zotero.CodexZoteroWordBridge.hooks.onStartup();
}

function onMainWindowLoad() {}

function onMainWindowUnload() {}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.CodexZoteroWordBridge?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
