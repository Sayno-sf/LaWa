# Browser face observation assets

Runtime: `@mediapipe/tasks-vision` 1.1.0, pinned npm package and upstream integrity in package-lock.json. Its Apache-2.0 license is retained in LICENSE.

LaWa setup fetches Google MediaPipe Face Landmarker float16 version 1 from
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

SHA256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.
Upstream task guide: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js

If the download fails or you installed an earlier version, run `npm --prefix pi-agent run camera:assets` and rebuild the web client. Setup checks the model hash and copies the model and package WASM assets to the same origin. Runtime inference processes camera images in the browser. The model estimates face landmarks.
