package build

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

/*
Static sites (§15): "built then served by a minimal container".

The agent writes the Dockerfile itself, into its own plan folder rather
than the source, so nothing the source contains can change it. What the
person chose — the folder the site is in, the command that makes it —
reaches the build as build arguments, never as text inside the file.
*/

// Pinned by tag, like the engines a database runs.
const (
	staticBuildImage = "node:22-alpine"
	// StaticServeImage serves the files: nginx, as a user that is not root,
	// on the port a static site's spec must name.
	StaticServeImage = "nginxinc/nginx-unprivileged:1.27-alpine"
)

// staticDockerfile is the Dockerfile for one static build. Build settings
// are declared so the command sees them, as it would in the app's own CI;
// each build secret is a file under /run/secrets for that one step.
func staticDockerfile(hasCommand bool, args []string, secrets []string) string {
	var b strings.Builder
	if !hasCommand {
		fmt.Fprintf(&b, "FROM %s\nARG VDEPLOY_OUTPUT\nCOPY ${VDEPLOY_OUTPUT}/ /usr/share/nginx/html/\n", StaticServeImage)
		return b.String()
	}
	fmt.Fprintf(&b, "FROM %s AS build\nWORKDIR /site\nCOPY . .\nARG VDEPLOY_BUILD_COMMAND\n", staticBuildImage)
	for _, key := range args {
		fmt.Fprintf(&b, "ARG %s\n", key)
	}
	b.WriteString("RUN")
	for _, name := range secrets {
		fmt.Fprintf(&b, " --mount=type=secret,id=%s", name)
	}
	b.WriteString(" [\"/bin/sh\", \"-c\", \"eval \\\"$VDEPLOY_BUILD_COMMAND\\\"\"]\n")
	fmt.Fprintf(&b, "FROM %s\nARG VDEPLOY_OUTPUT\nCOPY --from=build /site/${VDEPLOY_OUTPUT}/ /usr/share/nginx/html/\n", StaticServeImage)
	return b.String()
}

// writeStatic puts a static build's Dockerfile where the builder reads it.
func writeStatic(plan string, req Request, args []string) error {
	secrets := make([]string, 0, len(req.Secrets))
	for _, secret := range req.Secrets {
		secrets = append(secrets, secret.Name)
	}
	content := staticDockerfile(req.Command != "", args, secrets)
	if err := os.WriteFile(filepath.Join(plan, "Dockerfile"), []byte(content), 0o644); err != nil { // #nosec G306 -- the builder user reads it
		return fmt.Errorf("write the static Dockerfile: %w", err)
	}
	return nil
}
