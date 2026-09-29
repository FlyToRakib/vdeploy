#!/bin/sh
# Installs, upgrades, backs up and rolls back VDeploy's control plane (§34.1).
#
#   ./deploy/vdeploy.sh install --url https://vdeploy.example.com
#   ./deploy/vdeploy.sh install --url … --no-build   # images already loaded here
#   ./deploy/vdeploy.sh upgrade        # a dump first, then the new version
#   ./deploy/vdeploy.sh backup         # a dump, checked, beside this file
#   ./deploy/vdeploy.sh rollback       # the version and the data from before the last upgrade
#
# Run it from a checkout of the repository: the images are built from it.
# It never prints a key. The keys live in deploy/.env, which it makes once
# and never overwrites; keep a copy of that file somewhere that is not this
# server (docs/runbooks/control-plane-restore.md).

set -eu

here=$(cd "$(dirname "$0")" && pwd)
compose() { docker compose -f "$here/compose.yml" "$@"; }
say() { printf '%s\n' "$*"; }
fail() { printf 'vdeploy: %s\n' "$*" >&2; exit 1; }

hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

need_docker() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed: https://docs.docker.com/engine/install/'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose is not installed (the "docker compose" plugin).'
  docker info >/dev/null 2>&1 || fail 'Docker is installed but not answering. Is it running, and may this user use it?'
}

# Waits until the API says it is ready, or says why it is not.
wait_ready() {
  tries=0
  until compose exec -T api wget -qO- http://127.0.0.1:8080/readyz >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 90 ]; then
      compose logs --tail 30 api >&2 || true
      return 1
    fi
    sleep 2
  done
}

# A dump, read back before it is believed: pg_dump that fails its login
# exits cleanly and writes nothing, which is how a backup that never was
# gets found at restore time (§17.4).
dump() {
  mkdir -p "$here/backups"
  file="$here/backups/$1-$(date -u +%Y%m%dT%H%M%SZ).dump"
  compose exec -T db pg_dump -U vdeploy -Fc vdeploy >"$file"
  [ "$(head -c 5 "$file")" = 'PGDMP' ] || { rm -f "$file"; fail 'the database dump came out empty; nothing was changed'; }
  chmod 600 "$file"
  say "$file"
}

install() {
  url=''
  build=--build
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) url=${2:-}; shift 2 ;;
      # Images built elsewhere and loaded here (docker load): a small server
      # busy with other apps is spared the compiling.
      --no-build) build=--no-build; shift ;;
      *) fail "unknown option $1" ;;
    esac
  done
  need_docker
  if [ -f "$here/.env" ]; then
    say 'deploy/.env already exists: keeping it, and every key in it.'
  else
    [ -n "$url" ] || fail 'say where people will reach it: install --url https://vdeploy.example.com'
    case "$url" in http://* | https://*) ;; *) fail "--url must start with http:// or https://" ;; esac
    umask 077
    sed \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=$url|" \
      -e "s|^APPROVAL_KEY=.*|APPROVAL_KEY=$(hex 32)|" \
      -e "s|^SECRETS_KEY=.*|SECRETS_KEY=$(hex 32)|" \
      -e "s|^CONTROL_PLANE_KEY=.*|CONTROL_PLANE_KEY=$(hex 32)|" \
      -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(b64 48)|" \
      "$here/../apps/api/.env.example" >"$here/.env"
    printf 'POSTGRES_PASSWORD=%s\n' "$(hex 24)" >>"$here/.env"
    say 'Made deploy/.env with new keys. Copy it somewhere that is not this server:'
    say 'without SECRETS_KEY no stored secret can be opened again, by anybody.'
  fi
  compose up -d "$build"
  wait_ready || fail 'it started but is not answering; the lines above are what the API said.'
  public=$(sed -n 's/^PUBLIC_URL=//p' "$here/.env")
  say ''
  say "VDeploy is running. Put your TLS in front of 127.0.0.1:8080, then open $public"
  say 'and create the owner account. The first person to do so owns this installation.'
}

upgrade() {
  pull=1
  [ "${1:-}" = '--no-pull' ] && pull=0
  need_docker
  [ -f "$here/.env" ] || fail 'nothing is installed here yet: run install first'
  if [ "$pull" = 1 ] && [ -d "$here/../.git" ]; then
    git -C "$here/.." pull --ff-only || fail 'could not update the checkout without merging; nothing was changed'
  fi
  say 'Backing up the database first…'
  backup=$(dump pre-upgrade)
  # The version running now, kept under a name the rollback knows.
  running=$(compose images -q api 2>/dev/null | head -n 1)
  [ -n "$running" ] && docker tag "$running" vdeploy/control-plane:previous
  running_web=$(compose images -q web 2>/dev/null | head -n 1)
  [ -n "$running_web" ] && docker tag "$running_web" vdeploy/web:previous
  compose up -d --build
  if ! wait_ready; then
    say "The new version is not answering. Its data is saved in $backup;" >&2
    say './deploy/vdeploy.sh rollback puts the old version and that data back.' >&2
    exit 1
  fi
  say "Upgraded. The data from before is kept in $backup."
}

rollback() {
  need_docker
  # The names carry a UTC timestamp, so the last in glob order is the latest.
  backup=''
  for file in "$here"/backups/pre-upgrade-*.dump; do
    [ -e "$file" ] && backup=$file
  done
  [ -n "$backup" ] || fail 'there is no upgrade to go back from (no pre-upgrade dump in deploy/backups)'
  docker image inspect vdeploy/control-plane:previous >/dev/null 2>&1 || fail 'the previous version is not on this machine any more'
  say "Going back to the version before the last upgrade, and the data in $backup."
  # Migrations only go forward, so the old version needs the old data:
  # the schema it knows is the one in that dump.
  compose stop api worker web proxy
  docker tag vdeploy/control-plane:previous vdeploy/control-plane:latest
  docker image inspect vdeploy/web:previous >/dev/null 2>&1 && docker tag vdeploy/web:previous vdeploy/web:latest
  compose exec -T db dropdb -U vdeploy --if-exists vdeploy
  compose exec -T db createdb -U vdeploy vdeploy
  compose exec -T db pg_restore -U vdeploy -d vdeploy --no-owner <"$backup"
  compose up -d --no-build
  wait_ready || fail 'the previous version is not answering either; see the lines above.'
  say 'Rolled back. Anything changed since that dump was taken is not in it.'
}

case "${1:-}" in
  install) shift; install "$@" ;;
  upgrade) shift; upgrade "$@" ;;
  backup) need_docker; dump manual ;;
  rollback) rollback ;;
  *) say 'Usage: vdeploy.sh install --url <address> | upgrade [--no-pull] | backup | rollback'; exit 2 ;;
esac
