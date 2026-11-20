package querylog

import (
	"context"
	"encoding/binary"
	"io"
	"strings"
	"time"

	"github.com/AdguardTeam/AdGuardHome/internal/filtering"
	"github.com/AdguardTeam/AdGuardHome/internal/filtering/rulelist"
	"github.com/AdguardTeam/golibs/errors"
	"github.com/AdguardTeam/golibs/logutil/slogutil"
	"github.com/miekg/dns"
)

// defaultMaxScanEntries is the safety cap for bounded query log scans.
const defaultMaxScanEntries = 200_000

// ScanEntry is a lightweight projection of a query log entry for analytics.
type ScanEntry struct {
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

// ScanParams configures a bounded read-only query log scan.
type ScanParams struct {
	Since      time.Time
	Until      time.Time
	Client     string
	Domain     string
	MaxEntries int
}

// Scanner streams matching query log entries within a bounded window.
type Scanner interface {
	Scan(ctx context.Context, params ScanParams, fn func(ScanEntry) bool) (truncated bool, err error)
}

// type check
var _ Scanner = (*queryLog)(nil)

// Scan implements the [Scanner] interface for *queryLog.
func (l *queryLog) Scan(
	ctx context.Context,
	params ScanParams,
	fn func(ScanEntry) bool,
) (truncated bool, err error) {
	if fn == nil {
		return false, nil
	}

	l.confMu.RLock()
	defer l.confMu.RUnlock()

	if !l.conf.Enabled {
		return false, nil
	}

	maxEntries := params.MaxEntries
	if maxEntries <= 0 {
		maxEntries = defaultMaxScanEntries
	}

	clientFilter := strings.ToLower(strings.TrimSpace(params.Client))
	domainFilter := strings.ToLower(strings.TrimSpace(params.Domain))
	cache := clientCache{}
	scanned := 0

	memEntries := l.snapshotBufferReverse()
	for _, e := range memEntries {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}

		if scanned >= maxEntries {
			return true, nil
		}
		scanned++

		if !inScanWindow(e.Time, params.Since, params.Until) {
			continue
		}

		if l.isIgnored(e.QHost) {
			continue
		}

		se, ok := l.enrichAndConvertScanEntry(ctx, e, cache, clientFilter, domainFilter)
		if !ok {
			continue
		}

		if !fn(se) {
			return false, nil
		}
	}

	if !l.conf.FileEnabled {
		return false, nil
	}

	files := []string{
		l.logFile + ".1",
		l.logFile,
	}

	r, err := newQLogReader(ctx, l.logger, files)
	if err != nil {
		return false, err
	}

	defer func() {
		err = errors.WithDeferred(err, r.Close())
	}()

	if err = r.SeekStart(); err != nil {
		return false, err
	}

	sinceNano := int64(0)
	if !params.Since.IsZero() {
		sinceNano = params.Since.UnixNano()
	}

	for {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}

		if scanned >= maxEntries {
			return true, nil
		}

		line, rErr := r.ReadNext()
		if rErr == io.EOF {
			break
		}
		if rErr != nil {
			l.logger.ErrorContext(ctx, "scanning querylog entry", slogutil.KeyError, rErr)
			scanned++

			continue
		}

		ts := readQLogTimestamp(ctx, l.logger, line)
		if sinceNano != 0 && ts != 0 && ts < sinceNano {
			break
		}

		scanned++

		if domainFilter != "" && !strings.Contains(strings.ToLower(line), domainFilter) {
			continue
		}

		e := &logEntry{}
		l.decodeLogEntry(ctx, e, line)

		if !inScanWindow(e.Time, params.Since, params.Until) {
			continue
		}

		if l.isIgnored(e.QHost) {
			continue
		}

		se, ok := l.enrichAndConvertScanEntry(ctx, e, cache, clientFilter, domainFilter)
		if !ok {
			continue
		}

		if !fn(se) {
			return false, nil
		}
	}

	return false, nil
}

// snapshotBufferReverse returns shallow clones of entries from the in-memory
// buffer in newest-first order.
func (l *queryLog) snapshotBufferReverse() (entries []*logEntry) {
	if l.conf.MemSize == 0 {
		return nil
	}

	l.bufferLock.RLock()
	defer l.bufferLock.RUnlock()

	entries = make([]*logEntry, 0, l.buffer.Len())
	l.buffer.ReverseRange(func(entry *logEntry) (cont bool) {
		entries = append(entries, entry.shallowClone())

		return true
	})

	return entries
}

// enrichAndConvertScanEntry resolves client metadata, checks client ignore
// settings and scan filters, and converts e to a [ScanEntry].
func (l *queryLog) enrichAndConvertScanEntry(
	ctx context.Context,
	e *logEntry,
	cache clientCache,
	clientFilter string,
	domainFilter string,
) (se ScanEntry, ok bool) {
	ipStr := ""
	if e.IP != nil {
		ipStr = e.IP.String()
	}

	var err error
	e.client, err = l.client(e.ClientID, ipStr, cache)
	if err != nil {
		l.logger.ErrorContext(
			ctx,
			"enriching scan record",
			"at", e.Time,
			"client_ip", e.IP,
			"client_id", e.ClientID,
			slogutil.KeyError, err,
		)
	}

	if e.client != nil && e.client.IgnoreQueryLog {
		return ScanEntry{}, false
	}

	if domainFilter != "" && strings.ToLower(e.QHost) != domainFilter {
		return ScanEntry{}, false
	}

	se = logEntryToScanEntry(e)
	if clientFilter != "" && !matchesClientFilter(se, ipStr, e.ClientID, clientFilter) {
		return ScanEntry{}, false
	}

	return se, true
}

func inScanWindow(t, since, until time.Time) bool {
	if !since.IsZero() && t.Before(since) {
		return false
	}
	if !until.IsZero() && t.After(until) {
		return false
	}

	return true
}

func matchesClientFilter(se ScanEntry, ipStr, clientID, filter string) bool {
	return strings.EqualFold(se.Client, filter) ||
		strings.EqualFold(ipStr, filter) ||
		(clientID != "" && strings.EqualFold(clientID, filter)) ||
		(se.ClientName != "" && strings.EqualFold(se.ClientName, filter))
}

func logEntryToScanEntry(e *logEntry) (se ScanEntry) {
	clientID := e.ClientID
	if clientID == "" && e.IP != nil {
		clientID = e.IP.String()
	}

	var clientName string
	if e.client != nil {
		clientName = e.client.Name
	}

	proto := string(e.ClientProto)
	if proto == "" {
		proto = "plain"
	}

	rcode := extractRcode(e.Answer)
	status, blocked := classifyScanStatus(e.Result.Reason, e.Cached, e.Upstream, rcode)
	reason := e.Result.Reason.String()
	var rule string
	var filterListID int64
	var hasFilterList bool
	if len(e.Result.Rules) > 0 && e.Result.Rules[0] != nil {
		rule = e.Result.Rules[0].Text
		filterListID = int64(e.Result.Rules[0].FilterListID)
		hasFilterList = true
	} else if id, ok := inferBuiltinListID(e.Result.Reason); ok {
		filterListID = int64(id)
		hasFilterList = true
	}

	return ScanEntry{
		Time:          e.Time,
		Domain:        e.QHost,
		Client:        clientID,
		ClientName:    clientName,
		ClientProto:   proto,
		QType:         e.QType,
		Status:        status,
		Upstream:      e.Upstream,
		Rcode:         rcode,
		Reason:        reason,
		Rule:          rule,
		ServiceName:   e.Result.ServiceName,
		FilterListID:  filterListID,
		HasFilterList: hasFilterList,
		Elapsed:       e.Elapsed,
		Blocked:       blocked,
	}
}

func inferBuiltinListID(reason filtering.Reason) (rulelist.APIID, bool) {
	switch reason {
	case filtering.FilteredBlockedService:
		return rulelist.APIIDBlockedService, true
	case filtering.FilteredParental:
		return rulelist.APIIDParentalControl, true
	case filtering.FilteredSafeBrowsing:
		return rulelist.APIIDSafeBrowsing, true
	case filtering.FilteredSafeSearch:
		return rulelist.APIIDSafeSearch, true
	case filtering.RewrittenAutoHosts:
		return rulelist.APIIDEtcHosts, true
	case filtering.Rewritten, filtering.RewrittenRule:
		return rulelist.APIIDCustom, true
	default:
		return 0, false
	}
}

func extractRcode(answer []byte) string {
	// DNS header is 12 bytes; bytes 2..3 carry the flags and 4-bit RCODE.
	if len(answer) < 12 {
		return ""
	}

	rcode := int(binary.BigEndian.Uint16(answer[2:4]) & 0x0F)
	if s, ok := dns.RcodeToString[rcode]; ok {
		return s
	}

	return ""
}

func classifyScanStatus(
	reason filtering.Reason,
	cached bool,
	upstream string,
	rcode string,
) (status string, blocked bool) {
	switch reason {
	case
		filtering.FilteredBlockList,
		filtering.FilteredSafeBrowsing,
		filtering.FilteredParental,
		filtering.FilteredSafeSearch,
		filtering.FilteredBlockedService,
		filtering.FilteredInvalid:
		return "blocked", true
	case
		filtering.Rewritten,
		filtering.RewrittenAutoHosts,
		filtering.RewrittenRule:
		return "rewritten", false
	default:
		switch {
		case cached:
			return "cached", false
		case upstream != "":
			return "forwarded", false
		case rcode == "":
			return "error", false
		default:
			return "local", false
		}
	}
}
