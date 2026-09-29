package docker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
)

// acmeLimit is far more than a store with hundreds of certificates takes.
const acmeLimit = 16 << 20

// ErrNoCertificates means the router has not stored a certificate yet.
var ErrNoCertificates = errors.New("the router has no certificate store yet")

// ReadACME reads the router's certificate store, as Traefik wrote it, out of
// the running router through Docker's copy endpoint: no path on the host,
// and nothing started. The caller must treat the contents as secret — the
// private keys are in the same file as the certificates.
func (c *Client) ReadACME(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.base+"/containers/"+url.PathEscape(TraefikName)+"/archive?"+
			url.Values{"path": {"/acme/acme.json"}}.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("read certificates: %w", err)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("read certificates: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		return nil, ErrNoCertificates
	}
	if res.StatusCode >= 300 {
		return nil, &APIError{Status: res.StatusCode, Message: "read certificates"}
	}
	var out bytes.Buffer
	_, err = copyOneFile(res.Body, func(chunk []byte) error {
		if out.Len()+len(chunk) > acmeLimit {
			return errors.New("the certificate store is larger than any this agent expects")
		}
		out.Write(chunk)
		return nil
	})
	if errors.Is(err, ErrNoArtifact) {
		return nil, ErrNoCertificates
	}
	return out.Bytes(), err
}
