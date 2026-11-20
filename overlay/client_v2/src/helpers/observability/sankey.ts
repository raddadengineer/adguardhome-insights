export const STAGES = ['group', 'status', 'upstream', 'rcode'] as const;

export type FlowStage = (typeof STAGES)[number];

export type FlowNode = {
    id: string;
    stage: string;
    name: string;
    label: string;
    count: number;
    dead_end: number;
};

export type FlowLink = {
    source: string;
    target: string;
    count: number;
    failure: boolean;
};

export type PlacedNode = FlowNode & {
    col: number;
    x: number;
    y: number;
    w: number;
    h: number;
};

export type PlacedLink = FlowLink & {
    width: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    d: string;
};

export type SankeyLayout = {
    nodes: PlacedNode[];
    links: PlacedLink[];
    scale: number;
    vertical: boolean;
    width: number;
    height: number;
};

/**
 * Folds nodes carrying less than `minShare` of `total` into one
 * `<stage>:other` node per stage, merging links and failure flags.
 */
export function foldFlow(
    nodes: FlowNode[],
    links: FlowLink[],
    total: number,
    minShare: number,
    stages: readonly string[] = STAGES,
): { nodes: FlowNode[]; links: FlowLink[]; folded: number } {
    if (minShare <= 0 || total <= 0) {
        return { nodes, links, folded: 0 };
    }

    const threshold = total * minShare;
    const remap = new Map<string, string>();
    for (const node of nodes) {
        if (node.count < threshold) {
            remap.set(node.id, `${node.stage}:other`);
        }
    }

    // Keeping a lone small node in a stage avoids merely renaming it to "other".
    for (const stage of stages) {
        const small = nodes.filter((n) => n.stage === stage && remap.has(n.id));
        if (small.length === 1) {
            remap.delete(small[0].id);
        }
    }

    if (remap.size === 0) {
        return { nodes, links, folded: 0 };
    }

    const mapId = (id: string) => remap.get(id) ?? id;
    const mergedNodes = new Map<string, FlowNode>();

    for (const node of nodes) {
        const id = mapId(node.id);
        const existing = mergedNodes.get(id);
        if (existing) {
            existing.count += node.count;
            existing.dead_end += node.dead_end;
        } else {
            const renamed = id !== node.id;
            mergedNodes.set(id, {
                ...node,
                id,
                name: renamed ? 'other' : node.name,
                label: renamed ? 'other' : node.label,
            });
        }
    }

    const mergedLinks = new Map<string, FlowLink>();
    for (const link of links) {
        const source = mapId(link.source);
        const target = mapId(link.target);
        const key = `${source}\u0000${target}`;
        const existing = mergedLinks.get(key);
        if (existing) {
            existing.count += link.count;
            existing.failure = existing.failure || link.failure;
        } else {
            mergedLinks.set(key, {
                source,
                target,
                count: link.count,
                failure: link.failure,
            });
        }
    }

    const stageIdx = (stage: string) => {
        const idx = stages.indexOf(stage);
        return idx < 0 ? stages.length : idx;
    };

    const sortNodes = (a: FlowNode, b: FlowNode) =>
        stageIdx(a.stage) - stageIdx(b.stage) ||
        Number(a.name === 'other') - Number(b.name === 'other') ||
        b.count - a.count;

    return {
        nodes: [...mergedNodes.values()].sort(sortNodes),
        links: [...mergedLinks.values()].sort((a, b) => b.count - a.count),
        folded: remap.size,
    };
}

/**
 * Packs node heights non-overlapping near `wants`, staying inside `[0, span]`.
 */
function settle(heights: number[], wants: number[], gap: number, span: number): number[] {
    const tops: number[] = [];
    let cursor = 0;

    for (let i = 0; i < heights.length; i += 1) {
        const y = Math.max(cursor, wants[i] ?? 0);
        tops.push(y);
        cursor = y + heights[i] + gap;
    }

    if (tops.length > 0) {
        const overflow = tops[tops.length - 1] + heights[heights.length - 1] - span;
        if (overflow > 0) {
            let push = overflow;
            for (let i = tops.length - 1; i >= 0 && push > 0; i -= 1) {
                const floor = i === 0 ? 0 : tops[i - 1] + heights[i - 1] + gap;
                const shift = Math.min(push, Math.max(0, tops[i] - floor));
                tops[i] -= shift;
                push -= shift;
            }
        }
    }

    return tops;
}

/**
 * Computes a 4-column Sankey layout where node heights and band widths share
 * one exact linear scale.
 */
export function layoutSankey(
    nodes: FlowNode[],
    links: FlowLink[],
    width: number,
    height: number,
    vertical = false,
    gap = 10,
    nodeW = 14,
    stages: readonly string[] = STAGES,
): SankeyLayout {
    const along = vertical ? height : width;
    const across = vertical ? width : height;
    const cols = stages.map((stage) => nodes.filter((n) => n.stage === stage));
    const colSum = (ns: FlowNode[]) => ns.reduce((acc, n) => acc + n.count, 0);
    const maxColSum = Math.max(1, ...cols.map(colSum));
    const maxCrowd = Math.max(1, ...cols.map((c) => c.length));
    const scale = Math.max(0, across - gap * (maxCrowd - 1)) / maxColSum;
    const step = stages.length > 1 ? (along - nodeW) / (stages.length - 1) : 0;

    const placed: PlacedNode[] = [];
    const centers = new Map<string, number>();

    cols.forEach((colNodes, ci) => {
        const wants = colNodes.map((node) => {
            let weight = 0;
            let sumCenter = 0;
            for (const link of links) {
                const srcCenter = link.target === node.id ? centers.get(link.source) : undefined;
                if (srcCenter !== undefined && link.count > 0) {
                    weight += link.count;
                    sumCenter += link.count * srcCenter;
                }
            }

            return weight > 0 ? sumCenter / weight - (node.count * scale) / 2 : 0;
        });

        const heights = colNodes.map((n) => n.count * scale);
        const tops = settle(heights, ci === 0 ? colNodes.map(() => 0) : wants, gap, across);

        colNodes.forEach((node, idx) => {
            const h = node.count * scale;
            const posAlong = ci * step;
            placed.push(
                vertical
                    ? { ...node, col: ci, x: tops[idx], y: posAlong, w: h, h: nodeW }
                    : { ...node, col: ci, x: posAlong, y: tops[idx], w: nodeW, h },
            );
            centers.set(node.id, tops[idx] + h / 2);
        });
    });

    const byId = new Map(placed.map((n) => [n.id, n]));
    const posAcross = (n: PlacedNode) => (vertical ? n.x : n.y);
    const outOffset = new Map<string, number>();
    const inOffset = new Map<string, number>();

    const active = links
        .filter((l) => byId.has(l.source) && byId.has(l.target) && l.count > 0)
        .map((l) => ({
            link: l,
            s: byId.get(l.source) as PlacedNode,
            t: byId.get(l.target) as PlacedNode,
        }));

    const byTargetOrder = [...active].sort(
        (a, b) => a.t.col - b.t.col || posAcross(a.t) - posAcross(b.t),
    );
    const placedLinks = new Map<FlowLink, PlacedLink>();

    for (const { link, s } of byTargetOrder) {
        const bandW = link.count * scale;
        const off = outOffset.get(s.id) ?? 0;
        outOffset.set(s.id, off + bandW);
        placedLinks.set(link, {
            ...link,
            width: bandW,
            x0: 0,
            y0: posAcross(s) + off + bandW / 2,
            x1: 0,
            y1: 0,
            d: '',
        });
    }

    // Reserve a clear lane below upstream nodes for status -> rcode bypass bands.
    const upstreamNodes = placed.filter((n) => n.col === 2);
    const upstreamMaxAcross =
        upstreamNodes.length > 0
            ? Math.max(...upstreamNodes.map((n) => (vertical ? n.x + n.w : n.y + n.h)))
            : 0;
    let bypassCursor = upstreamMaxAcross + gap;

    const bySourceOrder = [...active].sort(
        (a, b) => a.s.col - b.s.col || posAcross(a.s) - posAcross(b.s),
    );

    for (const { link, s, t } of bySourceOrder) {
        const p = placedLinks.get(link) as PlacedLink;
        const off = inOffset.get(t.id) ?? 0;
        inOffset.set(t.id, off + p.width);

        const c0 = p.y0;
        const c1 = posAcross(t) + off + p.width / 2;
        const a0 = (vertical ? s.y : s.x) + nodeW;
        const a1 = vertical ? t.y : t.x;

        if (t.col - s.col > 1 && upstreamNodes.length > 0) {
            const passAcross = Math.min(across - p.width / 2, bypassCursor + p.width / 2);
            bypassCursor += p.width + 2;
            const passAlong = 2 * step + nodeW / 2;

            if (vertical) {
                const mid1 = (a0 + passAlong) / 2;
                const mid2 = (passAlong + a1) / 2;
                p.x0 = c0;
                p.y0 = a0;
                p.x1 = c1;
                p.y1 = a1;
                p.d = `M${c0},${a0}C${c0},${mid1} ${passAcross},${mid1} ${passAcross},${passAlong}C${passAcross},${mid2} ${c1},${mid2} ${c1},${a1}`;
            } else {
                const mid1 = (a0 + passAlong) / 2;
                const mid2 = (passAlong + a1) / 2;
                p.x0 = a0;
                p.y0 = c0;
                p.x1 = a1;
                p.y1 = c1;
                p.d = `M${a0},${c0}C${mid1},${c0} ${mid1},${passAcross} ${passAlong},${passAcross}C${mid2},${passAcross} ${mid2},${c1} ${a1},${c1}`;
            }
        } else {
            const mid = (a0 + a1) / 2;
            if (vertical) {
                p.x0 = c0;
                p.y0 = a0;
                p.x1 = c1;
                p.y1 = a1;
                p.d = `M${c0},${a0}C${c0},${mid} ${c1},${mid} ${c1},${a1}`;
            } else {
                p.x0 = a0;
                p.y0 = c0;
                p.x1 = a1;
                p.y1 = c1;
                p.d = `M${a0},${c0}C${mid},${c0} ${mid},${c1} ${a1},${c1}`;
            }
        }
    }

    return {
        nodes: placed,
        links: [...placedLinks.values()],
        scale,
        vertical,
        width,
        height,
    };
}

export function formatPercent(part: number, total: number): string {
    if (total <= 0 || part <= 0) {
        return '0%';
    }
    const pct = (part / total) * 100;
    if (pct >= 10) {
        return `${pct.toFixed(0)}%`;
    }
    if (pct >= 1) {
        return `${pct.toFixed(1)}%`;
    }
    return `${pct.toFixed(2)}%`;
}

export function formatCompactCount(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 10_000) {
        return `${(n / 1_000).toFixed(1)}k`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(2).replace(/\.?0+$/, '')}k`;
    }
    return String(n);
}
