package tower

import (
	"encoding/json"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

func TestTailcatIdentityAndAddressValidationOffline(t *testing.T) {
	identity := tailcat.NewPrivateKey()
	identity.Public.RegionID = 1
	address, err := privateAddress(identity.Public)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := tailcat.ParseAddr(tailcat.Addr(address))
	if err != nil || !decoded.ServerPublic.Equal(identity.Public.ServerPublic) || decoded.PresharedKey != identity.Public.PresharedKey || !decoded.ServerDiscoPublic.Equal(identity.Public.ServerDiscoPublic) {
		t.Fatal("wire format mismatch")
	}
	if err := (Tailcat{}).Validate(address); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	var restored tailcat.PrivateKey
	if err = json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Public.Addr() != identity.Public.Addr() || !restored.Private.Equal(identity.Private) {
		t.Fatal("identity not round-tripped")
	}
	for _, address := range []string{"", "tcwrong", "https://example.com"} {
		if (Tailcat{}).Validate(address) == nil {
			t.Fatal("bad address accepted")
		}
	}
	identity.Public.Region = []*tailcfg.DERPRegion{{RegionID: 1}}
	if (Tailcat{}).Validate(string(identity.Public.Addr())) == nil {
		t.Fatal("custom relay accepted")
	}
}
