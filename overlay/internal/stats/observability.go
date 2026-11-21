package stats

import (
	"context"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/AdguardTeam/AdGuardHome/internal/aghnet"
)

const (
	// flowSep separates stage keys in serialized flow joint count keys.
	flowSep = "\x1f"

	// maxFlowJointKeys caps non-client flow joint maps on serialization.
	maxFlowJointKeys = 500

	// maxExemplars is the capacity of the in-memory latency exemplar ring.
	maxExemplars = 512

	// maxHeatmapSlots caps slots returned in a single heatmap response (7 days of
	// 1-minute slots).
	maxHeatmapSlots = 10_080

	// maxQueryLogScanEntries caps query log rows scanned per analytics request.
	maxQueryLogScanEntries = 200_000

	// maxFlowRecentQueries caps recent matching queries returned by flow details.
	maxFlowRecentQueries = 25

	// maxDynamicStageNodes caps high-cardinality nodes per dynamic flow stage.
	maxDynamicStageNodes = 12

	// maxFlowDetailTuples caps aggregated hierarchy tuples returned by flow details.
	maxFlowDetailTuples = 500
)

// latencyBoundsUs defines the 16 upper bounds in microseconds for latency
// heatmap buckets; bucket 16 holds values > 5 s.
var latencyBoundsUs = [16]uint64{
	50,
	100,
	250,
	500,
	1_000,
	2_500,
	5_000,
	10_000,
	25_000,
	50_000,
	100_000,
	250_000,
	500_000,
	1_000_000,
	2_500_000,
	5_000_000,
}

const numLatencyBuckets = len(latencyBoundsUs) + 1

// QueryLogEntry is a lightweight query log projection used by analytics queries.
type QueryLogEntry struct {
	Time          time.Time
	Domain        string
	Client        string
	ClientName    string
	ClientProto   string
	QType         string
	Status        string
	Upstream      string
	Rcode         string
	Reason        string
	Rule          string
	ServiceName   string
	FilterListID  int64
	HasFilterList bool
	Elapsed       time.Duration
	Blocked       bool
}

// QueryLogScanParams configures a bounded read-only query log scan.
type QueryLogScanParams struct {
	Since      time.Time
	Until      time.Time
	Client     string
	Domain     string
	MaxEntries int
}

// QueryLogScanner abstracts bounded query log scans for stats analytics without
// coupling stats directly to querylog.
type QueryLogScanner interface {
	Scan(ctx context.Context, params QueryLogScanParams, fn func(QueryLogEntry) bool) (truncated bool, err error)
}

type minuteKey struct {
	minute uint8
	key    string
}

// latencyHistDB is the GOB-persisted per-hour latency bucket array for one key.
type latencyHistDB struct {
	Key     string
	Buckets [numLatencyBuckets]uint32
}

// latencyBinCount stores a non-zero bin count inside a minute latency slice.
type latencyBinCount struct {
	Bucket uint8
	Count  uint32
}

// minuteLatencyDB is the GOB-persisted sparse latency histogram for one minute
// and one key inside an hourly stats unit.
type minuteLatencyDB struct {
	Minute uint8
	Key    string
	Bins   []latencyBinCount
}

// LatencyExemplar represents a sampled real DNS request in a latency bucket.
type LatencyExemplar struct {
	Time         string `json:"time"`
	TsUnixMicros int64  `json:"ts_unix_micros"`
	LatencyUs    uint64 `json:"latency_us"`
	Path         string `json:"path"`
	Upstream     string `json:"upstream,omitempty"`
	Domain       string `json:"domain"`
	Client       string `json:"client"`
	Rcode        string `json:"rcode,omitempty"`
}

type exemplarThrottleKey struct {
	path   string
	bucket int
}

// exemplarRing keeps the most recent latency exemplars, rate-limited to at most
// one exemplar per (path, bucket) per second.
type exemplarRing struct {
	items      [maxExemplars]LatencyExemplar
	head       int
	count      int
	lastSample map[exemplarThrottleKey]int64
}

func newExemplarRing() *exemplarRing {
	return &exemplarRing{
		lastSample: map[exemplarThrottleKey]int64{},
	}
}

func (r *exemplarRing) clear() {
	r.head = 0
	r.count = 0
	clear(r.lastSample)
}

func (r *exemplarRing) add(ex LatencyExemplar, sec int64, bucket int) {
	tk := exemplarThrottleKey{path: ex.Path, bucket: bucket}
	if last, ok := r.lastSample[tk]; ok && sec <= last {
		return
	}
	r.lastSample[tk] = sec

	r.items[r.head] = ex
	r.head = (r.head + 1) % maxExemplars
	if r.count < maxExemplars {
		r.count++
	}
}

func (r *exemplarRing) list(sinceUs int64, pathFilter, upstreamFilter string) []LatencyExemplar {
	out := make([]LatencyExemplar, 0, min(r.count, 128))
	for i := range r.count {
		idx := (r.head - 1 - i + maxExemplars) % maxExemplars
		ex := r.items[idx]
		if sinceUs > 0 && ex.TsUnixMicros < sinceUs {
			continue
		}
		if pathFilter != "" && ex.Path != pathFilter {
			continue
		}
		if upstreamFilter != "" && ex.Upstream != upstreamFilter {
			continue
		}
		out = append(out, ex)
	}

	return out
}

func latencyBucketIndex(us uint64) int {
	for i, b := range latencyBoundsUs {
		if us <= b {
			return i
		}
	}

	return numLatencyBuckets - 1
}

func classifyEntryObservability(e *Entry) (status, upstream, rcode, group, proto, latencyPath string) {
	upstream = e.Upstream
	if upstream == "" {
		for _, us := range e.UpstreamStats {
			if us != nil && !us.IsCached {
				upstream = us.Address
				break
			}
		}
	}

	status = e.Status
	if status == "" {
		switch {
		case e.Result != RNotFiltered:
			status = "blocked"
		case e.Cached:
			status = "cached"
		case upstream != "":
			status = "forwarded"
		default:
			status = "local"
		}
	}

	rcode = e.Rcode
	if rcode == "" && status != "error" {
		rcode = "NOERROR"
	}

	group = e.ClientGroup
	if group == "" {
		group = "untagged"
	}

	proto = e.ClientProto
	if proto == "" {
		proto = "plain"
	}

	switch {
	case status == "blocked":
		latencyPath = "blocked"
	case status == "cached":
		latencyPath = "cache"
	case status == "forwarded" || (status == "error" && upstream != ""):
		latencyPath = "upstream"
	default:
		latencyPath = "local"
	}

	return status, upstream, rcode, group, proto, latencyPath
}

func incFlowCounter(m *map[string]uint64, key string) {
	if *m == nil {
		*m = map[string]uint64{}
	}
	(*m)[key]++
}

func incLatencyBucket(m *map[string]*[numLatencyBuckets]uint32, key string, bucket int) {
	if *m == nil {
		*m = map[string]*[numLatencyBuckets]uint32{}
	}
	arr, ok := (*m)[key]
	if !ok {
		arr = &[numLatencyBuckets]uint32{}
		(*m)[key] = arr
	}
	arr[bucket]++
}

func incMinuteLatencyBucket(m *map[minuteKey]*[numLatencyBuckets]uint32, minIdx uint8, key string, bucket int) {
	if *m == nil {
		*m = map[minuteKey]*[numLatencyBuckets]uint32{}
	}
	mk := minuteKey{minute: minIdx, key: key}
	arr, ok := (*m)[mk]
	if !ok {
		arr = &[numLatencyBuckets]uint32{}
		(*m)[mk] = arr
	}
	arr[bucket]++
}

func serializeClientStatus(m map[string]uint64) []countPair {
	if len(m) == 0 {
		return nil
	}

	totals := make(map[string]uint64)
	for k, v := range m {
		client, _, ok := strings.Cut(k, flowSep)
		if !ok || client == "other" {
			continue
		}
		totals[client] += v
	}

	topClients := convertMapToSlice(totals, maxClients)
	keep := make(map[string]struct{}, len(topClients))
	for _, cp := range topClients {
		keep[cp.Name] = struct{}{}
	}

	outMap := make(map[string]uint64)
	for k, v := range m {
		client, status, ok := strings.Cut(k, flowSep)
		if !ok {
			continue
		}
		if _, isTop := keep[client]; isTop {
			outMap[k] += v
		} else {
			outMap["other"+flowSep+status] += v
		}
	}

	return convertMapToSlice(outMap, len(outMap))
}

func serializeLatencyHist(m map[string]*[numLatencyBuckets]uint32) []latencyHistDB {
	if len(m) == 0 {
		return nil
	}

	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]latencyHistDB, 0, len(keys))
	for _, k := range keys {
		out = append(out, latencyHistDB{
			Key:     k,
			Buckets: *m[k],
		})
	}

	return out
}

func serializeMinuteLatency(m map[minuteKey]*[numLatencyBuckets]uint32) []minuteLatencyDB {
	if len(m) == 0 {
		return nil
	}

	out := make([]minuteLatencyDB, 0, len(m))
	for mk, arr := range m {
		var bins []latencyBinCount
		for b, cnt := range arr {
			if cnt > 0 {
				bins = append(bins, latencyBinCount{
					Bucket: uint8(b),
					Count:  cnt,
				})
			}
		}
		if len(bins) > 0 {
			out = append(out, minuteLatencyDB{
				Minute: mk.minute,
				Key:    mk.key,
				Bins:   bins,
			})
		}
	}

	slices.SortFunc(out, func(a, b minuteLatencyDB) int {
		if a.Minute != b.Minute {
			if a.Minute < b.Minute {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Key, b.Key)
	})

	return out
}

func (s *StatsCtx) recordExemplar(e *Entry) {
	if e == nil {
		return
	}

	ts := e.Timestamp
	if ts.IsZero() {
		ts = time.Now()
	}

	_, upstream, rcode, _, _, latencyPath := classifyEntryObservability(e)
	us := uint64(max(int64(0), e.ProcessingTime.Microseconds()))
	bucket := latencyBucketIndex(us)

	ex := LatencyExemplar{
		Time:         ts.UTC().Format(time.RFC3339Nano),
		TsUnixMicros: ts.UnixMicro(),
		LatencyUs:    us,
		Path:         latencyPath,
		Upstream:     upstream,
		Domain:       e.Domain,
		Client:       e.Client,
		Rcode:        rcode,
	}

	s.exemplarMu.Lock()
	defer s.exemplarMu.Unlock()

	if s.exemplars == nil {
		s.exemplars = newExemplarRing()
	}
	s.exemplars.add(ex, ts.Unix(), bucket)
}

func (s *StatsCtx) resolveClientDisplayName(id string, fallback string) string {
	if id == "" || id == "other" {
		return id
	}
	if fallback != "" {
		return fallback
	}
	if s.clientName != nil {
		if name := s.clientName(id); name != "" {
			return name
		}
	}

	return id
}

func (s *StatsCtx) snapshotSettings() (enabled bool, limit time.Duration, ignored *aghnet.IgnoreEngine) {
	s.confMu.RLock()
	defer s.confMu.RUnlock()

	return s.enabled, s.limit, s.ignored
}

type flowFilter struct {
	View       string
	Client     string
	Tag        string
	Protocol   string
	Status     string
	Upstream   string
	Rcode      string
	Domain     string
	Category   string
	Service    string
	FilterList string
	Reason     string
	Rule       string
	QType      string
}

func (f flowFilter) normalized() flowFilter {
	return flowFilter{
		View:       strings.TrimSpace(f.View),
		Client:     strings.TrimSpace(f.Client),
		Tag:        strings.TrimSpace(f.Tag),
		Protocol:   strings.TrimSpace(f.Protocol),
		Status:     strings.TrimSpace(f.Status),
		Upstream:   strings.TrimSpace(f.Upstream),
		Rcode:      strings.TrimSpace(f.Rcode),
		Domain:     strings.TrimSpace(f.Domain),
		Category:   strings.TrimSpace(f.Category),
		Service:    strings.TrimSpace(f.Service),
		FilterList: strings.TrimSpace(f.FilterList),
		Reason:     strings.TrimSpace(f.Reason),
		Rule:       strings.TrimSpace(f.Rule),
		QType:      strings.TrimSpace(f.QType),
	}
}

func (f flowFilter) isEmpty() bool {
	return f.Client == "" &&
		f.Tag == "" &&
		f.Protocol == "" &&
		f.Status == "" &&
		f.Upstream == "" &&
		f.Rcode == "" &&
		f.Domain == "" &&
		f.Category == "" &&
		f.Service == "" &&
		f.FilterList == "" &&
		f.Reason == "" &&
		f.Rule == "" &&
		f.QType == ""
}

func (f flowFilter) validate() error {
	switch f.Status {
	case "", "cached", "forwarded", "blocked", "rewritten", "local", "error":
	default:
		return errInvalidStatus
	}

	switch f.View {
	case "", "auto", "overview", "blocked", "content", "dns":
		return nil
	default:
		return errInvalidView
	}
}

var secondLevelCCSLDs = map[string]struct{}{
	"co": {}, "com": {}, "net": {}, "org": {}, "gov": {},
	"edu": {}, "ac": {}, "ne": {}, "or": {}, "go": {},
	"gob": {}, "mil": {},
}

func extractSite(domain string) string {
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	if host == "" {
		return ""
	}

	rawParts := strings.Split(host, ".")
	parts := rawParts[:0]
	for _, p := range rawParts {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) <= 2 {
		return strings.Join(parts, ".")
	}

	tld := parts[len(parts)-1]
	sld := parts[len(parts)-2]
	depth := 2
	if len(tld) == 2 && len(parts) >= 3 {
		if _, ok := secondLevelCCSLDs[sld]; ok {
			depth = 3
		}
	}

	return strings.Join(parts[len(parts)-depth:], ".")
}

func (s *StatsCtx) resolveDomainService(domain, explicitServiceID string) (id, name, category string) {
	if s.domainService != nil {
		id, name, category = s.domainService(domain, explicitServiceID)
	}
	if id != "" {
		if name == "" {
			name = id
		}
		if category == "" {
			category = "other"
		}
		return id, name, category
	}
	if explicitServiceID != "" {
		return explicitServiceID, explicitServiceID, "other"
	}

	site := extractSite(domain)
	if site == "" {
		return "unknown", "unknown", "other"
	}

	return "site:" + site, site, "other"
}

func (s *StatsCtx) resolveFilterList(id int64, hasFilterList bool, reason string) string {
	if s.filterListName != nil && hasFilterList {
		if name := s.filterListName(id, true, reason); name != "" {
			return name
		}
	}

	if hasFilterList {
		switch id {
		case 0:
			return "Custom filtering rules"
		case -1:
			return "/etc/hosts"
		case -2:
			return "Blocked services"
		case -3:
			return "Parental control"
		case -4:
			return "Safe Browsing"
		case -5:
			return "Safe Search"
		default:
			return "Filter #" + strconv.FormatInt(id, 10)
		}
	}

	switch reason {
	case "FilteredBlockedService":
		return "Blocked services"
	case "FilteredParental":
		return "Parental control"
	case "FilteredSafeBrowsing":
		return "Safe Browsing"
	case "FilteredSafeSearch":
		return "Safe Search"
	case "RewriteEtcHosts":
		return "/etc/hosts"
	case "FilteredBlackList", "RewriteRule", "Rewrite":
		return "Custom filtering rules"
	default:
		return "None"
	}
}

func effectiveEntryRule(se QueryLogEntry) string {
	if se.Rule != "" {
		return se.Rule
	}
	if se.ServiceName != "" {
		return se.ServiceName
	}
	if se.Reason != "" {
		return se.Reason
	}

	return "none"
}

func (f flowFilter) matches(
	se QueryLogEntry,
	resolveTag func(string) string,
	resolveService func(domain, explicitServiceID string) (id, name, category string),
	resolveFilterList func(id int64, hasFilterList bool, reason string) string,
) bool {
	if f.Domain != "" && !strings.EqualFold(se.Domain, f.Domain) {
		return false
	}

	proto := se.ClientProto
	if proto == "" {
		proto = "plain"
	}
	if f.Protocol != "" && !strings.EqualFold(proto, f.Protocol) {
		return false
	}

	status := se.Status
	if status == "" {
		status = "local"
	}
	if f.Status != "" && !strings.EqualFold(status, f.Status) {
		return false
	}

	if f.Upstream != "" && !strings.EqualFold(se.Upstream, f.Upstream) {
		return false
	}

	if f.Rcode != "" && !strings.EqualFold(se.Rcode, f.Rcode) {
		return false
	}

	qtype := se.QType
	if qtype == "" {
		qtype = "OTHER"
	}
	if f.QType != "" && !strings.EqualFold(qtype, f.QType) {
		return false
	}

	if f.Tag != "" && !strings.EqualFold(resolveTag(se.Client), f.Tag) {
		return false
	}

	if f.Reason != "" && !strings.EqualFold(se.Reason, f.Reason) {
		return false
	}

	if f.Rule != "" && !strings.EqualFold(effectiveEntryRule(se), f.Rule) {
		return false
	}

	if f.FilterList != "" {
		fl := resolveFilterList(se.FilterListID, se.HasFilterList, se.Reason)
		if !strings.EqualFold(fl, f.FilterList) {
			return false
		}
	}

	if f.Category != "" || f.Service != "" {
		svcID, svcName, svcCat := resolveService(se.Domain, se.ServiceName)
		if f.Category != "" && !strings.EqualFold(svcCat, f.Category) {
			return false
		}
		if f.Service != "" && !strings.EqualFold(svcID, f.Service) && !strings.EqualFold(svcName, f.Service) {
			return false
		}
	}

	return true
}

func resolveFlowStages(filter flowFilter) (stages []string, effectiveView string) {
	hasScope := !filter.isEmpty()
	view := filter.View
	if view == "" {
		view = "auto"
	}

	switch view {
	case "overview":
		return []string{"group", "status", "upstream", "rcode"}, "overview"
	case "auto":
		if !hasScope {
			return []string{"group", "status", "upstream", "rcode"}, "overview"
		}
		switch {
		case filter.Status == "blocked" || filter.FilterList != "" || filter.Rule != "" || filter.Reason != "":
			view = "blocked"
		case filter.Client != "" || filter.Tag != "" || filter.Category != "" || filter.Service != "" || filter.Domain != "":
			view = "content"
		case filter.Upstream != "" || filter.Rcode != "" || filter.QType != "":
			view = "dns"
		default:
			return []string{"group", "status", "upstream", "rcode"}, "overview"
		}
	}

	hasClientScope := filter.Client != "" || filter.Tag != ""
	hasContentScope := filter.Service != "" || filter.Category != ""

	switch view {
	case "blocked":
		switch {
		case filter.Domain != "":
			return []string{"client", "qtype", "rule", "rcode"}, "blocked"
		case hasClientScope && (hasContentScope || filter.Rule != ""):
			return []string{"rule", "domain", "qtype", "rcode"}, "blocked"
		case hasClientScope:
			return []string{"filter_list", "rule", "service", "domain"}, "blocked"
		case hasContentScope || filter.FilterList != "" || filter.Rule != "":
			return []string{"client", "rule", "domain", "qtype"}, "blocked"
		default:
			return []string{"client", "filter_list", "service", "domain"}, "blocked"
		}
	case "content":
		switch {
		case filter.Domain != "":
			return []string{"client", "qtype", "status", "rcode"}, "content"
		case filter.Client != "" && hasContentScope:
			return []string{"status", "domain", "qtype", "rcode"}, "content"
		case filter.Tag != "" && filter.Client == "":
			return []string{"client", "status", "service", "domain"}, "content"
		case filter.Client != "":
			return []string{"status", "category", "service", "domain"}, "content"
		default:
			return []string{"client", "status", "domain", "qtype"}, "content"
		}
	case "dns":
		switch {
		case filter.Domain != "":
			return []string{"client", "qtype", "upstream", "rcode"}, "dns"
		case filter.Upstream != "" || filter.Rcode != "":
			return []string{"client", "service", "domain", "qtype"}, "dns"
		default:
			return []string{"client", "qtype", "upstream", "rcode"}, "dns"
		}
	default:
		return []string{"group", "status", "upstream", "rcode"}, "overview"
	}
}

func (s *StatsCtx) newTagResolver() func(string) string {
	cache := map[string]string{}

	return func(clientID string) string {
		if cached, ok := cache[clientID]; ok {
			return cached
		}

		group := "untagged"
		if s.clientGroup != nil && clientID != "" {
			if g := s.clientGroup([]string{clientID}); g != "" {
				group = g
			}
		}
		cache[clientID] = group

		return group
	}
}

// buildFlow computes the 4-stage query flow diagram (adaptive across drill levels).
func (s *StatsCtx) buildFlow(
	ctx context.Context,
	window string,
	groupBy string,
	filter flowFilter,
	now time.Time,
) (*StatsFlowResp, error) {
	dur, err := parseFlowWindow(window)
	if err != nil {
		return nil, err
	}

	if groupBy != "client" && groupBy != "tag" && groupBy != "protocol" {
		return nil, errInvalidGroupBy
	}

	filter = filter.normalized()
	if err = filter.validate(); err != nil {
		return nil, err
	}

	stages, effectiveView := resolveFlowStages(filter)
	if !filter.isEmpty() && dur > 24*time.Hour {
		dur = 24 * time.Hour
	}
	since := now.Add(-dur)

	resp := &StatsFlowResp{
		From:    since.UTC().Format(time.RFC3339),
		To:      now.UTC().Format(time.RFC3339),
		GroupBy: groupBy,
		View:    effectiveView,
		Stages:  stages,
		Client:  filter.Client,
		Nodes:   []StatsFlowNode{},
		Links:   []StatsFlowLink{},
	}

	isDefaultOverview := slices.Equal(stages, []string{"group", "status", "upstream", "rcode"})
	useQueryLog := !filter.isEmpty() || !isDefaultOverview || (dur < time.Hour && s.queryLogScanner != nil)
	if useQueryLog {
		resp.Source = "querylog"
		if s.queryLogScanner == nil {
			return resp, nil
		}

		if isDefaultOverview {
			return s.buildFlowFromQueryLog(ctx, resp, since, now, groupBy, filter)
		}

		return s.buildDynamicFlowFromQueryLog(ctx, resp, since, now, groupBy, filter, stages)
	}

	resp.Source = "buckets"
	enabled, limit, _ := s.snapshotSettings()
	limitHours := uint32(limit.Hours())
	if !enabled || limitHours == 0 {
		return resp, nil
	}

	reqHours := max(uint32(1), uint32(dur/time.Hour))
	if reqHours > limitHours {
		resp.Partial = true
	}
	hours := min(reqHours, limitHours)

	units, curID := s.loadUnits(hours)
	if units == nil {
		return resp, nil
	}

	firstID := curID - hours + 1
	resp.From = time.Unix(int64(firstID)*3600, 0).UTC().Format(time.RFC3339)

	groupStatus := map[string]uint64{}
	statusUpstream := map[string]uint64{}
	statusRcode := map[string]uint64{}
	upstreamRcode := map[string]uint64{}

	for _, u := range units {
		if u.NTotal > 0 && len(u.FlowGroupStatus) == 0 && len(u.FlowClientStatus) == 0 {
			resp.Partial = true
		}

		var gs []countPair
		switch groupBy {
		case "client":
			gs = u.FlowClientStatus
		case "tag":
			gs = u.FlowGroupStatus
		case "protocol":
			gs = u.FlowProtoStatus
		}
		for _, cp := range gs {
			groupStatus[cp.Name] += cp.Count
		}
		for _, cp := range u.FlowStatusUpstream {
			statusUpstream[cp.Name] += cp.Count
		}
		for _, cp := range u.FlowStatusRcode {
			statusRcode[cp.Name] += cp.Count
		}
		for _, cp := range u.FlowUpstreamRcode {
			upstreamRcode[cp.Name] += cp.Count
		}
	}

	s.assembleFlowGraph(resp, groupBy, groupStatus, statusUpstream, statusRcode, upstreamRcode, nil)

	return resp, nil
}

func (s *StatsCtx) buildFlowFromQueryLog(
	ctx context.Context,
	resp *StatsFlowResp,
	since time.Time,
	until time.Time,
	groupBy string,
	filter flowFilter,
) (*StatsFlowResp, error) {
	groupStatus := map[string]uint64{}
	statusUpstream := map[string]uint64{}
	statusRcode := map[string]uint64{}
	upstreamRcode := map[string]uint64{}
	clientLabels := map[string]string{}
	resolveTag := s.newTagResolver()

	truncated, err := s.queryLogScanner.Scan(ctx, QueryLogScanParams{
		Since:      since,
		Until:      until,
		Client:     filter.Client,
		Domain:     filter.Domain,
		MaxEntries: maxQueryLogScanEntries,
	}, func(se QueryLogEntry) bool {
		if !filter.matches(se, resolveTag, s.resolveDomainService, s.resolveFilterList) {
			return true
		}

		var groupKey string
		switch groupBy {
		case "client":
			groupKey = se.Client
			if groupKey == "" {
				groupKey = "unknown"
			}
			if se.ClientName != "" {
				clientLabels[groupKey] = se.ClientName
			}
		case "protocol":
			groupKey = se.ClientProto
			if groupKey == "" {
				groupKey = "plain"
			}
		case "tag":
			groupKey = resolveTag(se.Client)
		}

		status := se.Status
		if status == "" {
			status = "local"
		}

		groupStatus[groupKey+flowSep+status]++

		if (status == "forwarded" || status == "error") && se.Upstream != "" {
			statusUpstream[status+flowSep+se.Upstream]++
			if se.Rcode != "" {
				upstreamRcode[se.Upstream+flowSep+se.Rcode]++
			}
		} else if se.Rcode != "" {
			statusRcode[status+flowSep+se.Rcode]++
		}

		return true
	})
	if err != nil {
		return nil, err
	}

	resp.Truncated = truncated
	s.assembleFlowGraph(resp, groupBy, groupStatus, statusUpstream, statusRcode, upstreamRcode, clientLabels)

	return resp, nil
}

func shouldCapDynamicStage(stage string) bool {
	switch stage {
	case "client", "service", "domain", "rule", "filter_list", "upstream":
		return true
	default:
		return false
	}
}

func (s *StatsCtx) extractStageValue(
	stage string,
	groupBy string,
	se QueryLogEntry,
	svcID string,
	svcName string,
	svcCategory string,
	filterList string,
	resolveTag func(string) string,
) (name, label string) {
	clientID := se.Client
	if clientID == "" {
		clientID = "unknown"
	}

	switch stage {
	case "group":
		switch groupBy {
		case "tag":
			tag := resolveTag(se.Client)
			return tag, tag
		case "protocol":
			proto := se.ClientProto
			if proto == "" {
				proto = "plain"
			}
			return proto, proto
		default:
			return clientID, s.resolveClientDisplayName(clientID, se.ClientName)
		}
	case "client":
		return clientID, s.resolveClientDisplayName(clientID, se.ClientName)
	case "status":
		st := se.Status
		if st == "" {
			st = "local"
		}
		return st, st
	case "reason":
		r := se.Reason
		if r == "" {
			r = "none"
		}
		return r, r
	case "filter_list":
		return filterList, filterList
	case "rule":
		r := effectiveEntryRule(se)
		return r, r
	case "category":
		if svcCategory == "" {
			return "other", "other"
		}
		return svcCategory, svcCategory
	case "service":
		if svcID == "" {
			return "unknown", "unknown"
		}
		if svcName == "" {
			svcName = svcID
		}
		return svcID, svcName
	case "domain":
		dom := strings.ToLower(strings.TrimSuffix(se.Domain, "."))
		if dom == "" {
			dom = "unknown"
		}
		return dom, dom
	case "qtype":
		qt := strings.ToUpper(se.QType)
		if qt == "" {
			qt = "OTHER"
		}
		return qt, qt
	case "upstream":
		up := se.Upstream
		if up == "" {
			up = "direct"
		}
		return up, up
	case "rcode":
		rc := se.Rcode
		if rc == "" {
			rc = "NONE"
		}
		return rc, rc
	default:
		return "other", "other"
	}
}

func (s *StatsCtx) buildDynamicFlowFromQueryLog(
	ctx context.Context,
	resp *StatsFlowResp,
	since time.Time,
	until time.Time,
	groupBy string,
	filter flowFilter,
	stages []string,
) (*StatsFlowResp, error) {
	numStages := len(stages)
	stageCounts := make([]map[string]uint64, numStages)
	stageLabels := make([]map[string]string, numStages)
	for i := range numStages {
		stageCounts[i] = map[string]uint64{}
		stageLabels[i] = map[string]string{}
	}
	rawEdges := make([]map[string]uint64, max(0, numStages-1))
	for i := range rawEdges {
		rawEdges[i] = map[string]uint64{}
	}

	resolveTag := s.newTagResolver()

	truncated, err := s.queryLogScanner.Scan(ctx, QueryLogScanParams{
		Since:      since,
		Until:      until,
		Client:     filter.Client,
		Domain:     filter.Domain,
		MaxEntries: maxQueryLogScanEntries,
	}, func(se QueryLogEntry) bool {
		if !filter.matches(se, resolveTag, s.resolveDomainService, s.resolveFilterList) {
			return true
		}

		resp.Total++
		svcID, svcName, svcCategory := s.resolveDomainService(se.Domain, se.ServiceName)
		filterList := s.resolveFilterList(se.FilterListID, se.HasFilterList, se.Reason)

		var prevName string
		for i, st := range stages {
			name, label := s.extractStageValue(
				st,
				groupBy,
				se,
				svcID,
				svcName,
				svcCategory,
				filterList,
				resolveTag,
			)
			stageCounts[i][name]++
			if _, exists := stageLabels[i][name]; !exists {
				stageLabels[i][name] = label
			}
			if i > 0 {
				rawEdges[i-1][prevName+flowSep+name]++
			}
			prevName = name
		}

		return true
	})
	if err != nil {
		return nil, err
	}

	resp.Truncated = truncated
	if resp.Total == 0 {
		return resp, nil
	}

	remaps := make([]map[string]string, numStages)
	for i, st := range stages {
		remaps[i] = map[string]string{}
		if !shouldCapDynamicStage(st) || len(stageCounts[i]) <= maxDynamicStageNodes {
			continue
		}

		pairs := convertMapToSlice(stageCounts[i], maxDynamicStageNodes)
		keep := make(map[string]struct{}, len(pairs))
		for _, p := range pairs {
			if p.Name != "other" {
				keep[p.Name] = struct{}{}
			}
		}

		nextCounts := make(map[string]uint64, len(keep)+1)
		for name, cnt := range stageCounts[i] {
			if _, ok := keep[name]; ok {
				nextCounts[name] += cnt
			} else {
				remaps[i][name] = "other"
				nextCounts["other"] += cnt
			}
		}
		stageCounts[i] = nextCounts
		stageLabels[i]["other"] = "other"
	}

	inCount := map[string]uint64{}
	outCount := map[string]uint64{}
	mergedEdges := make([]map[string]uint64, len(rawEdges))
	for i, edgeMap := range rawEdges {
		mergedEdges[i] = map[string]uint64{}
		for k, cnt := range edgeMap {
			srcName, dstName, ok := strings.Cut(k, flowSep)
			if !ok {
				continue
			}
			if r, exists := remaps[i][srcName]; exists {
				srcName = r
			}
			if r, exists := remaps[i+1][dstName]; exists {
				dstName = r
			}
			mergedEdges[i][srcName+flowSep+dstName] += cnt
		}
	}

	links := make([]StatsFlowLink, 0, len(rawEdges)*8)
	for i, edgeMap := range mergedEdges {
		srcStage := stages[i]
		dstStage := stages[i+1]
		for k, cnt := range edgeMap {
			srcName, dstName, ok := strings.Cut(k, flowSep)
			if !ok || cnt == 0 {
				continue
			}
			srcID := srcStage + ":" + srcName
			dstID := dstStage + ":" + dstName
			outCount[srcID] += cnt
			inCount[dstID] += cnt
			links = append(links, StatsFlowLink{
				Source:  srcID,
				Target:  dstID,
				Count:   cnt,
				Failure: dstID == "rcode:SERVFAIL" || dstID == "status:error",
			})
		}
	}

	nodes := make([]StatsFlowNode, 0, numStages*4)
	for i, st := range stages {
		for name, cnt := range stageCounts[i] {
			if cnt == 0 {
				continue
			}
			id := st + ":" + name
			label := stageLabels[i][name]
			if label == "" {
				label = name
			}
			nodes = append(nodes, StatsFlowNode{
				ID:    id,
				Stage: st,
				Name:  name,
				Label: label,
				Count: cnt,
			})
		}
	}

	stageIdx := make(map[string]int, numStages)
	for i, st := range stages {
		stageIdx[st] = i
	}

	slices.SortFunc(nodes, func(a, b StatsFlowNode) int {
		sa, sb := stageIdx[a.Stage], stageIdx[b.Stage]
		if sa != sb {
			return sa - sb
		}
		if (a.Name == "other") != (b.Name == "other") {
			if a.Name == "other" {
				return 1
			}
			return -1
		}
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Label, b.Label)
	})

	slices.SortFunc(links, func(a, b StatsFlowLink) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		if a.Source != b.Source {
			return strings.Compare(a.Source, b.Source)
		}
		return strings.Compare(a.Target, b.Target)
	})

	resp.Nodes = nodes
	resp.Links = links

	return resp, nil
}

func isInformativeReason(reason string) bool {
	return reason != "" && reason != "NotFilteredNotFound"
}

// buildFlowDetails aggregates devices, domains/URLs, rules, recent queries, and
// multi-level hierarchy tuples matching a flow drill-down filter.
func (s *StatsCtx) buildFlowDetails(
	ctx context.Context,
	window string,
	filter flowFilter,
	limit int,
	now time.Time,
) (*StatsFlowDetailsResp, error) {
	dur, err := parseFlowWindow(window)
	if err != nil {
		return nil, err
	}

	filter = filter.normalized()
	if err = filter.validate(); err != nil {
		return nil, err
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	if dur > 24*time.Hour {
		dur = 24 * time.Hour
	}
	since := now.Add(-dur)

	resp := &StatsFlowDetailsResp{
		From:    since.UTC().Format(time.RFC3339),
		To:      now.UTC().Format(time.RFC3339),
		Clients: []StatsFlowDetailsClient{},
		Domains: []StatsFlowDetailsDomain{},
		Rules:   []StatsFlowDetailsRule{},
		Recent:  []StatsFlowDetailsQuery{},
		Tuples:  []StatsFlowDetailsTuple{},
	}

	if s.queryLogScanner == nil {
		return resp, nil
	}

	type clientAgg struct {
		item StatsFlowDetailsClient
	}
	type domainAgg struct {
		item      StatsFlowDetailsDomain
		clientSet map[string]struct{}
		qtypeSet  map[string]uint64
	}
	type ruleKey struct {
		rule       string
		reason     string
		filterList string
	}
	type tupleKey struct {
		clientID    string
		clientLabel string
		tag         string
		serviceID   string
		serviceName string
		category    string
		domain      string
		filterList  string
		reason      string
		rule        string
		qtype       string
		status      string
	}
	type tupleVal struct {
		count   uint64
		blocked uint64
	}

	clientsMap := map[string]*clientAgg{}
	domainsMap := map[string]*domainAgg{}
	rulesMap := map[ruleKey]uint64{}
	tuplesMap := map[tupleKey]*tupleVal{}
	resolveTag := s.newTagResolver()

	truncated, err := s.queryLogScanner.Scan(ctx, QueryLogScanParams{
		Since:      since,
		Until:      now,
		Client:     filter.Client,
		Domain:     filter.Domain,
		MaxEntries: maxQueryLogScanEntries,
	}, func(se QueryLogEntry) bool {
		if !filter.matches(se, resolveTag, s.resolveDomainService, s.resolveFilterList) {
			return true
		}

		status := se.Status
		if status == "" {
			status = "local"
		}
		isBlocked := se.Blocked || status == "blocked"
		qtype := strings.ToUpper(se.QType)
		if qtype == "" {
			qtype = "OTHER"
		}

		resp.Total++
		if isBlocked {
			resp.Blocked++
		}

		clientID := se.Client
		if clientID == "" {
			clientID = "unknown"
		}
		clientLabel := s.resolveClientDisplayName(clientID, se.ClientName)
		clientTag := resolveTag(se.Client)

		ca, ok := clientsMap[clientID]
		if !ok {
			ca = &clientAgg{
				item: StatsFlowDetailsClient{
					ID:    clientID,
					Label: clientLabel,
					Tag:   clientTag,
				},
			}
			clientsMap[clientID] = ca
		}
		ca.item.Count++
		if isBlocked {
			ca.item.Blocked++
		}

		svcID, svcName, svcCat := s.resolveDomainService(se.Domain, se.ServiceName)
		filterList := s.resolveFilterList(se.FilterListID, se.HasFilterList, se.Reason)

		dom := strings.ToLower(strings.TrimSuffix(se.Domain, "."))
		if dom != "" {
			da, ok := domainsMap[dom]
			if !ok {
				da = &domainAgg{
					item: StatsFlowDetailsDomain{
						Domain:      dom,
						Service:     svcID,
						ServiceName: svcName,
						Category:    svcCat,
					},
					clientSet: map[string]struct{}{},
					qtypeSet:  map[string]uint64{},
				}
				domainsMap[dom] = da
			}
			da.item.Count++
			if isBlocked {
				da.item.Blocked++
			}
			da.clientSet[clientID] = struct{}{}
			da.qtypeSet[qtype]++
			if da.item.Rule == "" && se.Rule != "" {
				da.item.Rule = se.Rule
			}
			if da.item.FilterList == "" && filterList != "" && filterList != "None" {
				da.item.FilterList = filterList
			}
			if !isInformativeReason(da.item.Reason) && isInformativeReason(se.Reason) {
				da.item.Reason = se.Reason
			} else if da.item.Reason == "" && se.Reason != "" {
				da.item.Reason = se.Reason
			}
		}

		ruleText := se.Rule
		if ruleText == "" && se.ServiceName != "" {
			ruleText = se.ServiceName
		}
		if ruleText != "" || (isBlocked && se.Reason != "") {
			if ruleText == "" {
				ruleText = se.Reason
			}
			rulesMap[ruleKey{
				rule:       ruleText,
				reason:     se.Reason,
				filterList: filterList,
			}]++
		}

		tk := tupleKey{
			clientID:    clientID,
			clientLabel: clientLabel,
			tag:         clientTag,
			serviceID:   svcID,
			serviceName: svcName,
			category:    svcCat,
			domain:      dom,
			filterList:  filterList,
			reason:      se.Reason,
			rule:        effectiveEntryRule(se),
			qtype:       qtype,
			status:      status,
		}
		tv, ok := tuplesMap[tk]
		if !ok {
			tv = &tupleVal{}
			tuplesMap[tk] = tv
		}
		tv.count++
		if isBlocked {
			tv.blocked++
		}

		if len(resp.Recent) < maxFlowRecentQueries {
			resp.Recent = append(resp.Recent, StatsFlowDetailsQuery{
				Time:        se.Time.UTC().Format(time.RFC3339Nano),
				Domain:      se.Domain,
				Client:      clientID,
				ClientName:  clientLabel,
				QType:       qtype,
				Status:      status,
				Reason:      se.Reason,
				Rule:        se.Rule,
				Service:     svcID,
				ServiceName: svcName,
				Category:    svcCat,
				FilterList:  filterList,
				Upstream:    se.Upstream,
				Rcode:       se.Rcode,
				LatencyUs:   uint64(max(int64(0), se.Elapsed.Microseconds())),
			})
		}

		return true
	})
	if err != nil {
		return nil, err
	}

	resp.Truncated = truncated

	clients := make([]StatsFlowDetailsClient, 0, len(clientsMap))
	for _, ca := range clientsMap {
		clients = append(clients, ca.item)
	}
	slices.SortFunc(clients, func(a, b StatsFlowDetailsClient) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Label, b.Label)
	})
	if len(clients) > limit {
		clients = clients[:limit]
	}
	resp.Clients = clients

	domains := make([]StatsFlowDetailsDomain, 0, len(domainsMap))
	for _, da := range domainsMap {
		da.item.Clients = uint64(len(da.clientSet))
		if len(da.qtypeSet) > 0 {
			pairs := convertMapToSlice(da.qtypeSet, len(da.qtypeSet))
			qtypes := make([]string, 0, len(pairs))
			for _, p := range pairs {
				qtypes = append(qtypes, p.Name)
			}
			da.item.QTypes = qtypes
		}
		domains = append(domains, da.item)
	}
	slices.SortFunc(domains, func(a, b StatsFlowDetailsDomain) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Domain, b.Domain)
	})
	if len(domains) > limit {
		domains = domains[:limit]
	}
	resp.Domains = domains

	rules := make([]StatsFlowDetailsRule, 0, len(rulesMap))
	for rk, cnt := range rulesMap {
		rules = append(rules, StatsFlowDetailsRule{
			Rule:       rk.rule,
			Reason:     rk.reason,
			FilterList: rk.filterList,
			Count:      cnt,
		})
	}
	slices.SortFunc(rules, func(a, b StatsFlowDetailsRule) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		if a.Rule != b.Rule {
			return strings.Compare(a.Rule, b.Rule)
		}
		return strings.Compare(a.Reason, b.Reason)
	})
	if len(rules) > limit {
		rules = rules[:limit]
	}
	resp.Rules = rules

	tuples := make([]StatsFlowDetailsTuple, 0, len(tuplesMap))
	for tk, tv := range tuplesMap {
		tuples = append(tuples, StatsFlowDetailsTuple{
			ClientID:    tk.clientID,
			ClientLabel: tk.clientLabel,
			Tag:         tk.tag,
			ServiceID:   tk.serviceID,
			ServiceName: tk.serviceName,
			Category:    tk.category,
			Domain:      tk.domain,
			FilterList:  tk.filterList,
			Reason:      tk.reason,
			Rule:        tk.rule,
			QType:       tk.qtype,
			Status:      tk.status,
			Count:       tv.count,
			Blocked:     tv.blocked,
		})
	}
	slices.SortFunc(tuples, func(a, b StatsFlowDetailsTuple) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		if a.ClientLabel != b.ClientLabel {
			return strings.Compare(a.ClientLabel, b.ClientLabel)
		}
		if a.Domain != b.Domain {
			return strings.Compare(a.Domain, b.Domain)
		}
		if a.Rule != b.Rule {
			return strings.Compare(a.Rule, b.Rule)
		}
		return strings.Compare(a.QType, b.QType)
	})
	if len(tuples) > maxFlowDetailTuples {
		tuples = tuples[:maxFlowDetailTuples]
	}
	resp.Tuples = tuples

	return resp, nil
}

func (s *StatsCtx) assembleFlowGraph(
	resp *StatsFlowResp,
	groupBy string,
	groupStatus map[string]uint64,
	statusUpstream map[string]uint64,
	statusRcode map[string]uint64,
	upstreamRcode map[string]uint64,
	clientLabels map[string]string,
) {
	inCount := map[string]uint64{}
	outCount := map[string]uint64{}
	nodeMeta := map[string][2]string{} // id -> [stage, name]
	links := make([]StatsFlowLink, 0, len(groupStatus)+len(statusUpstream)+len(statusRcode)+len(upstreamRcode))

	addLink := func(srcStage, srcName, dstStage, dstName string, count uint64) {
		if count == 0 {
			return
		}
		srcID := srcStage + ":" + srcName
		dstID := dstStage + ":" + dstName
		nodeMeta[srcID] = [2]string{srcStage, srcName}
		nodeMeta[dstID] = [2]string{dstStage, dstName}
		outCount[srcID] += count
		inCount[dstID] += count
		links = append(links, StatsFlowLink{
			Source:  srcID,
			Target:  dstID,
			Count:   count,
			Failure: dstID == "rcode:SERVFAIL" || dstID == "status:error",
		})
	}

	for k, c := range groupStatus {
		g, st, ok := strings.Cut(k, flowSep)
		if !ok {
			continue
		}
		resp.Total += c
		addLink("group", g, "status", st, c)
	}
	for k, c := range statusUpstream {
		st, up, ok := strings.Cut(k, flowSep)
		if !ok {
			continue
		}
		addLink("status", st, "upstream", up, c)
	}
	for k, c := range statusRcode {
		st, rc, ok := strings.Cut(k, flowSep)
		if !ok {
			continue
		}
		addLink("status", st, "rcode", rc, c)
	}
	for k, c := range upstreamRcode {
		up, rc, ok := strings.Cut(k, flowSep)
		if !ok {
			continue
		}
		addLink("upstream", up, "rcode", rc, c)
	}

	stageOrder := map[string]int{
		"group":    0,
		"status":   1,
		"upstream": 2,
		"rcode":    3,
	}

	nodes := make([]StatsFlowNode, 0, len(nodeMeta))
	for id, meta := range nodeMeta {
		stage, name := meta[0], meta[1]
		inC := inCount[id]
		outC := outCount[id]
		cnt := max(inC, outC)
		var deadEnd uint64
		if (stage == "status" || stage == "upstream") && inC > outC {
			deadEnd = inC - outC
		}

		label := name
		if stage == "group" && groupBy == "client" {
			label = s.resolveClientDisplayName(name, clientLabels[name])
		}

		nodes = append(nodes, StatsFlowNode{
			ID:      id,
			Stage:   stage,
			Name:    name,
			Label:   label,
			Count:   cnt,
			DeadEnd: deadEnd,
		})
	}

	slices.SortFunc(nodes, func(a, b StatsFlowNode) int {
		sa, sb := stageOrder[a.Stage], stageOrder[b.Stage]
		if sa != sb {
			return sa - sb
		}
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})

	slices.SortFunc(links, func(a, b StatsFlowLink) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		if a.Source != b.Source {
			return strings.Compare(a.Source, b.Source)
		}
		return strings.Compare(a.Target, b.Target)
	})

	resp.Nodes = nodes
	resp.Links = links
}

// buildTrafficMap returns allowed and blocked domain rankings for a window.
func (s *StatsCtx) buildTrafficMap(
	window string,
	limit int,
	now time.Time,
) (*StatsTrafficMapResp, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}

	var hours uint32
	switch window {
	case "current_hour":
		hours = 1
	case "prev_hour":
		hours = 2
	case "24h":
		hours = 24
	case "7d":
		hours = 24 * 7
	case "30d":
		hours = 24 * 30
	default:
		return nil, errInvalidWindow
	}

	resp := &StatsTrafficMapResp{
		Window:  window,
		Allowed: []StatsTrafficMapItem{},
		Blocked: []StatsTrafficMapItem{},
	}

	enabled, confLimit, ignored := s.snapshotSettings()
	limitHours := uint32(confLimit.Hours())
	if !enabled || limitHours == 0 {
		resp.From = now.UTC().Format(time.RFC3339)
		resp.To = now.UTC().Format(time.RFC3339)
		return resp, nil
	}

	var units []*unitDB
	var curID uint32
	switch window {
	case "current_hour":
		units, curID = s.loadUnits(1)
		if units == nil {
			return resp, nil
		}
		resp.From = time.Unix(int64(curID)*3600, 0).UTC().Format(time.RFC3339)
		resp.To = now.UTC().Format(time.RFC3339)
	case "prev_hour":
		if limitHours < 2 {
			prevID := s.unitIDGen() - 1
			resp.From = time.Unix(int64(prevID)*3600, 0).UTC().Format(time.RFC3339)
			resp.To = time.Unix(int64(prevID+1)*3600, 0).UTC().Format(time.RFC3339)
			return resp, nil
		}
		allUnits, cid := s.loadUnits(2)
		if len(allUnits) == 0 {
			return resp, nil
		}
		curID = cid - 1
		units = allUnits[:1]
		resp.From = time.Unix(int64(curID)*3600, 0).UTC().Format(time.RFC3339)
		resp.To = time.Unix(int64(curID+1)*3600, 0).UTC().Format(time.RFC3339)
	default:
		clamped := min(hours, limitHours)
		units, curID = s.loadUnits(clamped)
		if units == nil {
			return resp, nil
		}
		firstID := curID - clamped + 1
		resp.From = time.Unix(int64(firstID)*3600, 0).UTC().Format(time.RFC3339)
		resp.To = now.UTC().Format(time.RFC3339)
	}

	allowedMap := map[string]uint64{}
	blockedMap := map[string]uint64{}
	for _, u := range units {
		for _, cp := range u.Domains {
			if !ignored.Has(cp.Name) {
				allowedMap[cp.Name] += cp.Count
			}
		}
		for _, cp := range u.BlockedDomains {
			if !ignored.Has(cp.Name) {
				blockedMap[cp.Name] += cp.Count
			}
		}
	}

	resp.Allowed = topTrafficItems(allowedMap, limit)
	resp.Blocked = topTrafficItems(blockedMap, limit)

	return resp, nil
}

func topTrafficItems(m map[string]uint64, limit int) []StatsTrafficMapItem {
	items := make([]StatsTrafficMapItem, 0, len(m))
	for k, v := range m {
		if v > 0 {
			items = append(items, StatsTrafficMapItem{Domain: k, Count: v})
		}
	}
	slices.SortFunc(items, func(a, b StatsTrafficMapItem) int {
		if a.Count != b.Count {
			if a.Count > b.Count {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Domain, b.Domain)
	})
	if len(items) > limit {
		items = items[:limit]
	}

	return items
}

// buildHeatmap computes the time-of-day rhythm heatmap for network, client, or domain.
func (s *StatsCtx) buildHeatmap(
	ctx context.Context,
	window string,
	grain string,
	kind string,
	key string,
	measure string,
	now time.Time,
) (*StatsHeatmapResp, error) {
	reqHours, err := parseHeatmapWindow(window)
	if err != nil {
		return nil, err
	}

	if kind != "network" && kind != "client" && kind != "domain" {
		return nil, errInvalidKind
	}

	if measure != "queries" && measure != "blocked" {
		return nil, errInvalidMeasure
	}

	key = strings.TrimSpace(key)
	if kind != "network" && key == "" {
		return nil, errMissingKey
	}

	if grain == "" {
		if kind == "network" && reqHours <= 24*7 {
			grain = "15m"
		} else {
			grain = "hour"
		}
	}

	var slotSeconds int
	switch grain {
	case "minute":
		if reqHours > 24*7 {
			return nil, errHeatmapGrainWindow
		}
		slotSeconds = 60
	case "15m":
		if reqHours > 24*30 {
			return nil, errHeatmapGrainWindow
		}
		slotSeconds = 900
	case "hour":
		slotSeconds = 3600
	default:
		return nil, errInvalidGrain
	}

	resp := &StatsHeatmapResp{
		To:          now.UTC().Format(time.RFC3339),
		Grain:       grain,
		Kind:        kind,
		Key:         key,
		Measure:     measure,
		SlotSeconds: slotSeconds,
		Precision:   "exact",
		Starts:      []int64{},
		Values:      []uint64{},
		Covered:     []bool{},
	}

	enabled, limit, _ := s.snapshotSettings()
	limitHours := uint32(limit.Hours())
	if !enabled || limitHours == 0 {
		resp.From = now.UTC().Format(time.RFC3339)
		return resp, nil
	}

	if reqHours > limitHours {
		resp.Partial = true
	}
	hours := min(reqHours, limitHours)

	if kind == "network" {
		return s.buildNetworkHeatmap(resp, hours, grain, measure, now), nil
	}

	canUseTopList := grain == "hour" && (kind == "domain" || measure == "queries")
	if canUseTopList {
		units, curID := s.loadUnits(hours)
		if units == nil {
			resp.From = now.UTC().Format(time.RFC3339)
			return resp, nil
		}

		firstID := curID - hours + 1
		resp.From = time.Unix(int64(firstID)*3600, 0).UTC().Format(time.RFC3339)
		resp.Precision = "top_list"

		allCovered := true
		for i, u := range units {
			hourID := firstID + uint32(i)
			resp.Starts = append(resp.Starts, int64(hourID)*3600)
			val, cov := lookupTopListHour(u, kind, key, measure)
			resp.Values = append(resp.Values, val)
			resp.Covered = append(resp.Covered, cov)
			if !cov {
				allCovered = false
			}
		}

		if allCovered || s.queryLogScanner == nil {
			return resp, nil
		}

		// Enrich uncovered hourly slots via bounded query log scan without erasing
		// covered historical top-list hours outside query log retention.
		if err := s.enrichHeatmapFromQueryLog(ctx, resp, kind, key, measure, now); err != nil {
			return nil, err
		}

		return resp, nil
	}

	// Sub-hour per-client/per-domain or per-client blocked heatmap reads query log.
	windowStart := now.Add(-time.Duration(hours) * time.Hour)
	alignedStart := (windowStart.Unix() / int64(slotSeconds)) * int64(slotSeconds)
	alignedEnd := (now.Unix() / int64(slotSeconds)) * int64(slotSeconds)
	slotCount := int((alignedEnd-alignedStart)/int64(slotSeconds)) + 1
	if slotCount > maxHeatmapSlots {
		alignedStart = alignedEnd - int64(maxHeatmapSlots-1)*int64(slotSeconds)
		slotCount = maxHeatmapSlots
	}

	resp.From = time.Unix(alignedStart, 0).UTC().Format(time.RFC3339)
	resp.Starts = make([]int64, slotCount)
	resp.Values = make([]uint64, slotCount)
	resp.Covered = make([]bool, slotCount)
	for i := range slotCount {
		resp.Starts[i] = alignedStart + int64(i)*int64(slotSeconds)
	}

	if s.queryLogScanner == nil {
		resp.Precision = "top_list"
		resp.Partial = true
		return resp, nil
	}

	resp.Precision = "querylog"
	scanParams := QueryLogScanParams{
		Since:      time.Unix(alignedStart, 0),
		Until:      now,
		MaxEntries: maxQueryLogScanEntries,
	}
	if kind == "client" {
		scanParams.Client = key
	} else {
		scanParams.Domain = key
	}

	oldestSlot := int64(0)
	var seenAny bool
	truncated, scanErr := s.queryLogScanner.Scan(ctx, scanParams, func(se QueryLogEntry) bool {
		if measure == "blocked" && !se.Blocked {
			return true
		}
		slotTS := (se.Time.Unix() / int64(slotSeconds)) * int64(slotSeconds)
		if !seenAny || slotTS < oldestSlot {
			oldestSlot = slotTS
			seenAny = true
		}
		idx := int((slotTS - alignedStart) / int64(slotSeconds))
		if idx >= 0 && idx < slotCount {
			resp.Values[idx]++
		}
		return true
	})
	if scanErr != nil {
		return nil, scanErr
	}

	resp.Truncated = truncated
	for i, st := range resp.Starts {
		if !truncated || (seenAny && st >= oldestSlot) {
			resp.Covered[i] = true
		}
	}

	return resp, nil
}

func (s *StatsCtx) buildNetworkHeatmap(
	resp *StatsHeatmapResp,
	hours uint32,
	grain string,
	measure string,
	now time.Time,
) *StatsHeatmapResp {
	units, curID := s.loadUnits(hours)
	if units == nil {
		resp.From = now.UTC().Format(time.RFC3339)
		return resp
	}

	firstID := curID - hours + 1
	resp.From = time.Unix(int64(firstID)*3600, 0).UTC().Format(time.RFC3339)
	nowUnix := now.Unix()

	for i, u := range units {
		hourStart := int64(firstID+uint32(i)) * 3600

		switch grain {
		case "hour":
			resp.Starts = append(resp.Starts, hourStart)
			resp.Values = append(resp.Values, unitMeasureTotal(u, measure))
			resp.Covered = append(resp.Covered, true)
		case "15m":
			hasMinutes := unitHasMinuteData(u)
			if u.NTotal > 0 && !hasMinutes {
				resp.Partial = true
			}
			for q := range 4 {
				slotStart := hourStart + int64(q*900)
				if slotStart > nowUnix {
					break
				}
				resp.Starts = append(resp.Starts, slotStart)
				if u.NTotal > 0 && !hasMinutes {
					resp.Values = append(resp.Values, 0)
					resp.Covered = append(resp.Covered, false)
					continue
				}
				var sum uint64
				for m := q * 15; m < (q+1)*15; m++ {
					if measure == "blocked" {
						sum += uint64(u.MinuteBlocked[m])
					} else {
						sum += uint64(u.MinuteTotal[m])
					}
				}
				resp.Values = append(resp.Values, sum)
				resp.Covered = append(resp.Covered, true)
			}
		case "minute":
			hasMinutes := unitHasMinuteData(u)
			if u.NTotal > 0 && !hasMinutes {
				resp.Partial = true
			}
			for m := range 60 {
				slotStart := hourStart + int64(m*60)
				if slotStart > nowUnix {
					break
				}
				if len(resp.Starts) >= maxHeatmapSlots {
					resp.Truncated = true
					break
				}
				resp.Starts = append(resp.Starts, slotStart)
				if u.NTotal > 0 && !hasMinutes {
					resp.Values = append(resp.Values, 0)
					resp.Covered = append(resp.Covered, false)
					continue
				}
				if measure == "blocked" {
					resp.Values = append(resp.Values, uint64(u.MinuteBlocked[m]))
				} else {
					resp.Values = append(resp.Values, uint64(u.MinuteTotal[m]))
				}
				resp.Covered = append(resp.Covered, true)
			}
		}
	}

	return resp
}

func (s *StatsCtx) enrichHeatmapFromQueryLog(
	ctx context.Context,
	resp *StatsHeatmapResp,
	kind string,
	key string,
	measure string,
	now time.Time,
) error {
	if len(resp.Starts) == 0 {
		return nil
	}

	scanParams := QueryLogScanParams{
		Since:      time.Unix(resp.Starts[0], 0),
		Until:      now,
		MaxEntries: maxQueryLogScanEntries,
	}
	if kind == "client" {
		scanParams.Client = key
	} else {
		scanParams.Domain = key
	}

	slotCounts := map[int64]uint64{}
	oldestSlot := int64(0)
	var seenAny bool

	truncated, err := s.queryLogScanner.Scan(ctx, scanParams, func(se QueryLogEntry) bool {
		if measure == "blocked" && !se.Blocked {
			return true
		}
		slotTS := (se.Time.Unix() / 3600) * 3600
		if !seenAny || slotTS < oldestSlot {
			oldestSlot = slotTS
			seenAny = true
		}
		slotCounts[slotTS]++
		return true
	})
	if err != nil {
		return err
	}

	resp.Truncated = truncated
	allCovered := true
	for i, st := range resp.Starts {
		if !resp.Covered[i] {
			if cnt, ok := slotCounts[st]; ok {
				resp.Values[i] = cnt
				resp.Covered[i] = true
			} else if seenAny && st >= oldestSlot {
				resp.Values[i] = 0
				resp.Covered[i] = true
			}
		}
		if !resp.Covered[i] {
			allCovered = false
		}
	}
	if allCovered {
		resp.Precision = "querylog"
	}

	return nil
}

func unitMeasureTotal(u *unitDB, measure string) uint64 {
	if measure == "blocked" {
		var blocked uint64
		if len(u.NResult) > int(RParental) {
			blocked += u.NResult[RFiltered] + u.NResult[RSafeBrowsing] + u.NResult[RSafeSearch] + u.NResult[RParental]
		}
		return blocked
	}

	return u.NTotal
}

func unitHasMinuteData(u *unitDB) bool {
	for _, v := range u.MinuteTotal {
		if v > 0 {
			return true
		}
	}

	return false
}

func lookupTopListHour(u *unitDB, kind, key, measure string) (val uint64, covered bool) {
	switch kind {
	case "client":
		for _, cp := range u.Clients {
			if strings.EqualFold(cp.Name, key) {
				return cp.Count, true
			}
		}
		return 0, len(u.Clients) < maxClients
	case "domain":
		if measure == "blocked" {
			for _, cp := range u.BlockedDomains {
				if strings.EqualFold(cp.Name, key) {
					return cp.Count, true
				}
			}
			return 0, len(u.BlockedDomains) < maxDomains
		}

		var sum uint64
		var foundAllowed, foundBlocked bool
		for _, cp := range u.Domains {
			if strings.EqualFold(cp.Name, key) {
				sum += cp.Count
				foundAllowed = true
				break
			}
		}
		for _, cp := range u.BlockedDomains {
			if strings.EqualFold(cp.Name, key) {
				sum += cp.Count
				foundBlocked = true
				break
			}
		}
		covered = (foundAllowed || len(u.Domains) < maxDomains) &&
			(foundBlocked || len(u.BlockedDomains) < maxDomains)
		return sum, covered
	default:
		return 0, false
	}
}

// buildLatencyHeatmap computes the time × latency bucket histogram matrix.
func (s *StatsCtx) buildLatencyHeatmap(
	window string,
	step string,
	by string,
	now time.Time,
) (*StatsLatencyHeatmapResp, error) {
	dur, err := parseLatencyWindow(window)
	if err != nil {
		return nil, err
	}

	if by != "path" && by != "upstream" {
		return nil, errInvalidBy
	}

	if step == "" {
		if dur <= 24*time.Hour {
			step = "minute"
		} else {
			step = "hour"
		}
	}

	if step != "minute" && step != "hour" {
		return nil, errInvalidStep
	}
	if step == "minute" && dur > 24*time.Hour {
		return nil, errLatencyStepWindow
	}

	resp := &StatsLatencyHeatmapResp{
		To:       now.UTC().Format(time.RFC3339),
		Step:     step,
		By:       by,
		BoundsUs: slices.Clone(latencyBoundsUs[:]),
		Starts:   []int64{},
		Series:   map[string][][]uint32{},
	}

	if by == "path" {
		for _, p := range []string{"cache", "upstream", "local", "blocked"} {
			resp.Series[p] = [][]uint32{}
		}
	}

	enabled, limit, _ := s.snapshotSettings()
	limitHours := uint32(limit.Hours())
	if !enabled || limitHours == 0 {
		resp.From = now.UTC().Format(time.RFC3339)
		return resp, nil
	}

	prefix := "path:"
	if by == "upstream" {
		prefix = "upstream:"
	}

	if step == "hour" {
		reqHours := max(uint32(1), uint32(dur/time.Hour))
		if reqHours > limitHours {
			resp.Partial = true
		}
		hours := min(reqHours, limitHours)

		units, curID := s.loadUnits(hours)
		if units == nil {
			resp.From = now.UTC().Format(time.RFC3339)
			return resp, nil
		}

		firstID := curID - hours + 1
		resp.From = time.Unix(int64(firstID)*3600, 0).UTC().Format(time.RFC3339)

		nCols := len(units)
		resp.Starts = make([]int64, nCols)
		for i := range units {
			resp.Starts[i] = int64(firstID+uint32(i)) * 3600
		}

		ensureSeries := func(name string) [][]uint32 {
			mat, ok := resp.Series[name]
			if !ok || len(mat) != nCols {
				mat = make([][]uint32, nCols)
				for c := range nCols {
					mat[c] = make([]uint32, numLatencyBuckets)
				}
				resp.Series[name] = mat
			}
			return mat
		}
		if by == "path" {
			for _, p := range []string{"cache", "upstream", "local", "blocked"} {
				ensureSeries(p)
			}
		}

		for c, u := range units {
			if u.NTotal > 0 && len(u.LatencyHist) == 0 {
				resp.Partial = true
			}
			for _, lh := range u.LatencyHist {
				name, ok := strings.CutPrefix(lh.Key, prefix)
				if !ok {
					continue
				}
				mat := ensureSeries(name)
				for b, cnt := range lh.Buckets {
					mat[c][b] += cnt
				}
			}
		}

		return resp, nil
	}

	// step == "minute"
	untilMin := (now.Unix() / 60) * 60
	sinceMin := untilMin - int64(dur/time.Minute)*60 + 60
	minLimitSec := int64(limitHours) * 3600
	if untilMin-sinceMin+60 > minLimitSec {
		sinceMin = ((now.Unix()-minLimitSec)/60)*60 + 60
		resp.Partial = true
	}

	firstHourID := uint32(sinceMin / 3600)
	lastHourID := uint32(untilMin / 3600)
	reqHours := lastHourID - firstHourID + 1
	hours := min(reqHours, limitHours)

	units, curID := s.loadUnits(hours)
	if units == nil {
		resp.From = now.UTC().Format(time.RFC3339)
		return resp, nil
	}

	loadFirstID := curID - hours + 1
	byHour := make(map[uint32]*unitDB, len(units))
	for i, u := range units {
		byHour[loadFirstID+uint32(i)] = u
	}

	nCols := int((untilMin-sinceMin)/60) + 1
	if nCols < 0 {
		nCols = 0
	}
	resp.From = time.Unix(sinceMin, 0).UTC().Format(time.RFC3339)
	resp.Starts = make([]int64, nCols)

	ensureSeries := func(name string) [][]uint32 {
		mat, ok := resp.Series[name]
		if !ok || len(mat) != nCols {
			mat = make([][]uint32, nCols)
			for c := range nCols {
				mat[c] = make([]uint32, numLatencyBuckets)
			}
			resp.Series[name] = mat
		}
		return mat
	}
	if by == "path" {
		for _, p := range []string{"cache", "upstream", "local", "blocked"} {
			ensureSeries(p)
		}
	}

	partialChecked := map[uint32]bool{}
	for c := range nCols {
		t := sinceMin + int64(c)*60
		resp.Starts[c] = t
		hid := uint32(t / 3600)
		minIdx := uint8((t % 3600) / 60)
		u := byHour[hid]
		if u == nil {
			continue
		}
		if !partialChecked[hid] {
			partialChecked[hid] = true
			if u.NTotal > 0 && len(u.LatencyHist) == 0 && len(u.MinuteLatency) == 0 {
				resp.Partial = true
			}
		}
		for _, ml := range u.MinuteLatency {
			if ml.Minute != minIdx {
				continue
			}
			name, ok := strings.CutPrefix(ml.Key, prefix)
			if !ok {
				continue
			}
			mat := ensureSeries(name)
			for _, bin := range ml.Bins {
				if int(bin.Bucket) < numLatencyBuckets {
					mat[c][bin.Bucket] += bin.Count
				}
			}
		}
	}

	return resp, nil
}

func (s *StatsCtx) listLatencyExemplars(
	window string,
	pathFilter string,
	upstreamFilter string,
	now time.Time,
) ([]LatencyExemplar, error) {
	dur, err := parseExemplarWindow(window)
	if err != nil {
		return nil, err
	}

	if pathFilter != "" &&
		pathFilter != "cache" &&
		pathFilter != "upstream" &&
		pathFilter != "local" &&
		pathFilter != "blocked" {
		return nil, errInvalidPath
	}

	sinceUs := now.Add(-dur).UnixMicro()

	s.exemplarMu.RLock()
	defer s.exemplarMu.RUnlock()

	if s.exemplars == nil {
		return []LatencyExemplar{}, nil
	}

	return s.exemplars.list(sinceUs, pathFilter, strings.TrimSpace(upstreamFilter)), nil
}
