import type {ImageContent} from "@earendil-works/pi-ai";
import {MAX_TEACHING_IMAGES, MAX_TEACHING_IMAGE_BYTES} from "./teachingImages.js";

export interface VisualSource {
  material_id: string; scope: string; source_hash: string; purpose_revision: number; parser_version: string; name: string;
}
export interface VisualPacket extends VisualSource {
  asset_id: string; unit: number; label: string; citation: string; mime: "image/jpeg"; data: string;
}
export interface VisualManifest extends VisualSource {
  unit_kind: string; unit_count: number; assets: Array<{id: string; unit: number; label: string; kind: string}>;
  total: number; next_offset: number | null; warnings: string[];
}
export const visualAssetId = /^[a-zA-Z0-9-]{1,100}$/;

export function parseVisualIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TEACHING_IMAGES || new Set(value).size !== value.length
      || value.some(id => typeof id !== "string" || !visualAssetId.test(id))) throw new Error("每批请选择1至3个实际原图定位。");
  return value;
}

export function visualSource(value: VisualSource, id: string, scope: string): VisualSource {
  if (!value || value.material_id !== id || value.scope !== scope || !/^[0-9a-f]{64}$/.test(value.source_hash)
      || !Number.isSafeInteger(value.purpose_revision) || value.purpose_revision < 0 || typeof value.parser_version !== "string"
      || !value.parser_version || value.parser_version.length > 128 || typeof value.name !== "string" || !value.name || value.name.length > 255)
    throw new Error("原图来源身份无效或已变化。");
  const {material_id, source_hash, purpose_revision, parser_version, name} = value;
  return {material_id, scope, source_hash, purpose_revision, parser_version, name};
}

async function visualRequest(path: string, id: string, scope: string, baseUrl: string, signal?: AbortSignal,
  fetcher: typeof fetch = fetch, maximum = 5 * 1024 * 1024): Promise<any> {
  if (!/^mat-[0-9a-f]{32}$/.test(id) || !scope) throw new Error("原图归属无效。");
  const query = new URLSearchParams(scope.startsWith("draft:") ? {draft_session_id: scope.slice(6)} : {expected_goal_id: scope});
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/api/learning/materials/${id}/${path}${separator}${query}`, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35_000)]), redirect: "error",
  });
  if (!response.ok || !response.body) throw new Error("原图或目录暂时不可用，请核对文件和实际图像定位。");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error("原图返回超过容量上限，请减少本批内容。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function loadVisualManifest(id: string, scope: string, offset: number, baseUrl: string,
  signal?: AbortSignal, fetcher?: typeof fetch): Promise<VisualManifest> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("原图目录分页无效。");
  const value = await visualRequest(`visuals?offset=${offset}&limit=20`, id, scope, baseUrl, signal, fetcher, 65536) as VisualManifest;
  const source = visualSource(value, id, scope);
  if (!Array.isArray(value.assets) || value.assets.length > 20 || !Number.isSafeInteger(value.total) || value.total < 0
      || !Number.isSafeInteger(value.unit_count) || value.unit_count < 0 || typeof value.unit_kind !== "string"
      || (value.next_offset !== null && (!Number.isSafeInteger(value.next_offset) || value.next_offset <= offset))
      || value.assets.some(a => !visualAssetId.test(a.id) || !Number.isSafeInteger(a.unit) || a.unit < 1
        || typeof a.label !== "string" || a.label.length > 255 || typeof a.kind !== "string")) throw new Error("原图目录定位无效。");
  return {...source, unit_kind: value.unit_kind, unit_count: value.unit_count, assets: value.assets.map(({id, unit, label, kind}) => ({id, unit, label, kind})),
    total: value.total, next_offset: value.next_offset, warnings: Array.isArray(value.warnings) ? value.warnings.filter(w => typeof w === "string").slice(0, 32) : []};
}

export async function loadVisualPacket(id: string, scope: string, assetId: string, baseUrl: string,
  signal?: AbortSignal, fetcher?: typeof fetch): Promise<VisualPacket> {
  if (!visualAssetId.test(assetId)) throw new Error("请选择目录中的实际原图定位。");
  const value = await visualRequest(`visual-packet/${assetId}`, id, scope, baseUrl, signal, fetcher) as VisualPacket;
  const source = visualSource(value, id, scope);
  if (value.asset_id !== assetId || value.mime !== "image/jpeg" || !Number.isSafeInteger(value.unit) || value.unit < 1
      || typeof value.label !== "string" || !value.label || value.label.length > 255 || typeof value.citation !== "string" || !value.citation || value.citation.length > 400)
    throw new Error("原图定位与请求不一致。");
  visualImage(value);
  return {...source, asset_id: assetId, unit: value.unit, label: value.label, citation: value.citation, mime: "image/jpeg", data: value.data};
}

export function visualImage(value: Pick<VisualPacket, "data" | "mime">): ImageContent {
  if (typeof value.data !== "string" || value.data.length > 4 * Math.ceil(MAX_TEACHING_IMAGE_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error("原图编码或大小无效。");
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length < 3 || bytes.length > MAX_TEACHING_IMAGE_BYTES || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.toString("base64") !== value.data || value.mime !== "image/jpeg")
    throw new Error("原图内容无效。");
  return {type: "image", data: value.data, mimeType: "image/jpeg"};
}
