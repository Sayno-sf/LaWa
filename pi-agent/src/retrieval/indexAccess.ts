import {mkdir, open, readFile, readdir, rm, stat, lstat} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {resolve, join, basename} from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const leaseName = /^[0-9]+-[0-9a-f-]{36}\.read$/;
const unavailable = () => new Error("INDEX_MAINTENANCE_PENDING");

async function exists(path: string): Promise<boolean> {
  try {await stat(path); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e;}
}

async function expired(path: string): Promise<boolean> {
  try {
    const name = basename(path);
    // 读租约先建文件再写PID；文件名中的PID在正文不可读时仍可证明活进程。
    const pid = leaseName.test(name) ? Number(name.split("-")[0]) : Number(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return Date.now() - (await stat(path)).mtimeMs > 30_000;
    try {process.kill(pid, 0); return false;}
    catch (e) {if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; return false;}
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    // Windows 上活租约可能因独占/待写入暂时不可读。无法读取时必须保守视作仍在。
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") return false;
    throw e;
  }
}

/** 所有原生Lance操作都登记访问；重清理排除其他进程的读和写，不能只依赖索引writer.lock。 */
export class IndexAccess {
  private readonly directory: string;
  constructor(path: string, private readonly waitMs = 8000) {this.directory = resolve(path) + ".access";}
  private async prepare(): Promise<string> {
    await mkdir(this.directory, {recursive: true});
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error("INDEX_ACCESS_PATH_INVALID");
    return join(this.directory, "maintenance.lock");
  }
  private async available(lock: string): Promise<boolean> {
    return !await exists(lock);
  }
  async read<T>(work: () => Promise<T>): Promise<T> {
    const lock = await this.prepare();
    if (!await this.available(lock)) throw unavailable();
    const path = join(this.directory, `${process.pid}-${randomUUID()}.read`);
    const lease = await open(path, "wx");
    try {
      await lease.writeFile(String(process.pid));
      // 先登记再二次检查。清理者取得锁后等待读者退出，不能与此处检查交错后直接清文件。
      if (await exists(lock)) throw unavailable();
      return await work();
    } finally {await lease.close(); await rm(path, {force: true});}
  }
  async maintenance<T>(work: () => Promise<T>): Promise<T> {
    const lock = await this.prepare();
    // 仅目录writer.lock的唯一持有者可回收死亡清理者的锁；读者不能并发回收后误删新锁。
    if (await exists(lock)) {
      if (!await expired(lock)) throw unavailable();
      await rm(lock, {force: true});
    }
    let handle;
    try {handle = await open(lock, "wx");}
    catch (e) {if ((e as NodeJS.ErrnoException).code === "EEXIST") throw unavailable(); throw e;}
    try {
      await handle.writeFile(String(process.pid));
      const end = Date.now() + this.waitMs;
      for (;;) {
        let busy = false;
        for (const file of (await readdir(this.directory)).filter(f => leaseName.test(f))) {
          const path = join(this.directory, file);
          if (await expired(path)) await rm(path, {force: true}); else busy = true;
        }
        if (!busy) return await work();
        if (Date.now() >= end) throw unavailable();
        await delay(20);
      }
    } finally {await handle.close(); await rm(lock, {force: true});}
  }
}
