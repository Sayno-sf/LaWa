import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const model = fileURLToPath(new URL("../../third_party/mediapipe/face_landmarker.task", import.meta.url));
const expected = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const source = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const download = process.argv.includes("--download");
if (!existsSync(model) && !download) process.exit(0);
let bytes;
if (existsSync(model)) bytes = readFileSync(model);
else {
  const response = await fetch(source, {signal: AbortSignal.timeout(60_000)});
  if (!response.ok) throw new Error(`MediaPipe model download failed (HTTP ${response.status})`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Face landmarker model identity changed");
if (!existsSync(model)) writeFileSync(model, bytes, {flag: "wx"});
const target = fileURLToPath(new URL("../web/public/assets/study-camera/", import.meta.url));
mkdirSync(target, { recursive: true });
cpSync(fileURLToPath(new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url)), target + "wasm", { recursive: true });
cpSync(model, target + "face_landmarker.task");
writeFileSync(target + "ready.txt", "lawa-study-camera-v1\n");
