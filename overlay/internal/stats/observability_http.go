package stats

import (
	"net/http"
	"strconv"
	"time"

	"github.com/AdguardTeam/AdGuardHome/internal/aghhttp"
	"github.com/AdguardTeam/golibs/errors"
	"github.com/AdguardTeam/golibs/timeutil"
)

const (
	errInvalidWindow      errors.Error = "invalid window parameter"
	errInvalidGroupBy     errors.Error = "invalid group_by parameter"
	errInvalidKind        errors.Error = "invalid kind parameter"
	errInvalidGrain       errors.Error = "invalid grain parameter"
	errInvalidMeasure     errors.Error = "invalid measure parameter"
	errInvalidBy          errors.Error = "invalid by parameter"
	errInvalidStep        errors.Error = "invalid step parameter"
	errInvalidPath        errors.Error = "invalid path parameter"
	errInvalidStatus      errors.Error = "invalid status parameter"
	errInvalidView        errors.Error = "invalid view parameter"
	errInvalidLimit       errors.Error = "invalid limit parameter"
	errMissingKey         errors.Error = "key parameter is required when kind is not network"
	errHeatmapGrainWindow errors.Error = "grain exceeds allowed window"
	errLatencyStepWindow  errors.Error = "minute step is only supported up to 24h"
)

// StatsFlowNode is one node in the 4-stage query flow diagram.
type StatsFlowNode struct {
	ID      string `json:"id"`
	Stage   string `json:"stage"`
	Name    string `json:"name"`
	Label   string `json:"label"`
	Count   uint64 `json:"count"`
	DeadEnd uint64 `json:"dead_end"`
}

// StatsFlowLink is an exact directed count between two stages.
type StatsFlowLink struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	Count   uint64 `json:"count"`
	Failure bool   `json:"failure"`
}

// StatsFlowResp is the response to GET /control/stats/flow.
type StatsFlowResp struct {
	From      string          `json:"from"`
	To        string          `json:"to"`
	Source    string          `json:"source"`
	GroupBy   string          `json:"group_by"`
	View      string          `json:"view,omitempty"`
	Stages    []string        `json:"stages,omitempty"`
	Client    string          `json:"client,omitempty"`
	Total     uint64          `json:"total"`
	Nodes     []StatsFlowNode `json:"nodes"`
	Links     []StatsFlowLink `json:"links"`
	Partial   bool            `json:"partial"`
	Truncated bool            `json:"truncated"`
}

// StatsFlowDetailsClient summarizes matching traffic for one client device.
type StatsFlowDetailsClient struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Tag     string `json:"tag,omitempty"`
	Count   uint64 `json:"count"`
	Blocked uint64 `json:"blocked"`
}

// StatsFlowDetailsDomain summarizes matching traffic and blocking cause for one domain.
type StatsFlowDetailsDomain struct {
	Domain      string   `json:"domain"`
	Count       uint64   `json:"count"`
	Blocked     uint64   `json:"blocked"`
	Reason      string   `json:"reason,omitempty"`
	Rule        string   `json:"rule,omitempty"`
	Service     string   `json:"service,omitempty"`
	ServiceName string   `json:"service_name,omitempty"`
	Category    string   `json:"category,omitempty"`
	FilterList  string   `json:"filter_list,omitempty"`
	QTypes      []string `json:"qtypes,omitempty"`
	Clients     uint64   `json:"clients"`
}

// StatsFlowDetailsRule summarizes a matched filtering rule or blocking reason.
type StatsFlowDetailsRule struct {
	Rule       string `json:"rule"`
	Reason     string `json:"reason,omitempty"`
	FilterList string `json:"filter_list,omitempty"`
	Count      uint64 `json:"count"`
}

// StatsFlowDetailsQuery represents a single recent matching query log entry.
type StatsFlowDetailsQuery struct {
	Time        string `json:"time"`
	Domain      string `json:"domain"`
	Client      string `json:"client"`
	ClientName  string `json:"client_name,omitempty"`
	QType       string `json:"qtype,omitempty"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
	Rule        string `json:"rule,omitempty"`
	Service     string `json:"service,omitempty"`
	ServiceName string `json:"service_name,omitempty"`
	Category    string `json:"category,omitempty"`
	FilterList  string `json:"filter_list,omitempty"`
	Upstream    string `json:"upstream,omitempty"`
	Rcode       string `json:"rcode,omitempty"`
	LatencyUs   uint64 `json:"latency_us"`
}

// StatsFlowDetailsTuple represents one aggregated multi-level drill-down row
// used to render and pivot the client-side hierarchy tree.
type StatsFlowDetailsTuple struct {
	ClientID    string `json:"client_id"`
	ClientLabel string `json:"client_label"`
	Tag         string `json:"tag,omitempty"`
	ServiceID   string `json:"service_id"`
	ServiceName string `json:"service_name"`
	Category    string `json:"category"`
	Domain      string `json:"domain"`
	FilterList  string `json:"filter_list"`
	Reason      string `json:"reason,omitempty"`
	Rule        string `json:"rule,omitempty"`
	QType       string `json:"qtype"`
	Status      string `json:"status"`
	Count       uint64 `json:"count"`
	Blocked     uint64 `json:"blocked"`
}

// StatsFlowDetailsResp is the response to GET /control/stats/flow/details.
type StatsFlowDetailsResp struct {
	From      string                   `json:"from"`
	To        string                   `json:"to"`
	Total     uint64                   `json:"total"`
	Blocked   uint64                   `json:"blocked"`
	Truncated bool                     `json:"truncated"`
	Clients   []StatsFlowDetailsClient `json:"clients"`
	Domains   []StatsFlowDetailsDomain `json:"domains"`
	Rules     []StatsFlowDetailsRule   `json:"rules"`
	Recent    []StatsFlowDetailsQuery  `json:"recent"`
	Tuples    []StatsFlowDetailsTuple  `json:"tuples"`
}

// StatsTrafficMapItem is a domain entry in the traffic map treemap.
type StatsTrafficMapItem struct {
	Domain string `json:"domain"`
	Count  uint64 `json:"count"`
}

// StatsTrafficMapResp is the response to GET /control/stats/traffic_map.
type StatsTrafficMapResp struct {
	From    string                `json:"from"`
	To      string                `json:"to"`
	Window  string                `json:"window"`
	Allowed []StatsTrafficMapItem `json:"allowed"`
	Blocked []StatsTrafficMapItem `json:"blocked"`
}

// StatsHeatmapResp is the response to GET /control/stats/heatmap.
type StatsHeatmapResp struct {
	From        string   `json:"from"`
	To          string   `json:"to"`
	Grain       string   `json:"grain"`
	Kind        string   `json:"kind"`
	Key         string   `json:"key,omitempty"`
	Measure     string   `json:"measure"`
	SlotSeconds int      `json:"slot_seconds"`
	Precision   string   `json:"precision"`
	Starts      []int64  `json:"starts"`
	Values      []uint64 `json:"values"`
	Covered     []bool   `json:"covered"`
	Partial     bool     `json:"partial"`
	Truncated   bool     `json:"truncated"`
}

// StatsLatencyHeatmapResp is the response to GET /control/stats/latency_heatmap.
type StatsLatencyHeatmapResp struct {
	From     string                `json:"from"`
	To       string                `json:"to"`
	Step     string                `json:"step"`
	By       string                `json:"by"`
	BoundsUs []uint64              `json:"bounds_us"`
	Starts   []int64               `json:"starts"`
	Series   map[string][][]uint32 `json:"series"`
	Partial  bool                  `json:"partial"`
}

// StatsLatencyExemplarsResp is the response to GET /control/stats/latency_exemplars.
type StatsLatencyExemplarsResp struct {
	Items []LatencyExemplar `json:"items"`
}

func parseFlowWindow(window string) (time.Duration, error) {
	switch window {
	case "live":
		return time.Minute, nil
	case "5m":
		return 5 * time.Minute, nil
	case "15m":
		return 15 * time.Minute, nil
	case "1h":
		return time.Hour, nil
	case "6h":
		return 6 * time.Hour, nil
	case "24h":
		return timeutil.Day, nil
	case "7d":
		return 7 * timeutil.Day, nil
	case "30d":
		return 30 * timeutil.Day, nil
	case "90d":
		return 90 * timeutil.Day, nil
	default:
		return 0, errInvalidWindow
	}
}

func parseHeatmapWindow(window string) (uint32, error) {
	switch window {
	case "24h":
		return 24, nil
	case "7d":
		return 24 * 7, nil
	case "30d":
		return 24 * 30, nil
	case "90d":
		return 24 * 90, nil
	default:
		return 0, errInvalidWindow
	}
}

func parseLatencyWindow(window string) (time.Duration, error) {
	switch window {
	case "1h":
		return time.Hour, nil
	case "6h":
		return 6 * time.Hour, nil
	case "24h":
		return timeutil.Day, nil
	case "7d":
		return 7 * timeutil.Day, nil
	case "30d":
		return 30 * timeutil.Day, nil
	default:
		return 0, errInvalidWindow
	}
}

func parseExemplarWindow(window string) (time.Duration, error) {
	switch window {
	case "1h":
		return time.Hour, nil
	case "6h":
		return 6 * time.Hour, nil
	case "24h":
		return timeutil.Day, nil
	default:
		return 0, errInvalidWindow
	}
}

func queryParamOrDefault(r *http.Request, key, def string) string {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}

	return v
}

func parseFlowFilter(r *http.Request) flowFilter {
	q := r.URL.Query()

	return flowFilter{
		View:       q.Get("view"),
		Client:     q.Get("client"),
		Tag:        q.Get("tag"),
		Protocol:   q.Get("protocol"),
		Status:     q.Get("status"),
		Upstream:   q.Get("upstream"),
		Rcode:      q.Get("rcode"),
		Domain:     q.Get("domain"),
		Category:   q.Get("category"),
		Service:    q.Get("service"),
		FilterList: q.Get("filter_list"),
		Reason:     q.Get("reason"),
		Rule:       q.Get("rule"),
		QType:      q.Get("qtype"),
	}
}

func (s *StatsCtx) handleStatsFlow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	window := queryParamOrDefault(r, "window", "24h")
	groupBy := queryParamOrDefault(r, "group_by", "client")
	filter := parseFlowFilter(r)

	resp, err := s.buildFlow(ctx, window, groupBy, filter, time.Now())
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errInvalidWindow) ||
			errors.Is(err, errInvalidGroupBy) ||
			errors.Is(err, errInvalidStatus) ||
			errors.Is(err, errInvalidView) {
			status = http.StatusBadRequest
		}
		aghhttp.ErrorAndLog(ctx, s.logger, r, w, status, "%s", err)

		return
	}

	aghhttp.WriteJSONResponseOK(ctx, s.logger, w, r, resp)
}

func (s *StatsCtx) handleStatsFlowDetails(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	window := queryParamOrDefault(r, "window", "24h")
	filter := parseFlowFilter(r)

	limit := 50
	if rawLimit := q.Get("limit"); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v < 1 || v > 200 {
			aghhttp.ErrorAndLog(ctx, s.logger, r, w, http.StatusBadRequest, "%s", errInvalidLimit)

			return
		}
		limit = v
	}

	resp, err := s.buildFlowDetails(ctx, window, filter, limit, time.Now())
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errInvalidWindow) ||
			errors.Is(err, errInvalidStatus) ||
			errors.Is(err, errInvalidView) {
			status = http.StatusBadRequest
		}
		aghhttp.ErrorAndLog(ctx, s.logger, r, w, status, "%s", err)

		return
	}

	aghhttp.WriteJSONResponseOK(ctx, s.logger, w, r, resp)
}

func (s *StatsCtx) handleStatsTrafficMap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	window := queryParamOrDefault(r, "window", "current_hour")
	limit := 100
	if rawLimit := q.Get("limit"); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v < 1 || v > 200 {
			aghhttp.ErrorAndLog(ctx, s.logger, r, w, http.StatusBadRequest, "%s", errInvalidLimit)

			return
		}
		limit = v
	}

	resp, err := s.buildTrafficMap(window, limit, time.Now())
	if err != nil {
		aghhttp.ErrorAndLog(ctx, s.logger, r, w, http.StatusBadRequest, "%s", err)

		return
	}

	aghhttp.WriteJSONResponseOK(ctx, s.logger, w, r, resp)
}

func (s *StatsCtx) handleStatsHeatmap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	window := queryParamOrDefault(r, "window", "7d")
	grain := q.Get("grain")
	kind := queryParamOrDefault(r, "kind", "network")
	key := q.Get("key")
	measure := queryParamOrDefault(r, "measure", "queries")

	resp, err := s.buildHeatmap(ctx, window, grain, kind, key, measure, time.Now())
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errInvalidWindow) ||
			errors.Is(err, errInvalidKind) ||
			errors.Is(err, errInvalidGrain) ||
			errors.Is(err, errInvalidMeasure) ||
			errors.Is(err, errMissingKey) ||
			errors.Is(err, errHeatmapGrainWindow) {
			status = http.StatusBadRequest
		}
		aghhttp.ErrorAndLog(ctx, s.logger, r, w, status, "%s", err)

		return
	}

	aghhttp.WriteJSONResponseOK(ctx, s.logger, w, r, resp)
}

func (s *StatsCtx) handleStatsLatencyHeatmap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	window := queryParamOrDefault(r, "window", "6h")
	step := q.Get("step")
	by := queryParamOrDefault(r, "by", "path")

	resp, err := s.buildLatencyHeatmap(window, step, by, time.Now())
	if err != nil {
		aghhttp.ErrorAndLog(ctx, s.logger, r, w, http.StatusBadRequest, "%s", err)

		return
	}

	aghhttp.WriteJSONResponseOK(ctx, s.logger, w, r, resp)
}

func (s *StatsCtx) handleStatsLatencyExemplars(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	window := queryParamOrDefault(r, "window", "6h")
	pathFilter := q.Get("path")
	upstreamFilter := q.Get("upstream")

	items, err := s.listLatencyExemplars(window, pathFilter, upstreamFilter, time.Now())
	if err != nil {
		aghhttp.ErrorAndLog(ctx, s.logger, r, w, http.StatusBadRequest, "%s", err)

		return
	}

	aghhttp.WriteJSONResponseOK(ctx, s.logger, w, r, &StatsLatencyExemplarsResp{
		Items: items,
	})
}
