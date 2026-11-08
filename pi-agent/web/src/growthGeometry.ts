export interface MapPoint {goal_id: string; x: number | null; y: number | null}
export interface MapPosition {x: number; y: number; basis: string}
const hash = (s: string) => [...s].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/** 分类坐标是事实，避让只是显示位置；筛选时仍传完整集合，点不会随搜索跳位。 */
export function mapPositions(points: MapPoint[], previous = new Map<string, MapPosition>()): Map<string, MapPosition> {
  const positions = new Map<string, MapPosition>();
  const known = points.filter(p => p.x !== null && p.y !== null).sort((a, b) => a.goal_id.localeCompare(b.goal_id));
  for (const point of known) {
    const old = previous.get(point.goal_id), basis = `${point.x}:${point.y}`;
    if (old?.basis === basis) positions.set(point.goal_id, old);
  }
  for (const point of known) {
    if (positions.has(point.goal_id)) continue;
    const baseX = 320 + point.x! * 226, baseY = 210 - point.y! * 138;
    let x = baseX, y = baseY;
    for (let trial = 0; trial < 2500; trial++) {
      const angle = (hash(point.goal_id) % 360) * Math.PI / 180 + trial * 2.399963229728653;
      const radius = trial ? 10 * Math.sqrt(trial) : 0;
      x = Math.min(604, Math.max(36, baseX + Math.cos(angle) * radius));
      y = Math.min(380, Math.max(40, baseY + Math.sin(angle) * radius));
      if ([...positions.values()].every(p => Math.hypot(p.x - x, p.y - y) >= 23)) break;
    }
    positions.set(point.goal_id, {x, y, basis: `${point.x}:${point.y}`});
  }
  return positions;
}

export function radarVertex(index: number, score: number, radius = 102): [number, number] {
  const angle = (index * 60 - 90) * Math.PI / 180;
  const r = radius * Math.max(0, Math.min(5, score)) / 5;
  return [180 + Math.cos(angle) * r, 154 + Math.sin(angle) * r];
}
