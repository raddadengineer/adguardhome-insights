package querylog

import (
	"net"
	"testing"
	"time"

	"github.com/AdguardTeam/AdGuardHome/internal/filtering"
	"github.com/AdguardTeam/AdGuardHome/internal/filtering/rulelist"
	"github.com/AdguardTeam/golibs/testutil"
	"github.com/AdguardTeam/golibs/timeutil"
	"github.com/miekg/dns"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func packTestResp(tb testing.TB, host string, rcode int) []byte {
	tb.Helper()

	m := &dns.Msg{
		MsgHdr: dns.MsgHdr{
			Id:       1,
			Response: true,
			Rcode:    rcode,
		},
		Question: []dns.Question{{
			Name:   dns.Fqdn(host),
			Qtype:  dns.TypeA,
			Qclass: dns.ClassINET,
		}},
	}
	b, err := m.Pack()
	require.NoError(tb, err)

	return b
}

func TestQueryLog_Scan(t *testing.T) {
	ctx := testutil.ContextWithTimeout(t, testTimeout)
	now := time.Now().UTC().Truncate(time.Second)

	l, err := newQueryLog(Config{
		Logger:      testLogger,
		Enabled:     true,
		FileEnabled: true,
		RotationIvl: timeutil.Day,
		MemSize:     100,
		BaseDir:     t.TempDir(),
		FindClient: func(ids []string) (*Client, error) {
			for _, id := range ids {
				if id == "192.0.2.10" || id == "laptop-id" {
					return &Client{Name: "Laptop"}, nil
				}
			}
			return nil, nil
		},
	})
	require.NoError(t, err)

	diskEntries := []*logEntry{
		{
			Time:     now.Add(-3 * time.Hour),
			QHost:    "old.example.com",
			QType:    "A",
			QClass:   "IN",
			IP:       net.IPv4(192, 0, 2, 10),
			Result:   filtering.Result{Reason: filtering.NotFilteredNotFound},
			Upstream: "1.1.1.1:53",
			Answer:   packTestResp(t, "old.example.com", dns.RcodeServerFailure),
			Elapsed:  25 * time.Millisecond,
		},
		{
			Time:        now.Add(-90 * time.Minute),
			QHost:       "ads.example.org",
			QType:       "A",
			QClass:      "IN",
			ClientID:    "laptop-id",
			ClientProto: ClientProtoDoH,
			IP:          net.IPv4(192, 0, 2, 10),
			Result: filtering.Result{
				Reason:      filtering.FilteredBlockList,
				IsFiltered:  true,
				ServiceName: "ad_service",
				Rules: []*filtering.ResultRule{{
					Text:         "||ads.example.org^",
					FilterListID: rulelist.APIIDCustom,
				}},
			},
			Answer:  packTestResp(t, "ads.example.org", dns.RcodeSuccess),
			Elapsed: 200 * time.Microsecond,
		},
	}

	l.bufferLock.Lock()
	for _, e := range diskEntries {
		l.buffer.Push(e)
	}
	l.bufferLock.Unlock()
	require.NoError(t, l.flushLogBuffer(ctx))

	memEntries := []*logEntry{
		{
			Time:        now.Add(-20 * time.Minute),
			QHost:       "api.example.com",
			QType:       "AAAA",
			QClass:      "IN",
			ClientProto: ClientProtoDoT,
			IP:          net.IPv4(192, 0, 2, 20),
			Cached:      true,
			Result:      filtering.Result{Reason: filtering.NotFilteredNotFound},
			Answer:      packTestResp(t, "api.example.com", dns.RcodeNameError),
			Elapsed:     50 * time.Microsecond,
		},
		{
			Time:   now.Add(-5 * time.Minute),
			QHost:  "local.lan",
			QType:  "A",
			QClass: "IN",
			IP:     net.IPv4(192, 0, 2, 10),
			Result: filtering.Result{Reason: filtering.RewrittenAutoHosts},
			Answer: packTestResp(t, "local.lan", dns.RcodeSuccess),
		},
		{
			Time:   now.Add(-1 * time.Minute),
			QHost:  "drop.example.net",
			QType:  "A",
			QClass: "IN",
			IP:     net.IPv4(192, 0, 2, 30),
			Result: filtering.Result{Reason: filtering.NotFilteredNotFound},
		},
	}

	l.bufferLock.Lock()
	for _, e := range memEntries {
		l.buffer.Push(e)
	}
	l.bufferLock.Unlock()

	t.Run("all_in_window", func(t *testing.T) {
		var got []ScanEntry
		trunc, sErr := l.Scan(ctx, ScanParams{
			Since: now.Add(-2 * time.Hour),
			Until: now,
		}, func(se ScanEntry) bool {
			got = append(got, se)
			return true
		})
		require.NoError(t, sErr)
		assert.False(t, trunc)
		require.Len(t, got, 4)

		// Memory entries are yielded newest-first, followed by file entries newest-first.
		assert.Equal(t, "drop.example.net", got[0].Domain)
		assert.Equal(t, "error", got[0].Status)
		assert.Equal(t, "", got[0].Rcode)
		assert.Equal(t, "plain", got[0].ClientProto)

		assert.Equal(t, "local.lan", got[1].Domain)
		assert.Equal(t, "rewritten", got[1].Status)
		assert.Equal(t, "NOERROR", got[1].Rcode)
		assert.Equal(t, "A", got[1].QType)
		assert.True(t, got[1].HasFilterList)
		assert.Equal(t, int64(rulelist.APIIDEtcHosts), got[1].FilterListID)

		assert.Equal(t, "api.example.com", got[2].Domain)
		assert.Equal(t, "cached", got[2].Status)
		assert.Equal(t, "NXDOMAIN", got[2].Rcode)
		assert.Equal(t, "AAAA", got[2].QType)
		assert.False(t, got[2].HasFilterList)
		assert.Equal(t, "dot", got[2].ClientProto)

		assert.Equal(t, "ads.example.org", got[3].Domain)
		assert.Equal(t, "blocked", got[3].Status)
		assert.True(t, got[3].Blocked)
		assert.Equal(t, "FilteredBlackList", got[3].Reason)
		assert.Equal(t, "||ads.example.org^", got[3].Rule)
		assert.Equal(t, "ad_service", got[3].ServiceName)
		assert.True(t, got[3].HasFilterList)
		assert.Equal(t, int64(rulelist.APIIDCustom), got[3].FilterListID)
		assert.Equal(t, "doh", got[3].ClientProto)
		assert.Equal(t, "laptop-id", got[3].Client)
		assert.Equal(t, "Laptop", got[3].ClientName)
	})

	t.Run("client_filter_by_name_and_ip", func(t *testing.T) {
		var got []ScanEntry
		trunc, sErr := l.Scan(ctx, ScanParams{
			Since:  now.Add(-4 * time.Hour),
			Until:  now,
			Client: "laptop",
		}, func(se ScanEntry) bool {
			got = append(got, se)
			return true
		})
		require.NoError(t, sErr)
		assert.False(t, trunc)
		require.Len(t, got, 3)
		assert.Equal(t, "SERVFAIL", got[2].Rcode)
		assert.Equal(t, "forwarded", got[2].Status)
		assert.Equal(t, "1.1.1.1:53", got[2].Upstream)
	})

	t.Run("domain_filter", func(t *testing.T) {
		var got []ScanEntry
		trunc, sErr := l.Scan(ctx, ScanParams{
			Since:  now.Add(-4 * time.Hour),
			Until:  now,
			Domain: "API.EXAMPLE.COM",
		}, func(se ScanEntry) bool {
			got = append(got, se)
			return true
		})
		require.NoError(t, sErr)
		assert.False(t, trunc)
		require.Len(t, got, 1)
		assert.Equal(t, "api.example.com", got[0].Domain)
	})

	t.Run("max_entries_truncation", func(t *testing.T) {
		var got []ScanEntry
		trunc, sErr := l.Scan(ctx, ScanParams{
			Since:      now.Add(-4 * time.Hour),
			Until:      now,
			MaxEntries: 2,
		}, func(se ScanEntry) bool {
			got = append(got, se)
			return true
		})
		require.NoError(t, sErr)
		assert.True(t, trunc)
		assert.Len(t, got, 2)
	})
}
