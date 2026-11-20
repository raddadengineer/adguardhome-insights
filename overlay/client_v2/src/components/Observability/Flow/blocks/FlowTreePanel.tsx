import { createSignal, createMemo, For, Show } from 'solid-js';
import cn from 'clsx';

import intl from 'panel/common/intl';
import { filteringState, blockDomain, unblockDomain } from 'panel/stores/filtering';
import { servicesState, allowBlockedService, blockService } from 'panel/stores/services';
import type { StatsFlowDetailsTuple } from 'panel/api/model/statsFlowDetailsTuple';
import { formatPercent } from 'panel/helpers/observability/sankey';
import {
    buildFlowTree,
    resolveDomainBlockAction,
    type FlowFilter,
    type FlowTreeNode,
    type TreePivot,
} from 'panel/helpers/observability/flowDrilldown';

import s from './FlowTreePanel.module.pcss';

const PIVOTS: readonly TreePivot[] = ['device', 'service', 'rule'];

type Props = {
    tuples: StatsFlowDetailsTuple[];
    total: number;
    search: string;
    onDrill: (key: keyof FlowFilter, value: string) => void;
    onOpenQueryLog: (override: { search?: string; status?: string }) => void;
    onOpenHeatmap: (kind: 'domain' | 'client', key: string) => void;
};

function collectParentIds(nodes: FlowTreeNode[], acc: Set<string>): void {
    for (const node of nodes) {
        if (node.children.length > 0) {
            acc.add(node.id);
            collectParentIds(node.children, acc);
        }
    }
}

export const FlowTreePanel = (props: Props) => {
    const [pivot, setPivot] = createSignal<TreePivot>('device');
    const [collapsedIds, setCollapsedIds] = createSignal<Set<string>>(new Set());
    const [manualExpandedIds, setManualExpandedIds] = createSignal<Set<string>>(new Set());
    const [busyKey, setBusyKey] = createSignal<string | null>(null);

    const tree = createMemo(() => buildFlowTree(props.tuples, pivot(), props.search));

    const blockedServiceIds = createMemo(() => new Set(servicesState.list?.ids ?? []));

    const isExpanded = (node: FlowTreeNode, depth: number, rootIndex: number): boolean => {
        if (node.children.length === 0) {
            return false;
        }
        if (node.autoExpand) {
            return true;
        }
        if (collapsedIds().has(node.id)) {
            return false;
        }
        if (manualExpandedIds().has(node.id)) {
            return true;
        }
        if (depth === 0 && rootIndex < 3) {
            return true;
        }
        return depth === 1 && rootIndex < 2;
    };

    const toggleNode = (node: FlowTreeNode, depth: number, rootIndex: number) => {
        const currentlyOpen = isExpanded(node, depth, rootIndex);
        if (currentlyOpen) {
            setCollapsedIds((prev) => new Set(prev).add(node.id));
            setManualExpandedIds((prev) => {
                const next = new Set(prev);
                next.delete(node.id);
                return next;
            });
        } else {
            setManualExpandedIds((prev) => new Set(prev).add(node.id));
            setCollapsedIds((prev) => {
                const next = new Set(prev);
                next.delete(node.id);
                return next;
            });
        }
    };

    const expandAll = () => {
        const all = new Set<string>();
        collectParentIds(tree(), all);
        setCollapsedIds(new Set<string>());
        setManualExpandedIds(all);
    };

    const collapseAll = () => {
        const all = new Set<string>();
        collectParentIds(tree(), all);
        setManualExpandedIds(new Set<string>());
        setCollapsedIds(all);
    };

    const pivotLabel = (p: TreePivot): string => {
        switch (p) {
            case 'device':
                return intl.getMessage('obs_pivot_device');
            case 'service':
                return intl.getMessage('obs_pivot_service');
            case 'rule':
                return intl.getMessage('obs_pivot_rule');
        }
    };

    const handleDomainAction = async (domain: string, action: 'block' | 'allow') => {
        const key = `domain:${domain}`;
        if (busyKey() === key) {
            return;
        }
        setBusyKey(key);
        try {
            if (action === 'allow') {
                await unblockDomain(domain);
            } else {
                await blockDomain(domain);
            }
        } finally {
            setBusyKey(null);
        }
    };

    const handleServiceAction = async (serviceId: string, currentlyBlocked: boolean) => {
        const key = `service:${serviceId}`;
        if (busyKey() === key) {
            return;
        }
        setBusyKey(key);
        try {
            if (currentlyBlocked) {
                await allowBlockedService(serviceId);
            } else {
                await blockService(serviceId);
            }
        } finally {
            setBusyKey(null);
        }
    };

    const TreeBranch = (branchProps: {
        node: FlowTreeNode;
        depth: number;
        rootIndex: number;
    }) => {
        const node = () => branchProps.node;
        const depth = () => branchProps.depth;
        const hasChildren = () => node().children.length > 0;
        const expanded = () => isExpanded(node(), depth(), branchProps.rootIndex);
        const blockedShare = () =>
            node().count > 0 ? Math.min(100, Math.round((node().blocked / node().count) * 100)) : 0;

        const isCatalogService = () =>
            node().kind === 'service' &&
            Boolean(node().serviceId) &&
            !node().serviceId?.startsWith('site:');

        const svcBlocked = () =>
            Boolean(node().serviceId && blockedServiceIds().has(node().serviceId as string));

        const domainAction = (): 'block' | 'allow' =>
            resolveDomainBlockAction(
                filteringState.userRules || '',
                node().domain ?? node().label,
                node().blocked,
            );

        return (
            <div class={s.branch}>
                <div
                    class={cn(s.row, { [s.rootRow]: depth() === 0 })}
                    style={{ 'padding-inline-start': `${depth() * 20 + 8}px` }}
                >
                    <div class={s.rowMain}>
                        <button
                            type="button"
                            class={cn(s.chevronBtn, { [s.chevronHidden]: !hasChildren() })}
                            disabled={!hasChildren()}
                            aria-expanded={hasChildren() ? expanded() : undefined}
                            aria-label={intl.getMessage('obs_tree_toggle_aria', {
                                label: node().label,
                            })}
                            onClick={() => toggleNode(node(), depth(), branchProps.rootIndex)}
                        >
                            {expanded() ? '▾' : '▸'}
                        </button>

                        <button
                            type="button"
                            class={cn(s.labelBtn, { [s.ruleLabel]: node().kind === 'rule' })}
                            onClick={() => {
                                if (hasChildren()) {
                                    toggleNode(node(), depth(), branchProps.rootIndex);
                                } else {
                                    props.onDrill(node().filterKey, node().filterValue);
                                }
                            }}
                        >
                            {node().label}
                        </button>

                        <Show when={node().subtitle}>
                            <span class={s.subtitlePill}>{node().subtitle}</span>
                        </Show>

                        <For each={node().qtypes.slice(0, 3)}>
                            {(qt) => <span class={s.qtypePill}>{qt}</span>}
                        </For>
                    </div>

                    <div class={s.rowStats}>
                        <div class={s.barTrack} aria-hidden="true">
                            <div
                                class={cn(s.barFill, { [s.barBlocked]: node().blocked > 0 })}
                                style={{
                                    width: `${Math.max(
                                        4,
                                        props.total > 0 ? (node().count / props.total) * 100 : 0,
                                    )}%`,
                                }}
                            />
                        </div>
                        <span class={s.countsText}>
                            <Show when={node().blocked > 0}>
                                <span class={s.blockedNum}>
                                    {node().blocked.toLocaleString()} ({blockedShare()}%)
                                </span>
                                {' / '}
                            </Show>
                            <strong>{node().count.toLocaleString()}</strong> (
                            {formatPercent(node().count, props.total)})
                        </span>
                    </div>

                    <div class={s.rowActions}>
                        <Show
                            when={
                                node().filterValue &&
                                node().filterValue !== 'unknown' &&
                                node().filterValue !== 'none'
                            }
                        >
                            <button
                                type="button"
                                class={s.actionBtn}
                                onClick={() =>
                                    props.onDrill(node().filterKey, node().filterValue)
                                }
                            >
                                {intl.getMessage('obs_drill_in')}
                            </button>
                        </Show>

                        <Show when={node().kind === 'domain' && node().domain}>
                            <button
                                type="button"
                                disabled={busyKey() === `domain:${node().domain}`}
                                class={cn(
                                    s.actionBtn,
                                    domainAction() === 'allow' ? s.allowBtn : s.blockBtn,
                                )}
                                onClick={() =>
                                    void handleDomainAction(
                                        node().domain as string,
                                        domainAction(),
                                    )
                                }
                            >
                                {domainAction() === 'allow'
                                    ? intl.getMessage('obs_action_allow')
                                    : intl.getMessage('obs_action_block')}
                            </button>
                        </Show>

                        <Show when={isCatalogService() && node().serviceId}>
                            <button
                                type="button"
                                disabled={busyKey() === `service:${node().serviceId}`}
                                class={cn(
                                    s.actionBtn,
                                    svcBlocked() ? s.allowBtn : s.blockBtn,
                                )}
                                onClick={() =>
                                    void handleServiceAction(
                                        node().serviceId as string,
                                        svcBlocked(),
                                    )
                                }
                            >
                                {svcBlocked()
                                    ? intl.getMessage('obs_action_allow_service')
                                    : intl.getMessage('obs_action_block_service')}
                            </button>
                        </Show>

                        <Show when={node().kind === 'domain' && node().domain}>
                            <button
                                type="button"
                                class={s.actionBtn}
                                onClick={() => props.onOpenQueryLog({ search: node().domain })}
                            >
                                {intl.getMessage('obs_open_query_log')}
                            </button>
                            <button
                                type="button"
                                class={s.actionBtn}
                                onClick={() =>
                                    props.onOpenHeatmap('domain', node().domain as string)
                                }
                            >
                                {intl.getMessage('obs_open_heatmap')}
                            </button>
                        </Show>

                        <Show when={node().kind === 'client' && node().filterValue !== 'unknown'}>
                            <button
                                type="button"
                                class={s.actionBtn}
                                onClick={() =>
                                    props.onOpenQueryLog({ search: node().filterValue })
                                }
                            >
                                {intl.getMessage('obs_open_query_log')}
                            </button>
                            <button
                                type="button"
                                class={s.actionBtn}
                                onClick={() =>
                                    props.onOpenHeatmap('client', node().filterValue)
                                }
                            >
                                {intl.getMessage('obs_open_heatmap')}
                            </button>
                        </Show>
                    </div>
                </div>

                <Show when={expanded()}>
                    <div class={s.childrenWrap}>
                        <For each={node().children}>
                            {(child) => (
                                <TreeBranch
                                    node={child}
                                    depth={depth() + 1}
                                    rootIndex={branchProps.rootIndex}
                                />
                            )}
                        </For>
                    </div>
                </Show>
            </div>
        );
    };

    return (
        <div class={s.container}>
            <div class={s.controlsBar}>
                <div class={s.segmented} role="group">
                    <For each={PIVOTS}>
                        {(p) => (
                            <button
                                type="button"
                                class={cn(s.segBtn, { [s.segActive]: pivot() === p })}
                                onClick={() => {
                                    setCollapsedIds(new Set<string>());
                                    setManualExpandedIds(new Set<string>());
                                    setPivot(p);
                                }}
                            >
                                {pivotLabel(p)}
                            </button>
                        )}
                    </For>
                </div>

                <div class={s.expandControls}>
                    <button type="button" class={s.actionBtn} onClick={expandAll}>
                        {intl.getMessage('obs_expand_all')}
                    </button>
                    <button type="button" class={s.actionBtn} onClick={collapseAll}>
                        {intl.getMessage('obs_collapse_all')}
                    </button>
                </div>
            </div>

            <Show
                when={tree().length > 0}
                fallback={<div class={s.empty}>{intl.getMessage('obs_tree_empty')}</div>}
            >
                <div class={s.treeList} role="tree">
                    <For each={tree()}>
                        {(root, idx) => (
                            <TreeBranch node={root} depth={0} rootIndex={idx()} />
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};
