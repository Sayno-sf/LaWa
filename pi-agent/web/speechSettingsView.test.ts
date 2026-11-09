import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { SpeechSettingsView } from "./src/speechView.js";
import { DEFAULT_SPEECH_SETTINGS, type PublicSpeechSettings } from "../src/web/speechSettingsTypes.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function fixture(initial: PublicSpeechSettings) {
  const dom = new JSDOM(html);
  const { window } = dom;
  const writes: unknown[] = [];
  const replacements = { document: window.document, Option: window.Option, FormData: window.FormData,
    fetch: async (_url: string, options?: RequestInit) => {
      if (options?.method !== "PUT") return Response.json(initial);
      const body = JSON.parse(String(options.body));
      writes.push(body);
      return Response.json(body);
    },
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let notifySaved: (() => void) | undefined;
  const view = new SpeechSettingsView(() => notifySaved?.(), () => undefined);
  const form = window.document.querySelector<HTMLFormElement>("#speech-settings-form")!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const status = window.document.querySelector<HTMLElement>("#speech-settings-message")!;
  return { view, field, status, writes,
    change(name: string, value: string) {
      field(name).value = value;
      field(name).dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    async submit() {
      await new Promise<void>(resolve => {
        notifySaved = resolve;
        form.dispatchEvent(new window.Event("submit", { cancelable: true }));
      });
    },
    close() {
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("fresh speech form stays blank until save fills examples and derives the selected profile region", { timeout: 2000 }, async () => {
  const f = fixture({ ...DEFAULT_SPEECH_SETTINGS, saved: false });
  try {
    for (const name of ["region", "voice", "asrModel", "ttsModel"]) assert.equal(f.field(name).value, "");
    await f.view.load();
    for (const name of ["region", "voice", "asrModel", "ttsModel"]) assert.equal(f.field(name).value, "");
    assert.equal(f.view.configured, false);
    assert.equal(f.status.dataset.saveState, "initial");
    f.change("voice", "Serena");
    assert.equal(f.status.dataset.saveState, "dirty");
    f.change("voice", "");
    assert.equal(f.status.textContent, "尚未保存语音设置");
    assert.equal(f.status.dataset.saveState, "initial");
    assert.deepEqual(f.writes, []);
    f.view.setProfiles([{ id: "intl", name: "国际百炼", provider: "bailian", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", hasApiKey: true }]);
    f.field("profileId").value = "intl";
    f.field("enabled").checked = true;
    await f.submit();
    assert.deepEqual(f.writes, [{ ...DEFAULT_SPEECH_SETTINGS, region: "singapore", profileId: "intl", enabled: true }]);
    assert.equal(f.field("region").value, "singapore");
    assert.equal(f.field("voice").value, DEFAULT_SPEECH_SETTINGS.voice);
    assert.equal(f.status.dataset.saveState, "saved");
    assert.equal(f.view.configured, true);
  } finally { f.close(); }
});

test("previously saved speech settings continue to display their original values", async () => {
  const previous = { ...DEFAULT_SPEECH_SETTINGS, region: "singapore" as const, voice: "Serena", ttsModel: "qwen3-tts-instruct-flash" };
  const f = fixture(previous);
  try {
    await f.view.load();
    assert.equal(f.field("voice").value, previous.voice);
    assert.equal(f.field("ttsModel").value, previous.ttsModel);
    assert.equal(f.field("region").value, previous.region);
    assert.equal(f.status.dataset.saveState, "saved");
    assert.deepEqual(f.writes, []);
  } finally { f.close(); }
});
