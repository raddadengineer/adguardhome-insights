import { createStore } from 'solid-js/store';
import { untrack } from 'solid-js';
import {
    statsFlow,
    statsFlowDetails,
    statsTrafficMap,
    statsHeatmap,
    statsLatencyHeatmap,
    statsLatencyExemplars,
} from 'panel/api/generated';
import type { StatsFlowParams } from 'panel/api/model/statsFlowParams';
import type { StatsFlowResponse } from 'panel/api/model/statsFlowResponse';
import type { StatsFlowDetailsParams } from 'panel/api/model/statsFlowDetailsParams';
import type { StatsFlowDetailsResponse } from 'panel/api/model/statsFlowDetailsResponse';
import type { StatsTrafficMapParams } from 'panel/api/model/statsTrafficMapParams';
import type { StatsTrafficMapResponse } from 'panel/api/model/statsTrafficMapResponse';
import type { StatsHeatmapParams } from 'panel/api/model/statsHeatmapParams';
import type { StatsHeatmapResponse } from 'panel/api/model/statsHeatmapResponse';
import type { StatsLatencyHeatmapParams } from 'panel/api/model/statsLatencyHeatmapParams';
import type { StatsLatencyHeatmapResponse } from 'panel/api/model/statsLatencyHeatmapResponse';
import type { StatsLatencyExemplarsParams } from 'panel/api/model/statsLatencyExemplarsParams';
import type { StatsLatencyExemplar } from 'panel/api/model/statsLatencyExemplar';
import { addErrorToast } from './toasts';

type ObservabilityState = {
    flow: StatsFlowResponse | null;
    loadingFlow: boolean;
    flowError: string | null;

    flowDetails: StatsFlowDetailsResponse | null;
    loadingFlowDetails: boolean;
    flowDetailsError: string | null;

    trafficMap: StatsTrafficMapResponse | null;
    loadingTrafficMap: boolean;
    trafficMapError: string | null;

    heatmap: StatsHeatmapResponse | null;
    loadingHeatmap: boolean;
    heatmapError: string | null;

    latencyHeatmap: StatsLatencyHeatmapResponse | null;
    latencyExemplars: StatsLatencyExemplar[];
    loadingLatency: boolean;
    latencyError: string | null;
};

const initialState: ObservabilityState = {
    flow: null,
    loadingFlow: false,
    flowError: null,

    flowDetails: null,
    loadingFlowDetails: false,
    flowDetailsError: null,

    trafficMap: null,
    loadingTrafficMap: false,
    trafficMapError: null,

    heatmap: null,
    loadingHeatmap: false,
    heatmapError: null,

    latencyHeatmap: null,
    latencyExemplars: [],
    loadingLatency: false,
    latencyError: null,
};

const [state, setState] = createStore<ObservabilityState>(initialState);

let flowSeq = 0;
let flowDetailsSeq = 0;
let trafficSeq = 0;
let heatmapSeq = 0;
let latencySeq = 0;

export const fetchFlow = async (params?: StatsFlowParams, silent = false) => {
    const seq = ++flowSeq;
    if (!silent) {
        setState('loadingFlow', true);
    }

    try {
        const data = await statsFlow(params);
        if (seq !== flowSeq || !data) {
            return;
        }
        setState({
            flow: data,
            loadingFlow: false,
            flowError: null,
        });
    } catch (error) {
        if (seq !== flowSeq) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState({
            loadingFlow: false,
            flowError: message,
        });
        if (!silent) {
            addErrorToast({ error });
        }
    }
};

export const fetchFlowDetails = async (params?: StatsFlowDetailsParams, silent = false) => {
    const seq = ++flowDetailsSeq;
    if (!silent) {
        setState('loadingFlowDetails', true);
    }

    try {
        const data = await statsFlowDetails(params);
        if (seq !== flowDetailsSeq || !data) {
            return;
        }
        setState({
            flowDetails: data,
            loadingFlowDetails: false,
            flowDetailsError: null,
        });
    } catch (error) {
        if (seq !== flowDetailsSeq) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState({
            loadingFlowDetails: false,
            flowDetailsError: message,
        });
        if (!silent) {
            addErrorToast({ error });
        }
    }
};

export const clearFlowDetails = () => {
    flowDetailsSeq++;
    setState({
        flowDetails: null,
        loadingFlowDetails: false,
        flowDetailsError: null,
    });
};

export const fetchTrafficMap = async (params?: StatsTrafficMapParams, silent = false) => {
    const seq = ++trafficSeq;
    if (!silent) {
        setState('loadingTrafficMap', true);
    }

    try {
        const data = await statsTrafficMap(params);
        if (seq !== trafficSeq || !data) {
            return;
        }
        setState({
            trafficMap: data,
            loadingTrafficMap: false,
            trafficMapError: null,
        });
    } catch (error) {
        if (seq !== trafficSeq) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState({
            loadingTrafficMap: false,
            trafficMapError: message,
        });
        if (!silent) {
            addErrorToast({ error });
        }
    }
};

export const fetchHeatmap = async (params?: StatsHeatmapParams, silent = false) => {
    const seq = ++heatmapSeq;
    if (!silent) {
        setState('loadingHeatmap', true);
    }

    try {
        const data = await statsHeatmap(params);
        if (seq !== heatmapSeq || !data) {
            return;
        }
        setState({
            heatmap: data,
            loadingHeatmap: false,
            heatmapError: null,
        });
    } catch (error) {
        if (seq !== heatmapSeq) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState({
            loadingHeatmap: false,
            heatmapError: message,
        });
        if (!silent) {
            addErrorToast({ error });
        }
    }
};

export const fetchLatencyHeatmap = async (
    heatmapParams?: StatsLatencyHeatmapParams,
    exemplarParams?: StatsLatencyExemplarsParams,
    silent = false,
) => {
    const seq = ++latencySeq;
    if (!silent) {
        setState('loadingLatency', true);
    }

    try {
        const [heatmapData, exemplarsData] = await Promise.all([
            statsLatencyHeatmap(heatmapParams),
            statsLatencyExemplars(exemplarParams).catch(() => ({
                items: [] as StatsLatencyExemplar[],
            })),
        ]);
        if (seq !== latencySeq || !heatmapData) {
            return;
        }
        setState({
            latencyHeatmap: heatmapData,
            latencyExemplars: exemplarsData?.items ?? [],
            loadingLatency: false,
            latencyError: null,
        });
    } catch (error) {
        if (seq !== latencySeq) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState({
            loadingLatency: false,
            latencyError: message,
        });
        if (!silent) {
            addErrorToast({ error });
        }
    }
};

export const observabilityState = untrack(() => state);
