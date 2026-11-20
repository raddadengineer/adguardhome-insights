import type { BlockedService } from 'panel/api/model/blockedService';
import type { StatsTrafficMapItem } from 'panel/api/model/statsTrafficMapItem';

export type Rect = {
    x: number;
    y: number;
    w: number;
    h: number;
};

export type TrafficMapMode = 'service' | 'site' | 'name';
export type TrafficMapShow = 'all' | 'allowed' | 'blocked';
export type TrafficTileStatus = 'allowed' | 'blocked';

export type ServiceCatalogEntry = {
    id: string;
    name: string;
    iconSvg?: string;
};

export type TrafficTile = {
    id: string;
    status: TrafficTileStatus;
    label: string;
    service: boolean;
    count: number;
    delta: number;
    hot: boolean;
    members: { domain: string; count: number }[];
};

type AreaItem = {
    idx: number;
    area: number;
};

function worstAspectRatio(row: AreaItem[], side: number): number {
    let sum = 0;
    let minArea = Infinity;
    let maxArea = 0;

    for (const item of row) {
        sum += item.area;
        if (item.area < minArea) minArea = item.area;
        if (item.area > maxArea) maxArea = item.area;
    }

    const s2 = side * side;
    const sum2 = sum * sum;
    if (sum2 <= 0 || minArea <= 0 || s2 <= 0) {
        return Infinity;
    }

    return Math.max((s2 * maxArea) / sum2, sum2 / (s2 * minArea));
}

function placeRow(row: AreaItem[], box: Rect, out: Rect[]): Rect {
    const sum = row.reduce((acc, r) => acc + r.area, 0);
    if (box.w >= box.h) {
        const colW = box.h > 0 ? sum / box.h : 0;
        let y = box.y;
        for (const item of row) {
            const itemH = colW > 0 ? item.area / colW : 0;
            out[item.idx] = { x: box.x, y, w: colW, h: itemH };
            y += itemH;
        }
        return { x: box.x + colW, y: box.y, w: Math.max(0, box.w - colW), h: box.h };
    }

    const rowH = box.w > 0 ? sum / box.w : 0;
    let x = box.x;
    for (const item of row) {
        const itemW = rowH > 0 ? item.area / rowH : 0;
        out[item.idx] = { x, y: box.y, w: itemW, h: rowH };
        x += itemW;
    }
    return { x: box.x, y: box.y + rowH, w: box.w, h: Math.max(0, box.h - rowH) };
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
 * Returns rectangles in the same order as `weights`.
 */
export function squarify(weights: number[], width: number, height: number): Rect[] {
    const out: Rect[] = weights.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
    const total = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
    if (total <= 0 || width <= 0 || height <= 0) {
        return out;
    }

    const scale = (width * height) / total;
    const sorted: AreaItem[] = weights
        .map((w, idx) => ({ idx, area: Math.max(0, w) * scale }))
        .filter((item) => item.area > 0)
        .sort((a, b) => b.area - a.area);

    let box: Rect = { x: 0, y: 0, w: width, h: height };
    let row: AreaItem[] = [];

    for (const item of sorted) {
        const side = Math.min(box.w, box.h);
        if (row.length === 0 || worstAspectRatio([...row, item], side) <= worstAspectRatio(row, side)) {
            row.push(item);
        } else {
            box = placeRow(row, box, out);
            row = [item];
        }
    }

    if (row.length > 0) {
        placeRow(row, box, out);
    }

    return out;
}

const SECOND_LEVEL_CC = new Set([
    'co',
    'com',
    'net',
    'org',
    'gov',
    'edu',
    'ac',
    'ne',
    'or',
    'go',
    'gob',
    'mil',
]);

/**
 * Extracts a best-effort registrable site (eTLD+1) from a domain name.
 */
export function extractSite(domain: string): string {
    const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    if (parts.length <= 2) {
        return parts.join('.');
    }
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    const depth = tld.length === 2 && SECOND_LEVEL_CC.has(sld) && parts.length >= 3 ? 3 : 2;
    return parts.slice(-depth).join('.');
}

/**
 * Builds a domain -> service map from AdGuard Home's blocked-services catalog.
 */
export function extractServiceMap(services: BlockedService[]): Map<string, ServiceCatalogEntry> {
    const map = new Map<string, ServiceCatalogEntry>();

    for (const svc of services) {
        const entry: ServiceCatalogEntry = {
            id: svc.id,
            name: svc.name || svc.id,
            iconSvg: svc.icon_svg,
        };

        for (const rawRule of svc.rules ?? []) {
            const rule = rawRule.trim().toLowerCase();
            if (!rule || rule.startsWith('!')) {
                continue;
            }
            const match = /^\|{0,2}([a-z0-9*.-]+)\^?$/.exec(rule);
            if (!match) {
                continue;
            }
            const host = match[1].replace(/^\*\./, '').replace(/\.$/, '');
            if (host && !host.includes('*') && !map.has(host)) {
                map.set(host, entry);
            }
        }
    }

    return map;
}

export function lookupService(
    domain: string,
    serviceMap: Map<string, ServiceCatalogEntry>,
): ServiceCatalogEntry | undefined {
    const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
        const candidate = parts.slice(i).join('.');
        const found = serviceMap.get(candidate);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * Aggregates allowed/blocked domain counts into treemap tiles with live deltas
 * and top-N growing-now markers.
 */
export function buildTrafficTiles(
    allowed: StatsTrafficMapItem[],
    blocked: StatsTrafficMapItem[],
    mode: TrafficMapMode,
    show: TrafficMapShow,
    serviceMap: Map<string, ServiceCatalogEntry>,
    prevCounts: Map<string, number>,
    hotLimit = 5,
): TrafficTile[] {
    const grouped = new Map<string, TrafficTile>();

    const ingest = (status: TrafficTileStatus, items: StatsTrafficMapItem[]) => {
        for (const item of items) {
            if (!item.domain || item.count <= 0) {
                continue;
            }

            let label = item.domain;
            let isService = false;

            if (mode === 'service') {
                const svc = lookupService(item.domain, serviceMap);
                if (svc) {
                    label = svc.name;
                    isService = true;
                } else {
                    label = extractSite(item.domain);
                }
            } else if (mode === 'site') {
                label = extractSite(item.domain);
            }

            const tileId = `${status}:${isService ? 'svc' : 'dom'}:${label}`;
            const prevKey = `${status}:${item.domain}`;
            const prev = prevCounts.get(prevKey);
            const delta = prev !== undefined && item.count > prev ? item.count - prev : 0;

            const existing = grouped.get(tileId);
            if (existing) {
                existing.count += item.count;
                existing.delta += delta;
                existing.members.push({ domain: item.domain, count: item.count });
            } else {
                grouped.set(tileId, {
                    id: tileId,
                    status,
                    label,
                    service: isService,
                    count: item.count,
                    delta,
                    hot: false,
                    members: [{ domain: item.domain, count: item.count }],
                });
            }
        }
    };

    if (show === 'all' || show === 'allowed') {
        ingest('allowed', allowed);
    }
    if (show === 'all' || show === 'blocked') {
        ingest('blocked', blocked);
    }

    const tiles = [...grouped.values()];
    for (const tile of tiles) {
        tile.members.sort((a, b) => b.count - a.count);
    }

    tiles.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const growing = tiles
        .filter((t) => t.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, hotLimit);

    for (const tile of growing) {
        tile.hot = true;
    }

    return tiles;
}
