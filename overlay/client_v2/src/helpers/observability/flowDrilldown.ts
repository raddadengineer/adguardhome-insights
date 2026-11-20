import { RoutePath, linkPathBuilder } from 'panel/components/Routes/Paths';
import type { StatsFlowGroupBy } from 'panel/api/model/statsFlowGroupBy';
import type { StatsFlowDetailsDomain } from 'panel/api/model/statsFlowDetailsDomain';
import type { StatsFlowDetailsTuple } from 'panel/api/model/statsFlowDetailsTuple';
import type { FlowNode } from './sankey';
import {
    extractSite,
    lookupService,
    type ServiceCatalogEntry,
} from './treemap';

export type FlowFilter = {
    client?: string;
    tag?: string;
    protocol?: string;
    status?: string;
    upstream?: string;
    rcode?: string;
    domain?: string;
    category?: string;
    service?: string;
    filter_list?: string;
    reason?: string;
    rule?: string;
    qtype?: string;
};

export type FlowDrillStep = {
    key: keyof FlowFilter;
    value: string;
};

export type FlowServiceBreakdown = {
    id: string;
    label: string;
    service: boolean;
    count: number;
    blocked: number;
    clients: number;
    members: StatsFlowDetailsDomain[];
};

export type TreePivot = 'device' | 'service' | 'rule';
export type FlowTreeNodeKind = 'client' | 'service' | 'domain' | 'filter_list' | 'rule';

export type FlowTreeNode = {
    id: string;
    kind: FlowTreeNodeKind;
    filterKey: keyof FlowFilter;
    filterValue: string;
    label: string;
    subtitle?: string;
    count: number;
    blocked: number;
    serviceId?: string;
    domain?: string;
    rule?: string;
    filterList?: string;
    qtypes: string[];
    autoExpand?: boolean;
    children: FlowTreeNode[];
};

export const FILTER_KEYS: readonly (keyof FlowFilter)[] = [
    'client',
    'tag',
    'protocol',
    'status',
    'upstream',
    'rcode',
    'domain',
    'category',
    'service',
    'filter_list',
    'reason',
    'rule',
    'qtype',
];

const VALID_FILTER_KEY_SET = new Set<string>(FILTER_KEYS);

export function hasActiveFlowFilter(filter: FlowFilter): boolean {
    return FILTER_KEYS.some((key) => Boolean(filter[key]?.trim()));
}

/**
 * Parses an ordered breadcrumb trail string from URL params, synchronizing it
 * with the active filter keys so every crumb stays aligned with URL state.
 */
export function parseDrillTrail(
    rawTrail: string | undefined,
    filter: FlowFilter,
): FlowDrillStep[] {
    const steps: FlowDrillStep[] = [];
    const seen = new Set<keyof FlowFilter>();

    if (rawTrail) {
        for (const token of rawTrail.split(',')) {
            const idx = token.indexOf(':');
            if (idx <= 0) {
                continue;
            }
            const rawKey = token.slice(0, idx);
            if (!VALID_FILTER_KEY_SET.has(rawKey)) {
                continue;
            }
            const key = rawKey as keyof FlowFilter;
            if (seen.has(key)) {
                continue;
            }
            let decoded: string;
            try {
                decoded = decodeURIComponent(token.slice(idx + 1));
            } catch {
                decoded = token.slice(idx + 1);
            }
            if (filter[key] && filter[key] === decoded) {
                steps.push({ key, value: decoded });
                seen.add(key);
            }
        }
    }

    for (const key of FILTER_KEYS) {
        const val = filter[key]?.trim();
        if (val && !seen.has(key)) {
            steps.push({ key, value: val });
            seen.add(key);
        }
    }

    return steps;
}

export function serializeDrillTrail(steps: FlowDrillStep[]): string | undefined {
    if (steps.length === 0) {
        return undefined;
    }
    return steps.map((s) => `${s.key}:${encodeURIComponent(s.value)}`).join(',');
}

/**
 * Applies a partial filter update while preserving an ordered breadcrumb trail.
 */
export function applyDrillPatch(
    currentFilter: FlowFilter,
    currentTrail: FlowDrillStep[],
    patch: Partial<FlowFilter>,
    toggleIfExact = true,
): { filter: FlowFilter; trail: FlowDrillStep[] } {
    const entries = Object.entries(patch).filter(
        ([, val]) => val !== undefined && val !== '',
    ) as [keyof FlowFilter, string][];

    if (entries.length === 0) {
        return { filter: currentFilter, trail: currentTrail };
    }

    const allExact =
        toggleIfExact && entries.every(([k, v]) => currentFilter[k] === v);

    const nextFilter: FlowFilter = { ...currentFilter };
    let nextTrail = [...currentTrail];

    if (allExact) {
        const removeKeys = new Set(entries.map(([k]) => k));
        for (const k of removeKeys) {
            nextFilter[k] = undefined;
        }
        nextTrail = nextTrail.filter((step) => !removeKeys.has(step.key));
        return { filter: nextFilter, trail: nextTrail };
    }

    for (const [k, v] of entries) {
        nextFilter[k] = v;
        const existingIdx = nextTrail.findIndex((s) => s.key === k);
        if (existingIdx >= 0 && nextTrail[existingIdx].value === v) {
            continue;
        }
        nextTrail = nextTrail.filter((s) => s.key !== k);
        nextTrail.push({ key: k, value: v });
    }

    return { filter: nextFilter, trail: nextTrail };
}

export function popTrailToIndex(
    currentTrail: FlowDrillStep[],
    targetIdx: number,
): { filter: FlowFilter; trail: FlowDrillStep[] } {
    if (targetIdx < 0) {
        return { filter: {}, trail: [] };
    }
    const nextTrail = currentTrail.slice(0, targetIdx + 1);
    const nextFilter: FlowFilter = {};
    for (const step of nextTrail) {
        nextFilter[step.key] = step.value;
    }
    return { filter: nextFilter, trail: nextTrail };
}

export function stepBackTrail(
    currentTrail: FlowDrillStep[],
): { filter: FlowFilter; trail: FlowDrillStep[] } {
    return popTrailToIndex(currentTrail, currentTrail.length - 2);
}

export function removeFilterKey(
    currentFilter: FlowFilter,
    currentTrail: FlowDrillStep[],
    key: keyof FlowFilter,
): { filter: FlowFilter; trail: FlowDrillStep[] } {
    return {
        filter: { ...currentFilter, [key]: undefined },
        trail: currentTrail.filter((s) => s.key !== key),
    };
}

/**
 * Translates a clicked Sankey node into a query filter patch, returning null
 * for folded "other" buckets or sentinel placeholders without backend values.
 */
export function nodeFilterPatch(
    node: Pick<FlowNode, 'stage' | 'name'>,
    groupBy: StatsFlowGroupBy,
): Partial<FlowFilter> | null {
    if (node.name === 'other') {
        return null;
    }

    switch (node.stage) {
        case 'group':
            if (groupBy === 'client') {
                return { client: node.name };
            }
            if (groupBy === 'tag') {
                return { tag: node.name };
            }
            return { protocol: node.name };
        case 'client':
            return node.name === 'unknown' ? null : { client: node.name };
        case 'status':
            return { status: node.name };
        case 'reason':
            return node.name === 'none' ? null : { reason: node.name };
        case 'filter_list':
            return { filter_list: node.name };
        case 'rule':
            return node.name === 'none' ? null : { rule: node.name };
        case 'category':
            return { category: node.name };
        case 'service':
            return node.name === 'unknown' ? null : { service: node.name };
        case 'domain':
            return node.name === 'unknown' ? null : { domain: node.name };
        case 'qtype':
            return { qtype: node.name };
        case 'upstream':
            return node.name === 'direct' ? null : { upstream: node.name };
        case 'rcode':
            return node.name === 'NONE' ? null : { rcode: node.name };
        default:
            return null;
    }
}

export function isNodeSelected(
    filter: FlowFilter,
    node: Pick<FlowNode, 'stage' | 'name'>,
    groupBy: StatsFlowGroupBy,
): boolean {
    const patch = nodeFilterPatch(node, groupBy);
    if (!patch) {
        return false;
    }
    return Object.entries(patch).every(
        ([k, v]) => v !== undefined && filter[k as keyof FlowFilter] === v,
    );
}

export function toggleNodeFilter(
    current: FlowFilter,
    node: Pick<FlowNode, 'stage' | 'name'>,
    groupBy: StatsFlowGroupBy,
): FlowFilter {
    const patch = nodeFilterPatch(node, groupBy);
    if (!patch) {
        return current;
    }

    const next: FlowFilter = { ...current };
    for (const [key, val] of Object.entries(patch) as [keyof FlowFilter, string | undefined][]) {
        if (!val) {
            continue;
        }
        next[key] = next[key] === val ? undefined : val;
    }
    return next;
}

export function isLinkSelected(
    filter: FlowFilter,
    source: Pick<FlowNode, 'stage' | 'name'>,
    target: Pick<FlowNode, 'stage' | 'name'>,
    groupBy: StatsFlowGroupBy,
): boolean {
    const combined: Partial<FlowFilter> = {
        ...(nodeFilterPatch(source, groupBy) ?? {}),
        ...(nodeFilterPatch(target, groupBy) ?? {}),
    };
    const entries = Object.entries(combined) as [keyof FlowFilter, string | undefined][];
    if (entries.length === 0) {
        return false;
    }
    return entries.every(([k, v]) => v !== undefined && filter[k] === v);
}

export function applyLinkFilter(
    current: FlowFilter,
    source: Pick<FlowNode, 'stage' | 'name'>,
    target: Pick<FlowNode, 'stage' | 'name'>,
    groupBy: StatsFlowGroupBy,
): FlowFilter {
    const combined: Partial<FlowFilter> = {
        ...(nodeFilterPatch(source, groupBy) ?? {}),
        ...(nodeFilterPatch(target, groupBy) ?? {}),
    };
    const entries = Object.entries(combined) as [keyof FlowFilter, string | undefined][];
    if (entries.length === 0) {
        return current;
    }

    const allAlreadySet = entries.every(([k, v]) => v !== undefined && current[k] === v);
    const next: FlowFilter = { ...current };

    for (const [key, val] of entries) {
        next[key] = allAlreadySet ? undefined : val;
    }

    return next;
}

/**
 * Aggregates drill-down domain rows into AdGuard services (with eTLD+1 fallback)
 * so blocked/allowed traffic can be inspected by service as well as domain.
 */
export function buildFlowServices(
    domains: StatsFlowDetailsDomain[],
    serviceMap: Map<string, ServiceCatalogEntry>,
    serviceById: Map<string, ServiceCatalogEntry>,
): FlowServiceBreakdown[] {
    const grouped = new Map<string, FlowServiceBreakdown>();

    for (const dom of domains) {
        if (!dom.domain || dom.count <= 0) {
            continue;
        }

        let label = '';
        let id = '';
        let isService = false;

        if (dom.service && !dom.service.startsWith('site:')) {
            const byId = serviceById.get(dom.service.toLowerCase());
            label = byId?.name || dom.service_name || dom.service;
            id = dom.service;
            isService = true;
        } else {
            const matched = lookupService(dom.domain, serviceMap);
            if (matched) {
                label = matched.name;
                id = matched.id;
                isService = true;
            } else {
                label = extractSite(dom.domain);
                id = dom.service || `site:${label}`;
            }
        }

        const groupKey = `${isService ? 'svc' : 'site'}:${label}`;
        const existing = grouped.get(groupKey);
        if (existing) {
            existing.count += dom.count;
            existing.blocked += dom.blocked;
            existing.clients = Math.max(existing.clients, dom.clients);
            existing.members.push(dom);
        } else {
            grouped.set(groupKey, {
                id,
                label,
                service: isService,
                count: dom.count,
                blocked: dom.blocked,
                clients: dom.clients,
                members: [dom],
            });
        }
    }

    const list = [...grouped.values()];
    for (const item of list) {
        item.members.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
    }

    return list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

type MutableTreeNode = FlowTreeNode & {
    qtypeCounts: Map<string, number>;
    childMap: Map<string, MutableTreeNode>;
};

type TreeLevelSpec = {
    id: string;
    kind: FlowTreeNodeKind;
    filterKey: keyof FlowFilter;
    filterValue: string;
    label: string;
    subtitle?: string;
    serviceId?: string;
    domain?: string;
    rule?: string;
    filterList?: string;
};

function levelsForTuple(tuple: StatsFlowDetailsTuple, pivot: TreePivot): TreeLevelSpec[] {
    const clientSpec: TreeLevelSpec = {
        id: `client:${tuple.client_id}`,
        kind: 'client',
        filterKey: 'client',
        filterValue: tuple.client_id,
        label: tuple.client_label || tuple.client_id,
        subtitle:
            tuple.client_label && tuple.client_label !== tuple.client_id
                ? tuple.client_id
                : tuple.tag,
    };

    const serviceSpec: TreeLevelSpec = {
        id: `service:${tuple.service_id}`,
        kind: 'service',
        filterKey: 'service',
        filterValue: tuple.service_id,
        label: tuple.service_name || tuple.service_id,
        subtitle: tuple.category && tuple.category !== 'other' ? tuple.category : undefined,
        serviceId: tuple.service_id,
    };

    const domVal = tuple.domain || 'unknown';
    const domainSpec: TreeLevelSpec = {
        id: `domain:${domVal}`,
        kind: 'domain',
        filterKey: 'domain',
        filterValue: domVal,
        label: domVal,
        subtitle:
            tuple.filter_list && tuple.filter_list !== 'None' ? tuple.filter_list : undefined,
        serviceId: tuple.service_id,
        domain: domVal,
        rule: tuple.rule,
        filterList: tuple.filter_list,
    };

    const flName = tuple.filter_list || 'None';
    const filterListSpec: TreeLevelSpec = {
        id: `filter_list:${flName}`,
        kind: 'filter_list',
        filterKey: 'filter_list',
        filterValue: flName,
        label: flName,
        filterList: flName,
    };

    const effectiveRule = tuple.rule || tuple.reason || tuple.status;
    const ruleFilterKey: keyof FlowFilter = tuple.rule
        ? 'rule'
        : tuple.reason
          ? 'reason'
          : 'status';
    const ruleFilterVal = tuple.rule || tuple.reason || tuple.status;
    const ruleSpec: TreeLevelSpec = {
        id: `rule:${ruleFilterKey}:${ruleFilterVal}:${flName}`,
        kind: 'rule',
        filterKey: ruleFilterKey,
        filterValue: ruleFilterVal,
        label: effectiveRule,
        subtitle: flName !== 'None' ? flName : tuple.status,
        rule: tuple.rule,
        filterList: flName,
    };

    switch (pivot) {
        case 'service':
            return [serviceSpec, domainSpec, clientSpec, ruleSpec];
        case 'rule':
            return [filterListSpec, ruleSpec, serviceSpec, domainSpec];
        default:
            return [clientSpec, serviceSpec, domainSpec, ruleSpec];
    }
}

function finalizeTreeNodes(nodes: Iterable<MutableTreeNode>, search: string): FlowTreeNode[] {
    const q = search.trim().toLowerCase();
    const out: FlowTreeNode[] = [];

    for (const node of nodes) {
        const qtypes = [...node.qtypeCounts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([qt]) => qt);

        const finalizedChildren = finalizeTreeNodes(node.childMap.values(), q);

        const selfMatches =
            !q ||
            node.label.toLowerCase().includes(q) ||
            (node.subtitle ?? '').toLowerCase().includes(q) ||
            node.filterValue.toLowerCase().includes(q) ||
            (node.rule ?? '').toLowerCase().includes(q) ||
            (node.filterList ?? '').toLowerCase().includes(q) ||
            qtypes.some((qt) => qt.toLowerCase().includes(q));

        if (!selfMatches && finalizedChildren.length === 0) {
            continue;
        }

        out.push({
            id: node.id,
            kind: node.kind,
            filterKey: node.filterKey,
            filterValue: node.filterValue,
            label: node.label,
            subtitle: node.subtitle,
            count: node.count,
            blocked: node.blocked,
            serviceId: node.serviceId,
            domain: node.domain,
            rule: node.rule,
            filterList: node.filterList,
            qtypes,
            autoExpand: Boolean(q && finalizedChildren.length > 0),
            children: finalizedChildren,
        });
    }

    return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Builds an expandable 4-level hierarchy tree from aggregated flow tuples,
 * supporting dynamic pivoting across Device, Service, and Rule/Filter List.
 */
export function buildFlowTree(
    tuples: StatsFlowDetailsTuple[],
    pivot: TreePivot,
    search = '',
): FlowTreeNode[] {
    const roots = new Map<string, MutableTreeNode>();

    for (const tuple of tuples) {
        if (tuple.count <= 0) {
            continue;
        }
        const specs = levelsForTuple(tuple, pivot);
        let currentMap = roots;
        let pathPrefix = '';

        for (const spec of specs) {
            const nodeId = pathPrefix ? `${pathPrefix}/${spec.id}` : spec.id;
            pathPrefix = nodeId;
            let node = currentMap.get(nodeId);
            if (!node) {
                node = {
                    id: nodeId,
                    kind: spec.kind,
                    filterKey: spec.filterKey,
                    filterValue: spec.filterValue,
                    label: spec.label,
                    subtitle: spec.subtitle,
                    count: 0,
                    blocked: 0,
                    serviceId: spec.serviceId,
                    domain: spec.domain,
                    rule: spec.rule,
                    filterList: spec.filterList,
                    qtypes: [],
                    qtypeCounts: new Map<string, number>(),
                    children: [],
                    childMap: new Map<string, MutableTreeNode>(),
                };
                currentMap.set(nodeId, node);
            }
            node.count += tuple.count;
            node.blocked += tuple.blocked;
            if (tuple.qtype) {
                node.qtypeCounts.set(
                    tuple.qtype,
                    (node.qtypeCounts.get(tuple.qtype) ?? 0) + tuple.count,
                );
            }
            currentMap = node.childMap;
        }
    }

    return finalizeTreeNodes(roots.values(), search);
}

/**
 * Builds a Query Log URL preserving valid search and status filters.
 */
export function buildQueryLogLink(
    filter: FlowFilter,
    override?: { search?: string; status?: string },
): string {
    const params: Record<string, string> = {};
    const search = (override?.search ?? filter.domain ?? filter.client ?? '').trim();
    if (search) {
        params.search = search;
    }

    const rawStatus = override?.status ?? filter.status;
    if (rawStatus === 'blocked' || rawStatus === 'rewritten') {
        params.status = rawStatus;
    }

    return linkPathBuilder(
        RoutePath.Logs,
        undefined,
        Object.keys(params).length > 0 ? params : undefined,
    );
}

/**
 * Determines whether the primary one-click action for a domain should be
 * blocking or allowing based on live custom user rules and observed blocks.
 */
export function resolveDomainBlockAction(
    userRules: string,
    domain: string,
    blockedCount: number,
): 'block' | 'allow' {
    const clean = domain.trim().toLowerCase();
    const lines = userRules.split('\n');
    const allowRule = `@@||${clean}^$important`;
    const blockRule = `||${clean}^$important`;

    if (lines.includes(allowRule)) {
        return 'block';
    }
    if (lines.includes(blockRule) || blockedCount > 0) {
        return 'allow';
    }
    return 'block';
}
