package health

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"sort"
	"time"
)

// Certificate is one certificate the router serves: the names it covers
// and when it stops being trusted (§30 ⑦). Nothing else leaves the store —
// the private key sits beside it in the same file.
type Certificate struct {
	Hosts    []string `json:"hosts"`
	NotAfter string   `json:"notAfter"`
}

// maxCertificates keeps the report small on a server with very many hosts.
const maxCertificates = 500

// certificates reads what Traefik stored, soonest to expire first. A store
// that cannot be read yields nothing rather than an error: it is a look,
// and the rest of the look still counts.
func certificates(store []byte) []Certificate {
	// {"<resolver>": {"Certificates": [{"domain": {...}, "certificate": "<base64 PEM>", "key": "..."}]}}
	var resolvers map[string]struct {
		Certificates []struct {
			Domain struct {
				Main string   `json:"main"`
				Sans []string `json:"sans"`
			} `json:"domain"`
			Certificate string `json:"certificate"`
		} `json:"Certificates"`
	}
	if err := json.Unmarshal(store, &resolvers); err != nil {
		return []Certificate{}
	}
	out := []Certificate{}
	for _, resolver := range resolvers {
		for _, stored := range resolver.Certificates {
			chain, err := base64.StdEncoding.DecodeString(stored.Certificate)
			if err != nil {
				continue
			}
			block, _ := pem.Decode(chain)
			if block == nil {
				continue
			}
			leaf, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				continue
			}
			out = append(out, Certificate{
				Hosts:    append([]string{stored.Domain.Main}, stored.Domain.Sans...),
				NotAfter: leaf.NotAfter.UTC().Format(time.RFC3339),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NotAfter < out[j].NotAfter })
	if len(out) > maxCertificates {
		out = out[:maxCertificates]
	}
	return out
}
