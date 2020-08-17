"use strict";

var LifeCycle = (() => {

  const AES = "AES-GCM",
    keyUsages = ["encrypt", "decrypt"];

  function toBase64(bytes) {
    return btoa(Array.from(bytes).map(b => String.fromCharCode(b)).join(''));
  }
  function fromBase64(string) {
    return Uint8Array.from((Array.from(atob(string)).map(c => c.charCodeAt(0))));
  }
  async function encrypt(clearText) {
    let key = await crypto.subtle.generateKey({
        name: AES,
        length: 256,
      },
      true,
      keyUsages,
    );
    let iv = crypto.getRandomValues(new Uint8Array(12));
    let encoded = new TextEncoder().encode(clearText);
    let cypherText = await crypto.subtle.encrypt({
      name: AES,
      iv
    }, key, encoded);
    return {cypherText, key: await crypto.subtle.exportKey("jwk", key), iv};
  }

  var SurvivalTab = {
    url: "about:blank",
    async createAndStore() {
      let allSeen = {};
      await Promise.all((await browser.tabs.query({})).map(
        async t => {
          let seen = await ns.collectSeen(t.id);
          if (seen) allSeen[t.id] = seen;
        }
      ));

      let {url} = SurvivalTab;
      let tabInfo = {
        url,
        active: false,
      };
      if (browser.windows) { // it may be missing on mobile
        // check if an incognito windows exist and open our "survival" tab there
        for (let w of await browser.windows.getAll()) {
          if (w.incognito) {
            tabInfo.windowId = w.id;
            break;
          }
        }
      }
      let tab;
      for (;!tab;) {
        try {
          tab = await browser.tabs.create(tabInfo);
        } catch (e) {
          error(e);
          if (tabInfo.windowId) {
          // we might not have incognito permissions, let's try using any window
            delete tabInfo.windowId;
          } else {
            return; // bailout
          }
        }
      }
      let tabId = tab.id;

      let {cypherText, key, iv} = await encrypt(JSON.stringify({
        policy: ns.policy.dry(true),
        allSeen,
        unrestrictedTabs: [...ns.unrestrictedTabs]
      }));

      await new Promise((resolve, reject) => {
        let l = async (tabId, changeInfo) => {
          debug("Survival tab updating", changeInfo);
          if (changeInfo.status !== "complete") return;
          try {
            await Messages.send("store", {url, data: toBase64(new Uint8Array(cypherText))}, {tabId, frameId: 0});
            resolve();
            debug("Survival tab updated");
            browser.tabs.onUpdated.removeListener(l);
          } catch (e) {
            if (!Messages.isMissingEndpoint(e)) {
              error(e, "Survival tab failed");
              reject(e);
            } // otherwise we keep waiting for further updates from the tab until content script is ready to answer
          };
        }
        browser.tabs.onUpdated.addListener(l, {tabId});
      });
      await Storage.set("local", { "updateInfo": {key, iv: toBase64(iv), tabId}});
      debug("Ready to reload...", await Storage.get("local", "updateInfo"));
    },

    async retrieveAndDestroy() {
      let {updateInfo} = await Storage.get("local", "updateInfo");
      if (!updateInfo) return;
      await Storage.remove("local", "updateInfo");
      let {key, iv, tabId} = updateInfo;
      key = await crypto.subtle.importKey("jwk", key, AES, true, keyUsages);
      iv = fromBase64(iv);
      let cypherText = fromBase64(await Messages.send("retrieve",
        {url: SurvivalTab.url},
        {tabId, frameId: 0}));
      let encoded = await crypto.subtle.decrypt({
          name: AES,
          iv
        }, key, cypherText
      );
      let {policy, allSeen, unrestrictedTabs} = JSON.parse(new TextDecoder().decode(encoded));
      if (!policy) {
        error("Ephemeral policy not found!");
        return;
      }
      ns.unrestrictedTabs = new Set(unrestrictedTabs);
      browser.tabs.remove(tabId);
      await ns.initializing;
      ns.policy = new Policy(policy);
      await Promise.all(
        Object.entries(allSeen).map(
          async ([tabId, seen]) => {
            try {
              debug("Restoring seen %o to tab %s", seen, tabId);
              await Messages.send("allSeen", {seen}, {tabId, frameId: 0});
            } catch (e) {
              error(e, "Cannot send previously seen data to tab", tabId);
            }
          }
        )
      )
    }
  };

  return {
    async onInstalled(details) {
      browser.runtime.onInstalled.removeListener(this.onInstalled);
      let {reason, previousVersion} = details;
      if (reason !== "update") return;

      try {
        await SurvivalTab.retrieveAndDestroy();
      } catch (e) {
        error(e);
      }

      await include("/lib/Ver.js");
      previousVersion = new Ver(previousVersion);
      let currentVersion = new Ver(browser.runtime.getManifest().version);
      let upgrading = Ver.is(previousVersion, "<=", currentVersion);
      if (!upgrading) return;

      // put here any version specific upgrade adjustment in stored data

      if (Ver.is(previousVersion, "<=", "11.0.10")) {
        log(`Upgrading from 11.0.10 or below (${previousVersion}): configure the "ping" capability.`);
        await ns.initializing;
        ns.policy.TRUSTED.capabilities.add("ping")
        await ns.savePolicy();
      }
    },

    async onUpdateAvailable(details) {
      await include("/lib/Ver.js");
      if (Ver.is(details.version, "<", browser.runtime.getManifest().version)) {
        // downgrade: temporary survival might not be supported, and we don't care
        return;
      }
      try {
        await SurvivalTab.createAndStore();
      } catch (e) {
        console.error(e);
      } finally {
       browser.runtime.reload(); // apply update
      }
    }
  };
})();