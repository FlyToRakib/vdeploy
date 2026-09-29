package router

import (
	"encoding/json"
	"strconv"

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
	allowName := key + "-allow"
	allow := network.Middleware.IPAllowList
	deny := denied(network.Middleware.IPDenyList)
	// One router per name, so each carries its own certificate settings.
	routers := object{}
	for i, d := range hosts {
		if d.TLS.Provider != CertResolver {
			continue
		}
		rule := hostMatch("HostSNI", d.Host)
		if deny != "" {
			rule = "(" + rule + ")" + deny
		}
		r := object{"rule": rule, "service": key, "entryPoints": []string{"websecure"}, "tls": tlsFor(d)}
		if len(allow) > 0 {
			r["middlewares"] = []string{allowName}
		}
		routers[key+"-"+strconv.Itoa(i)] = r
	}
	if len(routers) == 0 {
		return nil, false
	}
	tcp := object{"routers": routers, "services": tcpServices(key, traffic)}
	if len(allow) > 0 {
		tcp["middlewares"] = object{allowName: object{"ipAllowList": object{"sourceRange": allow}}}
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
