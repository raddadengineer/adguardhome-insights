package stats

import (
	"bytes"
	"context"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/AdguardTeam/AdGuardHome/internal/aghnet"
	"github.com/AdguardTeam/golibs/testutil"
	"github.com/AdguardTeam/golibs/timeutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testTimeout = 5 * time.Second

type mockScanner struct {
	entries   []QueryLogEntry
	truncated bool
}

func (m *mockScanner) Scan(
	_ context.Context,
	params QueryLogScanParams,
	fn func(QueryLogEntry) bool,
) (bool, error) {
	for _, e := range m.entries {
		if !params.Since.IsZero() && e.Time.Before(params.Since) {
			continue
		}
		if !params.Until.IsZero() && e.Time.After(params.Until) {
			continue
		}
		if params.Client != "" && e.Client != params.Client && e.ClientName != params.Client {
			continue
		}
		if params.Domain != "" && e.Domain != params.Domain {
			continue
		}
		if !fn(e) {
			return false, nil
		}
	}

	return m.truncated, nil
}

func TestObservability_GOBBackwardsCompatibility(t *testing.T) {
	// Legacy unitDB payload without any newly added observability fields.
	type legacyUnitDB struct {
		NResult            []uint64
		Domains            []countPair
		BlockedDomains     []countPair
		Clients            []countPair
		UpstreamsResponses []countPair
		UpstreamsTimeSum   []countPair
		NTotal             uint64
		TimeAvg            uint32
	}

	old := legacyUnitDB{
		NResult:        []uint64{0, 8, 2, 0, 0, 0},
		Domains:        []countPair{{Name: "example.com", Count: 8}},
		BlockedDomains: []countPair{{Name: "ads.example.com", Count: 2}},
		Clients:        []countPair{{Name: "192.168.1.2", Count: 10}},
		NTotal:         10,
		TimeAvg:        1500,
	}

	var buf bytes.Buffer
	require.NoError(t, gob.NewEncoder(&buf).Encode(old))

	var decoded unitDB
	require.NoError(t, gob.NewDecoder(&buf).Decode(&decoded))
	assert.Equal(t, uint64(10), decoded.NTotal)
	assert.Empty(t, decoded.FlowGroupStatus)
	assert.Empty(t, decoded.LatencyHist)

	curID := newUnitID()
	s := newTestStatsCtx(t, Config{
		Enabled: true,
		Limit:   timeutil.Day,
		UnitID:  func() uint32 { return curID },
	})
	testutil.CleanupAndRequireSuccess(t, s.Close)

	db := s.db.Load()
	tx, err := db.Begin(true)
	require.NoError(t, err)
	require.NoError(t, s.flushUnitToDB(&decoded, tx, curID-1))
	require.NoError(t, finishTxn(tx, true))

	ctx := testutil.ContextWithTimeout(t, testTimeout)
	now := time.Unix(int64(curID)*3600+1800, 0).UTC()

	flowResp, err := s.buildFlow(ctx, "24h", "client", flowFilter{}, now)
	require.NoError(t, err)
	assert.True(t, flowResp.Partial)

	hmResp, err := s.buildHeatmap(ctx, "24h", "15m", "network", "", "queries", now)
	require.NoError(t, err)
	assert.True(t, hmResp.Partial)

	lhResp, err := s.buildLatencyHeatmap("6h", "hour", "path", now)
	require.NoError(t, err)
	assert.True(t, lhResp.Partial)
}

func TestObservability_Flow(t *testing.T) {
	now := time.Now().UTC()
	curID := uint32(now.Unix() / 3600)

	scanner := &mockScanner{
		entries: []QueryLogEntry{
			{
				Time:        now.Add(-5 * time.Minute),
				Domain:      "app.example.com",
				Client:      "192.168.1.50",
				ClientName:  "Phone",
				ClientProto: "doh",
				Status:      "forwarded",
				Upstream:    "1.1.1.1:53",
				Rcode:       "SERVFAIL",
				Reason:      "NotFilteredNotFound",
				Elapsed:     15 * time.Millisecond,
			},
			{
				Time:        now.Add(-4 * time.Minute),
				Domain:      "cdn.example.com",
				Client:      "192.168.1.50",
				ClientName:  "Phone",
				ClientProto: "plain",
				Status:      "cached",
				Rcode:       "NOERROR",
				Reason:      "NotFilteredNotFound",
				Elapsed:     40 * time.Microsecond,
			},
			{
				Time:          now.Add(-3 * time.Minute),
				Domain:        "tracker.example.net",
				Client:        "192.168.1.50",
				ClientName:    "Phone",
				ClientProto:   "doh",
				QType:         "AAAA",
				Status:        "blocked",
				Rcode:         "NOERROR",
				Reason:        "FilteredBlackList",
				Rule:          "||tracker.example.net^",
				FilterListID:  0,
				HasFilterList: true,
				Blocked:       true,
				Elapsed:       120 * time.Microsecond,
			},
			{
				Time:          now.Add(-2 * time.Minute),
				Domain:        "ads.youtube.com",
				Client:        "192.168.1.60",
				ClientProto:   "dot",
				QType:         "HTTPS",
				Status:        "blocked",
				Rcode:         "NOERROR",
				Reason:        "FilteredBlockedService",
				ServiceName:   "youtube",
				FilterListID:  -2,
				HasFilterList: true,
				Blocked:       true,
				Elapsed:       95 * time.Microsecond,
			},
		},
		truncated: true,
	}

	s := newTestStatsCtx(t, Config{
		Enabled: true,
		Limit:   timeutil.Day,
		UnitID:  func() uint32 { return curID },
		ClientGroup: func(ids []string) string {
			for _, id := range ids {
				if id == "192.168.1.50" {
					return "mobile"
				}
			}
			return "untagged"
		},
		ClientName: func(id string) string {
			if id == "192.168.1.50" {
				return "Phone"
			}
			return ""
		},
		DomainService: func(domain, explicitServiceID string) (id, name, category string) {
			if explicitServiceID == "youtube" {
				return "youtube", "YouTube", "streaming"
			}
			return "", "", ""
		},
		QueryLogScanner: scanner,
	})
	s.Start()
	testutil.CleanupAndRequireSuccess(t, s.Close)

	s.Update(&Entry{
		Timestamp:      now,
		Client:         "192.168.1.50",
		ClientProto:    "doh",
		Domain:         "api.example.com",
		Result:         RNotFiltered,
		Status:         "forwarded",
		Upstream:       "9.9.9.9:53",
		Rcode:          "SERVFAIL",
		ProcessingTime: 30 * time.Millisecond,
	})
	s.Update(&Entry{
		Timestamp:      now,
		Client:         "192.168.1.50",
		ClientProto:    "plain",
		Domain:         "cache.example.com",
		Result:         RNotFiltered,
		Status:         "cached",
		Cached:         true,
		Rcode:          "NOERROR",
		ProcessingTime: 40 * time.Microsecond,
	})
	s.Update(&Entry{
		Timestamp:      now,
		Client:         "192.168.1.60",
		ClientProto:    "dot",
		Domain:         "ads.example.com",
		Result:         RFiltered,
		Status:         "blocked",
		Rcode:          "NXDOMAIN",
		ProcessingTime: 100 * time.Microsecond,
	})
	s.Update(&Entry{
		Timestamp:      now,
		Client:         "192.168.1.60",
		ClientProto:    "plain",
		Domain:         "fail.example.com",
		Result:         RNotFiltered,
		Status:         "error",
		ProcessingTime: 10 * time.Millisecond,
	})

	ctx := testutil.ContextWithTimeout(t, testTimeout)

	t.Run("buckets_by_client", func(t *testing.T) {
		rw := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&group_by=client", nil)
		s.handleStatsFlow(rw, req)
		require.Equal(t, http.StatusOK, rw.Code)

		var resp StatsFlowResp
		require.NoError(t, json.Unmarshal(rw.Body.Bytes(), &resp))
		assert.Equal(t, "buckets", resp.Source)
		assert.Equal(t, uint64(4), resp.Total)

		nodeByID := map[string]StatsFlowNode{}
		for _, n := range resp.Nodes {
			nodeByID[n.ID] = n
		}
		assert.Equal(t, "Phone", nodeByID["group:192.168.1.50"].Label)
		assert.Equal(t, uint64(2), nodeByID["group:192.168.1.50"].Count)
		assert.Equal(t, uint64(1), nodeByID["status:error"].DeadEnd)

		var foundServfail bool
		for _, l := range resp.Links {
			if l.Source == "upstream:9.9.9.9:53" && l.Target == "rcode:SERVFAIL" {
				foundServfail = true
				assert.True(t, l.Failure)
			}
		}
		assert.True(t, foundServfail)
	})

	t.Run("buckets_by_tag_and_protocol", func(t *testing.T) {
		tagResp, err := s.buildFlow(ctx, "24h", "tag", flowFilter{}, now)
		require.NoError(t, err)
		assert.Equal(t, uint64(4), tagResp.Total)

		var hasMobile, hasUntagged bool
		for _, n := range tagResp.Nodes {
			if n.ID == "group:mobile" {
				hasMobile = true
				assert.Equal(t, uint64(2), n.Count)
			}
			if n.ID == "group:untagged" {
				hasUntagged = true
				assert.Equal(t, uint64(2), n.Count)
			}
		}
		assert.True(t, hasMobile && hasUntagged)

		protoResp, err := s.buildFlow(ctx, "24h", "protocol", flowFilter{}, now)
		require.NoError(t, err)
		assert.Equal(t, uint64(4), protoResp.Total)
	})

	t.Run("client_mode_uses_querylog", func(t *testing.T) {
		rw := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&client=192.168.1.50", nil)
		s.handleStatsFlow(rw, req)
		require.Equal(t, http.StatusOK, rw.Code)

		var resp StatsFlowResp
		require.NoError(t, json.Unmarshal(rw.Body.Bytes(), &resp))
		assert.Equal(t, "querylog", resp.Source)
		assert.True(t, resp.Truncated)
		assert.Equal(t, uint64(3), resp.Total)
	})

	t.Run("compound_drilldown_filters_and_dynamic_stages", func(t *testing.T) {
		rw := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&status=blocked", nil)
		s.handleStatsFlow(rw, req)
		require.Equal(t, http.StatusOK, rw.Code)

		var level1 StatsFlowResp
		require.NoError(t, json.Unmarshal(rw.Body.Bytes(), &level1))
		assert.Equal(t, "querylog", level1.Source)
		assert.Equal(t, "blocked", level1.View)
		assert.Equal(t, []string{"client", "filter_list", "service", "domain"}, level1.Stages)
		assert.Equal(t, uint64(2), level1.Total)

		rw2 := httptest.NewRecorder()
		req2 := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&status=blocked&tag=mobile", nil)
		s.handleStatsFlow(rw2, req2)
		require.Equal(t, http.StatusOK, rw2.Code)

		var level2 StatsFlowResp
		require.NoError(t, json.Unmarshal(rw2.Body.Bytes(), &level2))
		assert.Equal(t, []string{"filter_list", "rule", "service", "domain"}, level2.Stages)
		assert.Equal(t, uint64(1), level2.Total)

		rw3 := httptest.NewRecorder()
		req3 := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&status=blocked&client=192.168.1.60&service=youtube", nil)
		s.handleStatsFlow(rw3, req3)
		require.Equal(t, http.StatusOK, rw3.Code)

		var level3 StatsFlowResp
		require.NoError(t, json.Unmarshal(rw3.Body.Bytes(), &level3))
		assert.Equal(t, []string{"rule", "domain", "qtype", "rcode"}, level3.Stages)
		assert.Equal(t, uint64(1), level3.Total)

		dnsLensRW := httptest.NewRecorder()
		dnsLensReq := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&view=dns", nil)
		s.handleStatsFlow(dnsLensRW, dnsLensReq)
		require.Equal(t, http.StatusOK, dnsLensRW.Code)

		var dnsLens StatsFlowResp
		require.NoError(t, json.Unmarshal(dnsLensRW.Body.Bytes(), &dnsLens))
		assert.Equal(t, "dns", dnsLens.View)
		assert.Equal(t, []string{"client", "qtype", "upstream", "rcode"}, dnsLens.Stages)
		assert.Equal(t, uint64(4), dnsLens.Total)

		badRW := httptest.NewRecorder()
		badReq := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&status=bogus", nil)
		s.handleStatsFlow(badRW, badReq)
		assert.Equal(t, http.StatusBadRequest, badRW.Code)

		badViewRW := httptest.NewRecorder()
		badViewReq := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=24h&view=bogus", nil)
		s.handleStatsFlow(badViewRW, badViewReq)
		assert.Equal(t, http.StatusBadRequest, badViewRW.Code)
	})

	t.Run("flow_details_endpoint_with_tuples", func(t *testing.T) {
		rw := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/control/stats/flow/details?window=24h&status=blocked&limit=10", nil)
		s.handleStatsFlowDetails(rw, req)
		require.Equal(t, http.StatusOK, rw.Code)

		var resp StatsFlowDetailsResp
		require.NoError(t, json.Unmarshal(rw.Body.Bytes(), &resp))
		assert.Equal(t, uint64(2), resp.Total)
		assert.Equal(t, uint64(2), resp.Blocked)
		require.Len(t, resp.Clients, 2)
		assert.Equal(t, []string{"192.168.1.60", "Phone"}, []string{resp.Clients[0].Label, resp.Clients[1].Label})
		require.Len(t, resp.Domains, 2)
		assert.Len(t, resp.Rules, 2)
		assert.Len(t, resp.Recent, 2)
		require.Len(t, resp.Tuples, 2)
		assert.Equal(t, "YouTube", resp.Tuples[0].ServiceName)
		assert.Equal(t, "streaming", resp.Tuples[0].Category)
		assert.Equal(t, "Blocked services", resp.Tuples[0].FilterList)
		assert.Equal(t, "HTTPS", resp.Tuples[0].QType)

		badRW := httptest.NewRecorder()
		badReq := httptest.NewRequest(http.MethodGet, "/control/stats/flow/details?limit=999", nil)
		s.handleStatsFlowDetails(badRW, badReq)
		assert.Equal(t, http.StatusBadRequest, badRW.Code)
	})

	t.Run("dynamic_stage_top12_folding_conserves_total", func(t *testing.T) {
		entries := make([]QueryLogEntry, 0, 15)
		for i := range 15 {
			entries = append(entries, QueryLogEntry{
				Time:          now.Add(-time.Duration(i+1) * time.Second),
				Domain:        fmt.Sprintf("sub%02d.example.com", i+1),
				Client:        "192.168.1.50",
				ClientProto:   "plain",
				QType:         "A",
				Status:        "blocked",
				Rcode:         "NOERROR",
				Reason:        "FilteredBlackList",
				Rule:          fmt.Sprintf("||sub%02d.example.com^", i+1),
				FilterListID:  0,
				HasFilterList: true,
				Blocked:       true,
			})
		}
		manyCtx := newTestStatsCtx(t, Config{
			Enabled:         true,
			Limit:           timeutil.Day,
			UnitID:          func() uint32 { return curID },
			QueryLogScanner: &mockScanner{entries: entries},
		})
		testutil.CleanupAndRequireSuccess(t, manyCtx.Close)

		resp, fErr := manyCtx.buildFlow(ctx, "24h", "client", flowFilter{Status: "blocked"}, now)
		require.NoError(t, fErr)
		assert.Equal(t, uint64(15), resp.Total)

		var domainSum uint64
		var hasOther bool
		for _, n := range resp.Nodes {
			if n.Stage == "domain" {
				domainSum += n.Count
				if n.Name == "other" {
					hasOther = true
				}
			}
		}
		assert.Equal(t, uint64(15), domainSum)
		assert.True(t, hasOther)
	})

	t.Run("top100_other_folding_preserves_total", func(t *testing.T) {
		u := newUnit(curID)
		for i := range 120 {
			u.add(&Entry{
				Timestamp: now,
				Client:    fmt.Sprintf("10.0.0.%d", i+1),
				Domain:    "example.com",
				Result:    RNotFiltered,
				Status:    "cached",
				Rcode:     "NOERROR",
			})
		}
		udb := u.serialize()
		var sum uint64
		var hasOther bool
		for _, cp := range udb.FlowClientStatus {
			sum += cp.Count
			if cp.Name == "other"+flowSep+"cached" {
				hasOther = true
				assert.Equal(t, uint64(20), cp.Count)
			}
		}
		assert.True(t, hasOther)
		assert.Equal(t, uint64(120), sum)
	})

	t.Run("invalid_params", func(t *testing.T) {
		rw := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/control/stats/flow?window=bad", nil)
		s.handleStatsFlow(rw, req)
		assert.Equal(t, http.StatusBadRequest, rw.Code)
	})
}

func TestObservability_TrafficMap(t *testing.T) {
	curID := newUnitID()
	ign, err := aghnet.NewIgnoreEngine([]string{"ignored.example"}, true)
	require.NoError(t, err)

	s := newTestStatsCtx(t, Config{
		Enabled: true,
		Limit:   7 * timeutil.Day,
		Ignored: ign,
		UnitID:  func() uint32 { return curID },
	})
	testutil.CleanupAndRequireSuccess(t, s.Close)

	prevUnit := &unitDB{
		NResult:        make([]uint64, resultLast),
		Domains:        []countPair{{Name: "prev.example.com", Count: 5}},
		BlockedDomains: []countPair{{Name: "prev-ad.example.com", Count: 3}},
		NTotal:         8,
	}
	db := s.db.Load()
	tx, err := db.Begin(true)
	require.NoError(t, err)
	require.NoError(t, s.flushUnitToDB(prevUnit, tx, curID-1))
	require.NoError(t, finishTxn(tx, true))

	s.Update(&Entry{Client: "192.168.1.2", Domain: "now.example.com", Result: RNotFiltered})
	s.Update(&Entry{Client: "192.168.1.2", Domain: "ignored.example", Result: RNotFiltered})
	s.Update(&Entry{Client: "192.168.1.2", Domain: "ads.example.com", Result: RFiltered})

	rw := httptest.NewRecorder()
	s.handleStatsTrafficMap(rw, httptest.NewRequest(http.MethodGet, "/control/stats/traffic_map?window=current_hour&limit=10", nil))
	require.Equal(t, http.StatusOK, rw.Code)

	var currResp StatsTrafficMapResp
	require.NoError(t, json.Unmarshal(rw.Body.Bytes(), &currResp))
	assert.Equal(t, []StatsTrafficMapItem{{Domain: "now.example.com", Count: 1}}, currResp.Allowed)
	assert.Equal(t, []StatsTrafficMapItem{{Domain: "ads.example.com", Count: 1}}, currResp.Blocked)

	rwPrev := httptest.NewRecorder()
	s.handleStatsTrafficMap(rwPrev, httptest.NewRequest(http.MethodGet, "/control/stats/traffic_map?window=prev_hour", nil))
	require.Equal(t, http.StatusOK, rwPrev.Code)

	var prevResp StatsTrafficMapResp
	require.NoError(t, json.Unmarshal(rwPrev.Body.Bytes(), &prevResp))
	assert.Equal(t, []StatsTrafficMapItem{{Domain: "prev.example.com", Count: 5}}, prevResp.Allowed)
	assert.Equal(t, []StatsTrafficMapItem{{Domain: "prev-ad.example.com", Count: 3}}, prevResp.Blocked)

	rwBad := httptest.NewRecorder()
	s.handleStatsTrafficMap(rwBad, httptest.NewRequest(http.MethodGet, "/control/stats/traffic_map?limit=999", nil))
	assert.Equal(t, http.StatusBadRequest, rwBad.Code)
}

func TestObservability_HeatmapAndLatency(t *testing.T) {
	now := time.Now().UTC()
	hourStart := now.Truncate(time.Hour)
	curID := uint32(now.Unix() / 3600)

	scanner := &mockScanner{
		entries: []QueryLogEntry{
			{
				Time:    now.Add(-20 * time.Minute),
				Domain:  "rare.example.com",
				Client:  "192.168.1.99",
				Status:  "blocked",
				Blocked: true,
			},
		},
	}

	s := newTestStatsCtx(t, Config{
		Enabled:         true,
		Limit:           7 * timeutil.Day,
		UnitID:          func() uint32 { return curID },
		DomainService: func(domain, explicitServiceID string) (id, name, category string) {
			if explicitServiceID == "youtube" {
				return "youtube", "YouTube", "streaming"
			}
			return "", "", ""
		},
		QueryLogScanner: scanner,
	})
	s.Start()
	testutil.CleanupAndRequireSuccess(t, s.Close)

	s.Update(&Entry{
		Timestamp:      hourStart,
		Client:         "192.168.1.10",
		Domain:         "fast.example.com",
		Result:         RNotFiltered,
		Status:         "cached",
		Cached:         true,
		ProcessingTime: 40 * time.Microsecond, // bucket 0
	})
	s.Update(&Entry{
		Timestamp:      hourStart,
		Client:         "192.168.1.10",
		Domain:         "upstream.example.com",
		Result:         RNotFiltered,
		Status:         "forwarded",
		Upstream:       "1.1.1.1:53",
		ProcessingTime: 30 * time.Millisecond, // bucket 9 (<= 50 ms)
	})
	s.Update(&Entry{
		Timestamp:      now,
		Client:         "192.168.1.10",
		Domain:         "slow.example.com",
		Result:         RNotFiltered,
		Status:         "forwarded",
		Upstream:       "1.1.1.1:53",
		ProcessingTime: 6 * time.Second, // bucket 16 (> 5 s)
	})

	ctx := testutil.ContextWithTimeout(t, testTimeout)

	t.Run("network_heatmap_grains", func(t *testing.T) {
		hm15, err := s.buildHeatmap(ctx, "24h", "15m", "network", "", "queries", now)
		require.NoError(t, err)
		assert.Equal(t, 900, hm15.SlotSeconds)
		var total uint64
		for _, v := range hm15.Values {
			total += v
		}
		assert.Equal(t, uint64(3), total)

		hmMin, err := s.buildHeatmap(ctx, "24h", "minute", "network", "", "queries", now)
		require.NoError(t, err)
		assert.Equal(t, 60, hmMin.SlotSeconds)

		// Validation checks
		_, err = s.buildHeatmap(ctx, "30d", "minute", "network", "", "queries", now)
		assert.ErrorIs(t, err, errHeatmapGrainWindow)
		_, err = s.buildHeatmap(ctx, "24h", "hour", "client", "", "queries", now)
		assert.ErrorIs(t, err, errMissingKey)
	})

	t.Run("client_blocked_heatmap_uses_querylog", func(t *testing.T) {
		hm, err := s.buildHeatmap(ctx, "24h", "hour", "client", "192.168.1.99", "blocked", now)
		require.NoError(t, err)
		assert.Equal(t, "querylog", hm.Precision)
		var total uint64
		for _, v := range hm.Values {
			total += v
		}
		assert.Equal(t, uint64(1), total)
	})

	t.Run("latency_heatmap_and_exemplars", func(t *testing.T) {
		lhPath, err := s.buildLatencyHeatmap("1h", "minute", "path", now)
		require.NoError(t, err)
		require.Len(t, lhPath.Starts, 60)

		var cacheB0, upB9, upB16 uint32
		for _, col := range lhPath.Series["cache"] {
			cacheB0 += col[0]
		}
		for _, col := range lhPath.Series["upstream"] {
			upB9 += col[9]
			upB16 += col[16]
		}
		assert.Equal(t, uint32(1), cacheB0)
		assert.Equal(t, uint32(1), upB9)
		assert.Equal(t, uint32(1), upB16)

		lhUp, err := s.buildLatencyHeatmap("24h", "hour", "upstream", now)
		require.NoError(t, err)
		require.Contains(t, lhUp.Series, "1.1.1.1:53")

		rw := httptest.NewRecorder()
		s.handleStatsLatencyExemplars(rw, httptest.NewRequest(http.MethodGet, "/control/stats/latency_exemplars?window=6h&path=upstream", nil))
		require.Equal(t, http.StatusOK, rw.Code)

		var exResp StatsLatencyExemplarsResp
		require.NoError(t, json.Unmarshal(rw.Body.Bytes(), &exResp))
		assert.Len(t, exResp.Items, 2)
		assert.Equal(t, "slow.example.com", exResp.Items[0].Domain)
	})

	t.Run("exemplar_ring_cap_and_ratelimit_and_clear", func(t *testing.T) {
		r := newExemplarRing()
		base := time.Now().Unix()
		for i := range 600 {
			// Same second & same bucket -> throttled to 1; advancing sec allows insertion.
			r.add(LatencyExemplar{
				TsUnixMicros: (base + int64(i)) * 1_000_000,
				Path:         "upstream",
				Domain:       fmt.Sprintf("d-%d.example", i),
			}, base+int64(i), 0)
			r.add(LatencyExemplar{
				TsUnixMicros: (base + int64(i)) * 1_000_000,
				Path:         "upstream",
				Domain:       "dup.example",
			}, base+int64(i), 0)
		}
		items := r.list(0, "", "")
		assert.Len(t, items, maxExemplars)
		assert.Equal(t, "d-599.example", items[0].Domain)

		require.NoError(t, s.clear())
		cleared, err := s.listLatencyExemplars("6h", "", "", now)
		require.NoError(t, err)
		assert.Empty(t, cleared)
	})
}

func TestObservability_ConcurrentRaces(t *testing.T) {
	now := time.Now().UTC()
	curID := uint32(now.Unix() / 3600)
	s := newTestStatsCtx(t, Config{
		Enabled: true,
		Limit:   timeutil.Day,
		UnitID:  func() uint32 { return curID },
	})
	s.Start()
	testutil.CleanupAndRequireSuccess(t, s.Close)

	var wg sync.WaitGroup
	for w := range 6 {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := range 50 {
				s.Update(&Entry{
					Timestamp:      now,
					Client:         fmt.Sprintf("10.1.0.%d", id),
					Domain:         fmt.Sprintf("d%d.example", i),
					Result:         RNotFiltered,
					Status:         "forwarded",
					Upstream:       "1.1.1.1:53",
					Rcode:          "NOERROR",
					ProcessingTime: time.Duration(i+1) * time.Millisecond,
				})
			}
		}(w)
	}

	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				_, _ = s.buildFlow(context.Background(), "24h", "client", flowFilter{}, now)
				_, _ = s.buildHeatmap(context.Background(), "24h", "15m", "network", "", "queries", now)
				_, _ = s.buildLatencyHeatmap("6h", "minute", "path", now)
				_, _ = s.listLatencyExemplars("6h", "", "", now)
			}
		}()
	}

	wg.Wait()
}
