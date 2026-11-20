package filtering

import (
	"sync"
	"testing"

	"github.com/AdguardTeam/AdGuardHome/internal/filtering/rulelist"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLookupDomainServiceAndFilterListName(t *testing.T) {
	info, ok := LookupDomainService("www.youtube.com.")
	require.True(t, ok)
	assert.Equal(t, "youtube", info.ID)
	assert.Equal(t, "YouTube", info.Name)
	assert.Equal(t, "streaming", info.GroupID)

	byID, ok := LookupServiceByID("tiktok")
	require.True(t, ok)
	assert.Equal(t, "tiktok", byID.ID)
	assert.Equal(t, "social_network", byID.GroupID)

	_, missing := LookupDomainService("unknown-domain.example.invalid")
	assert.False(t, missing)

	d := &DNSFilter{
		conf: &Config{
			filtersMu: &sync.RWMutex{},
			Filters: []FilterYAML{
				{
					Name:   "AdGuard DNS filter",
					Filter: Filter{ID: 12345},
				},
			},
			WhitelistFilters: []FilterYAML{
				{
					Name:   "Team Allowlist",
					Filter: Filter{ID: 67890},
				},
			},
		},
	}

	assert.Equal(t, "Custom filtering rules", d.FilterListName(rulelist.APIIDCustom))
	assert.Equal(t, "Blocked services", d.FilterListName(rulelist.APIIDBlockedService))
	assert.Equal(t, "/etc/hosts", d.FilterListName(rulelist.APIIDEtcHosts))
	assert.Equal(t, "AdGuard DNS filter", d.FilterListName(12345))
	assert.Equal(t, "Team Allowlist", d.FilterListName(67890))
	assert.Equal(t, "Filter #999", d.FilterListName(999))
}
