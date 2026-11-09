import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {JSDOM} from "jsdom";
import {mountRetrievalViews} from "./src/retrievalView.js";

test("fresh retrieval form keeps a saved teacher profile available without selecting or filling anything", async t => {
  const dom = new JSDOM(await readFile(new URL("./index.html", import.meta.url), "utf8"));
  const previous = {document: globalThis.document, fetch: globalThis.fetch};
  t.after(() => {Object.assign(globalThis, previous); dom.window.close();});
  globalThis.document = dom.window.document;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/web/retrieval-settings");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({
      version: 1, enabled: false, profileId: "", embeddingModel: "", dimensions: 1024, embeddingUrl: "",
      rerankModel: "", rerankUrl: "", minimumRerankScore: .5, visionEnabled: false, graphEnabled: false,
      visionModel: "", extractionModel: "", profiles: [{id: "teacher", provider: "aliyun-bailian", model: "chat"}],
    });
  };
  mountRetrievalViews();
  const panel = dom.window.document.querySelector<HTMLDetailsElement>("#retrieval-settings")!;
  panel.open = true;
  panel.dispatchEvent(new dom.window.Event("toggle"));
  await new Promise(resolve => setImmediate(resolve));
  const form = panel.querySelector<HTMLFormElement>("form")!;
  const profiles = form.elements.namedItem("profileId") as HTMLSelectElement;
  assert.deepEqual(Array.from(profiles.options, option => option.value), ["", "teacher"]);
  assert.equal(profiles.value, "");
  for (const name of ["embeddingModel", "embeddingUrl", "rerankModel", "rerankUrl"]) {
    const field = form.elements.namedItem(name) as HTMLInputElement;
    assert.equal(field.value, "");
    assert.equal(field.required, true);
    assert.equal(field.closest("details")?.open, true, "required settings are reachable on the first visit");
  }
  for (const name of ["enabled", "visionEnabled", "graphEnabled"]) {
    assert.equal((form.elements.namedItem(name) as HTMLInputElement).checked, false);
  }
  assert.match(panel.querySelector("#retrieval-settings-message")!.textContent ?? "", /未配置/);
});
