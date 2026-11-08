import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
// Windows venv Python 启动器会再建子进程；只停止启动器会遗留临时 API。
// 仅接收本次脚本创建的 ChildProcess，不按端口或宽泛名字结束其他用户服务。
export async function stopSmokeProcess(child?: ChildProcess) {
  if (!child || child.exitCode !== null || !child.pid) return;
  const exited = once(child, "exit");
  if (process.platform === "win32") {
    const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await once(kill, "exit");
  } else child.kill();
  await exited;
}
