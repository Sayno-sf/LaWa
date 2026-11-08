import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelSourceBackend } from "../retrieval/backend.js";
import { RetrievalRuntime } from "../retrieval/runtime.js";
import { RetrievalSettingsStore } from "../retrieval/settings.js";
import { createGateway } from "./gateway.js";
import { WebSessionStore } from "./sessionStore.js";
import { stopSmokeProcess } from "../smokeProcess.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "lawa-large-materials-"));
const python = join(root, ".venv", "Scripts", "python.exe");
const report: Record<string, any> = { at: new Date().toISOString(), fixture: "actual image-heavy PDF/PPTX with independently known text markers",
  files: [], boundaries: [] };
let api: ChildProcess | undefined;
let runtime: RetrievalRuntime | undefined;
let gateway: ReturnType<typeof createGateway> | undefined;
const originalBase = process.env.LEARNING_API_BASE_URL;
async function run(args: string[]) {
  const child = spawn(python, args, { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr?.on("data", bytes => { error += String(bytes); });
  const [code] = await once(child, "exit"); if (code) throw new Error(error);
}
try {
  await run(["-m", "scripts.large_rag_fixtures", temporary]);
  const expected = JSON.parse(await readFile(join(temporary, "large-fixtures.json"), "utf8"));
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation,"listening");
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  const port = address.port; reservation.close(); await once(reservation,"close");
  const apiUrl = "http://127.0.0.1:" + port;
  api = spawn(python, ["-m", "uvicorn", "app.api.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
      LEARNING_STATE_PATH: join(temporary,"state.json"), LEARNING_BOOTSTRAP: "gradient-demo",
      LEARNING_MATERIALS_DIR: join(temporary,"materials") },
  });
  let errors = ""; api.stderr?.on("data", bytes => { errors += String(bytes); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (api.exitCode !== null) throw new Error(errors);
    try { if ((await fetch(apiUrl + "/api/learning/overview",{signal:AbortSignal.timeout(3000)})).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(ready);
  process.env.LEARNING_API_BASE_URL = apiUrl;
  const settings = new RetrievalSettingsStore(join(temporary,"retrieval","settings.json"), join(temporary,"providers.json"),join(temporary,"secrets.json"));
  await writeFile(join(temporary,"providers.json"),JSON.stringify({profiles:[]}));
  await settings.get(); // disabled: this smoke verifies local parser/streaming, not semantic cloud quality
  runtime = new RetrievalRuntime(join(temporary,"retrieval"),new KernelSourceBackend(apiUrl),settings);
  await runtime.start();
  const store = new WebSessionStore({apiBaseUrl:apiUrl,conversationDir:join(temporary,"sessions"),
    createAgent:async()=>({prompt:async()=>undefined,abort:async()=>undefined,dispose:()=>undefined})});
  gateway = createGateway({store,retrieval:runtime});
  gateway.listen(0,"127.0.0.1"); await once(gateway,"listening");
  const webAddress = gateway.address(); assert.ok(webAddress && typeof webAddress === "object");
  const webUrl = "http://127.0.0.1:" + webAddress.port;
  const session = await store.create("new");
  const uploadUrl = (filename: string) => webUrl + "/api/web/materials?" + new URLSearchParams({
    filename,sessionId:session.sessionId,goalId:session.state.active_goal_id!});
  const ledgerBefore = await readFile(join(temporary,"state.json"),"utf8").catch(()=>"");
  async function waitParsed(id: string) {
    for (let attempt=0;attempt<300;attempt++) {
      const result = await (await fetch(apiUrl+"/api/learning/materials")).json() as any;
      const material = result.materials.find((row:any)=>row.id===id);
      if (material && ["ready","failed"].includes(material.parse_status)) return material;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error("Parser did not finish");
  }
  for (const format of ["pdf","pptx"]) {
    const started = performance.now();
    const upload = await fetch(uploadUrl("large."+format),{method:"POST",body:createReadStream(join(temporary,"large."+format)) as unknown as BodyInit,
      duplex:"half",signal:AbortSignal.timeout(180_000)} as RequestInit&{duplex:"half"});
    assert.equal(upload.status,201,await upload.clone().text());
    const material = await upload.json() as {id:string};
    const uploadMs = Math.round(performance.now()-started);
    const parsed = await waitParsed(material.id);
    assert.equal(parsed.parse_status,"ready");
    assert.equal(parsed.unit_count,expected[format].units);
    for (let unit=1;unit<=expected[format].units;unit++) {
      const read = await (await fetch(apiUrl+"/api/learning/materials/"+material.id+"?max_chars=8000&start="+unit+"&end="+unit)).json() as any;
      assert.ok(read.text.includes(expected[format].markers[unit-1]),"each independently known marker extracted");
      assert.equal(read.locator.kind,format==="pdf"?"page":"slide");
      assert.equal(read.locator.start,unit);
      assert.equal(read.locator.end,unit);
    }
    assert.ok(parsed.warnings.length>0,"image/layout coverage is explicit");
    report.files.push({format,bytes:expected[format].bytes,units:parsed.unit_count,upload_ms:uploadMs,
      total_parse_ms:Math.round(performance.now()-started),warnings:parsed.warnings,markers_verified:true});
    console.log(JSON.stringify(report.files.at(-1)));
  }
  async function* streamBytes(count: number) {
    const block = new Uint8Array(64*1024).fill(65);
    for (let remaining=count;remaining>0;remaining-=block.length) yield remaining>=block.length?block:block.subarray(0,remaining);
  }
  for (const bytes of [100*1024*1024,100*1024*1024+1]) {
    const response = await fetch(uploadUrl("boundary.txt"),{method:"POST",body:streamBytes(bytes) as unknown as BodyInit,
      duplex:"half",signal:AbortSignal.timeout(180_000)} as RequestInit&{duplex:"half"});
    assert.equal(response.status,bytes===100*1024*1024?201:413);
    if (response.status===201) {
      const item = await response.json() as {id:string};
      const parsed = await waitParsed(item.id);
      assert.equal(parsed.parse_status,"failed","text extraction cap is explicit; original upload still accepted");
      assert.equal(parsed.size_bytes,bytes);
      report.boundaries.push({bytes,status:201,parse_status:parsed.parse_status,parse_error:parsed.parse_error.code,original_retained:true});
    } else report.boundaries.push({bytes,status:response.status});
  }
  assert.equal(await readFile(join(temporary,"state.json"),"utf8").catch(()=>""),ledgerBefore);
  report.ledger_unchanged=true; report.status="passed";
} catch(error) {
  report.status="failed";report.error=error instanceof Error?error.message:"Large-file failure";process.exitCode=1;
} finally {
  console.log(JSON.stringify(report));
  await writeFile(join(root,"docs","evals","hybrid-rag-large-files.json"),JSON.stringify(report,null,2));
  if(gateway){gateway.close();await once(gateway,"close");}
  await runtime?.stop();
  await stopSmokeProcess(api);
  if(originalBase===undefined)delete process.env.LEARNING_API_BASE_URL;else process.env.LEARNING_API_BASE_URL=originalBase;
  if(!resolve(temporary).startsWith(resolve(tmpdir())+sep)||!temporary.includes("lawa-large-materials-"))throw new Error("Unsafe cleanup target");
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
