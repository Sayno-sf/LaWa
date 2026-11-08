import "./learningIntro.css";
import { icon } from "./icons";

const WATCHED_KEY = "learn-anything:intro-watched:v1";
const captions = [
  "我想学会……",
  "把想学的，变成清晰的下一步。",
  "在对话中理解，在实践中前进。",
  "每一次尝试，都留下成长的足迹。",
  "把想学的，变成能做到的。",
];

// 复用页面现有书本标志；故事素材只是展示，不投影或写入真实学习记录。
const book = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 11c-4.5-4.2-10.6-5.8-17-4v27c6.4-1.8 12.5-.2 17 4V11Z"/><path d="M24 11c4.5-4.2 10.6-5.8 17-4v27c-6.4-1.8-12.5-.2-17 4V11Z"/></svg>`;

/**
 * 启动本机开场，独立于 Session 恢复。仅保存观看偏好，不等待 API，也不发教学请求。
 * 存储被浏览器禁用时走短版；定时退出和跳过共用幂等清理，避免残留遮罩/键盘隔离。
 */
export function startLearningIntro(): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app || document.querySelector("#learning-intro")) return;

  let watched = true;
  try {
    watched = localStorage.getItem(WATCHED_KEY) === "true";
  } catch {
    // 不能持久记住观看状态时，每次只播放短版，不阻塞学习。
  }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mode = reducedMotion.matches ? "static" : watched ? "brand" : "story";
  const overlay = document.createElement("section");
  overlay.id = "learning-intro";
  overlay.className = "learning-intro";
  overlay.dataset.mode = mode;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "从想学，到做到 · 开场动画");
  overlay.tabIndex = -1;
  overlay.innerHTML = `
    <header class="intro-header">
      <div class="intro-series" aria-hidden="true"><span>Learn Anything</span><small>从想学，到做到</small></div>
      <button class="intro-skip" type="button" aria-label="跳过开场动画">跳过 ${icon("arrowRight")}</button>
    </header>
    <div class="intro-content">
      <div class="intro-stage" aria-hidden="true">
        <div class="intro-thought"><span>我想学会……</span><i class="intro-underline"></i></div>
        <div class="intro-notebook">
          <div class="intro-page intro-page-left">
            <span class="intro-page-icon">${book}</span>
            <strong>从一个问题开始</strong>
            <div class="intro-page-lines"><i></i><i></i><i></i></div>
            <span class="intro-margin-note">为什么？</span>
          </div>
          <div class="intro-page intro-page-right">
            <div class="intro-first-step"><span class="intro-rule"></span><strong>写下你的想法</strong></div>
            <div class="intro-practice"><span>${icon("edit")}</span><strong>用自己的话，试一试。</strong><div class="intro-written-lines"><i></i><i></i></div></div>
            <div class="intro-traces"><span>一次解释</span><span>一次实践</span><strong>新的理解</strong></div>
          </div>
        </div>
        <div class="intro-brand"><span class="intro-brand-mark">${book}</span><strong>Learn Anything</strong></div>
      </div>
      <p class="intro-caption" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="intro-chapters" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </div>`;

  const skip = overlay.querySelector<HTMLButtonElement>(".intro-skip")!;
  const caption = overlay.querySelector<HTMLElement>(".intro-caption")!;
  const chapters = [...overlay.querySelectorAll<HTMLElement>(".intro-chapters i")];
  const previousFocus = document.activeElement;
  const previousInert = app.inert;
  const timers = new Set<number>();
  let closing = false;

  const schedule = (callback: () => void, delay: number): void => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };
  const showScene = (index: number): void => {
    overlay.dataset.scene = String(index);
    caption.textContent = captions[index];
    if (index !== 0 && !reducedMotion.matches) {
      caption.animate([{ opacity: 0, transform: "translateY(7px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 450, easing: "ease-out" });
    }
    chapters.forEach((chapter, i) => chapter.classList.toggle("is-current", i === index));
  };
  const finish = (immediate = false): void => {
    if (closing) return;
    closing = true;
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();
    try {
      localStorage.setItem(WATCHED_KEY, "true");
    } catch {
      // 退出始终优先于保存偏好，失败不影响学习或原页面的错误提示。
    }
    document.removeEventListener("keydown", onKeyDown);
    reducedMotion.removeEventListener("change", onMotionChange);
    overlay.classList.add("is-exiting");
    const release = (): void => {
      overlay.remove();
      app.inert = previousInert;
      document.body.classList.remove("learning-intro-active");
      if (previousFocus instanceof HTMLElement && previousFocus !== document.body && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
    // 用定时清理而非依赖 animationend，关闭动画/切后台时也可释放界面。
    if (immediate || reducedMotion.matches) release();
    else window.setTimeout(release, 300);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    } else if (event.key === "Tab") {
      event.preventDefault();
      (mode === "story" ? skip : overlay).focus({ preventScroll: true });
    }
  };
  const onMotionChange = (): void => {
    if (reducedMotion.matches) finish(true);
  };

  skip.hidden = mode !== "story";
  showScene(mode === "story" ? 0 : 4);
  document.body.append(overlay);
  app.inert = true;
  document.body.classList.add("learning-intro-active");
  document.documentElement.classList.remove("intro-pending");
  overlay.focus({ preventScroll: true });
  skip.addEventListener("click", () => finish());
  document.addEventListener("keydown", onKeyDown);
  reducedMotion.addEventListener("change", onMotionChange);

  if (mode === "story") {
    [1400, 3000, 4600, 6400].forEach((delay, i) => schedule(() => showScene(i + 1), delay));
    schedule(() => finish(), 7700);
  } else {
    schedule(() => finish(mode === "static"), mode === "static" ? 400 : 700);
  }
}
