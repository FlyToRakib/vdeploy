'use client';

import { Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface SessionRow {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastActiveAt: string;
  current: boolean;
}

function when(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'active now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/** Every signed-in device, with one-click sign-out (§20.2). */
export function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [version, setVersion] = useState(0);
  const reload = () => {
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    let current = true;
    void fetch('/api/v1/sessions')
      .then((res) => (res.ok ? (res.json() as Promise<SessionRow[]>) : null))
      .then((rows) => {
        if (current && rows) setSessions(rows);
      });
    return () => {
      current = false;
    };
  }, [version]);

  async function signOut(id: string) {
    const previous = sessions;
    setSessions((list) => list?.filter((s) => s.id !== id) ?? null);
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      setSessions(previous);
      toast.error('That device could not be signed out. Please try again.');
    }
  }

  async function signOutOthers() {
    const res = await fetch('/api/v1/sessions/revoke-others', { method: 'POST' });
    if (res.ok) toast.success('Every other device is signed out.');
    else toast.error('Other devices could not be signed out. Please try again.');
    reload();
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="font-medium">Active sessions</h2>
        <p className="text-sm text-muted-foreground">
          Devices signed in to your account. Sign out any you do not recognize.
        </p>
      </div>
      {sessions === null ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="grid divide-y divide-border">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <Monitor aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium">
                  {s.current ? 'This device' : (s.userAgent ?? 'Unknown device')}
                </p>
                <p className="text-muted-foreground">
                  {s.ipAddress ?? 'unknown IP'} · {s.current ? 'active now' : when(s.lastActiveAt)}
                </p>
              </div>
              {!s.current && (
                <Button variant="secondary" size="sm" onClick={() => void signOut(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="secondary" onClick={() => void signOutOthers()}>
          Sign out of all other devices
        </Button>
      </div>
    </Card>
  );
}
