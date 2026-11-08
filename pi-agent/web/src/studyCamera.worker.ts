import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { classifyStudyFace } from "./studyObservation";

let model: FaceLandmarker | null = null;
let closedSince: number | null = null;
self.onmessage = async (event: MessageEvent) => {
  if (event.data.type === "init") {
    try {
      const files = await FilesetResolver.forVisionTasks(event.data.wasmPath);
      model = await FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: event.data.modelPath, delegate: "CPU" },
        runningMode: "IMAGE", numFaces: 2, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6 });
      self.postMessage({ type: "ready" });
    } catch { self.postMessage({ type: "error", message: "摄像头检测模型未能加载，请刷新后重试。" }); }
    return;
  }
  if (event.data.type === "frame") {
    const frame = event.data.frame as ImageBitmap;
    try {
      if (!model) throw new Error("not ready");
      const result = model.detect(frame);
      const categories = result.faceBlendshapes[0]?.categories ?? [];
      const blink = Math.min(categories.find(c => c.categoryName === "eyeBlinkLeft")?.score ?? 0, categories.find(c => c.categoryName === "eyeBlinkRight")?.score ?? 0);
      if (blink > 0.85) closedSince ??= performance.now(); else closedSince = null;
      const sustainedBlink = closedSince !== null && performance.now() - closedSince >= 1500 ? blink : 0;
      self.postMessage({ type: "observation", observation: classifyStudyFace(result.faceLandmarks, sustainedBlink) });
    } catch { self.postMessage({ type: "observation", observation: "UNKNOWN" }); }
    finally { frame.close(); }
  }
};
