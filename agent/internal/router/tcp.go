package router

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

/*
tcpFile renders a TCP app's routing (§13).

The router ends TLS on 443 and passes the bytes on, telling one app from
another by the name the client asked TLS for (SNI) — which is how many
apps share one port without the router understanding what they speak. So
only names with a certificate are served: a name not yet verified in DNS
has none, and is left out until it does rather than answered with a
certificate the client would refuse.

What carries over from HTTP is what does not need to read the traffic:
the addresses turned away, the addresses let in, and a blue/green switch,
which is this file changing.
*/
func tcpFile(key string, network *spec.Network, hosts []spec.Domain, traffic Traffic) ([]byte, bool) {
	var names []string
	for _, d := range hosts {
		if d.TLS.Provider == CertResolver {
			names = append(names, "HostSNI("+quote(d.Host)+")")
		}
	}
	if len(names) == 0 {
		return nil, false
	}
	rule := strings.Join(names, " || ")
	if deny := denied(network.Middleware.IPDenyList); deny != "" {
		rule = "(" + rule + ")" + deny
	}
	router := object{
		"rule": rule, "service": key, "entryPoints": []string{"websecure"},
		"tls": object{"certResolver": CertResolver},
	}
	tcp := object{"routers": object{key: router}, "services": tcpServices(key, traffic)}
	if allow := network.Middleware.IPAllowList; len(allow) > 0 {
		name := key + "-allow"
		tcp["middlewares"] = object{name: object{"ipAllowList": object{"sourceRange": allow}}}
		router["middlewares"] = []string{name}
	}
	out, _ := json.MarshalIndent(object{"tcp": tcp}, "", "  ")
	return append(out, '\n'), true
}

func tcpServices(key string, traffic Traffic) object {
	balance := func(backends []Backend) object {
		servers := make([]object, 0, len(backends))
		for _, b := range backends {
			servers = append(servers, object{"address": b.Container + ":" + strconv.Itoa(b.Port)})
		}
		return object{"loadBalancer": object{"servers": servers}}
	}
	if !traffic.splitting() {
		return object{key: balance(traffic.all())}
	}
	return object{
		key: object{"weighted": object{"services": []object{
			{"name": key + "-stable", "weight": 100 - traffic.Percent},
			{"name": key + "-new", "weight": traffic.Percent},
		}}},
		key + "-stable": balance(traffic.Backends),
		key + "-new":    balance(traffic.Canary),
	}
}
