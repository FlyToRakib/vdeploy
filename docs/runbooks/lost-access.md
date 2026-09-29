# Runbook — getting back in

For the person who can no longer sign in to their own VDeploy.

## Lost your authenticator, still have your password

Sign in with your password, and when asked for a code, use one of the
recovery codes you were shown when you set two-factor sign-in up. Each
works once. Then, under **Security**, set up the authenticator again.

## Lost your password, still receive email

Use **Forgot your password?** on the sign-in page. The link works once,
for a short while, and completing it signs out every session.

## Lost both — or the email never arrives

Anything the sign-in page could offer here, somebody who is not you could
try from the sign-in page too. So the way back is on the machine itself:
whoever can open a shell on the control-plane host already holds every
key VDeploy has, and this asks for nothing more than that.

On the control-plane host, in the folder that holds `deploy/compose.yml`:

```bash
docker compose -f deploy/compose.yml exec api node /app/api/dist/break-glass.js who
```

lists the people who can administer an organization, and their email.

```bash
docker compose -f deploy/compose.yml exec api node /app/api/dist/break-glass.js reset you@example.com
```

prints a new password **once**, made up for you so that it is never typed
anywhere a shell history could keep it. It also:

- turns two-factor sign-in **off** for that person,
- signs out **every** session they had, on every device,
- writes `auth.break_glass` to the audit log — who, and when; never the
  password.

Sign in with it, then under **Security** change the password and turn
two-factor sign-in back on.

## Nothing works and the control plane is gone

Your sites keep running without it. See
[control-plane-restore.md](control-plane-restore.md).
