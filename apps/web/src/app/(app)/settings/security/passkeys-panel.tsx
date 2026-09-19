'use client';

import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { authClient } from '@/lib/auth-client';
import { messageOf } from '@/lib/forms';

/** Passkeys: phishing-proof sign-in, recommended over passwords (§20.2). */
export function PasskeysPanel() {
  const { data: passkeys, refetch } = authClient.useListPasskeys();

  async function add() {
    const result = await authClient.passkey.addPasskey();
    if (result.error) toast.error(messageOf(result.error, 'The passkey was not added.'));
    else {
      toast.success('Passkey added.');
      void refetch();
    }
  }

  async function remove(id: string) {
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) toast.error(messageOf(error, 'The passkey was not removed.'));
    void refetch();
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="font-medium">Passkeys</h2>
        <p className="text-sm text-muted-foreground">
          Sign in with your fingerprint, face or device PIN. Passkeys cannot be phished.
        </p>
      </div>
      {passkeys && passkeys.length > 0 && (
        <ul className="grid divide-y divide-border">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-3 text-sm">
              <KeyRound aria-hidden className="size-4 text-muted-foreground" />
              <span className="flex-1">{p.name ?? 'Passkey'}</span>
              <Button variant="secondary" size="sm" onClick={() => void remove(p.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button onClick={() => void add()}>Add a passkey</Button>
      </div>
    </Card>
  );
}
