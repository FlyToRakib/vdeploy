'use client';

import {
  DEFAULT_TRIGGERS,
  NotificationTrigger,
  TRIGGER_LABELS,
  type NotificationChannelView,
} from '@vdeploy/contracts';
import { Bell } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CopyCommand } from '@/components/copy-command';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status, type Health } from '@/components/ui/status';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago } from '@/lib/servers';

interface Delivery {
  id: string;
  channelId: string;
  title: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const DELIVERY_LOOK: Record<Delivery['status'], { health: Health; label: string }> = {
  sent: { health: 'healthy', label: 'Delivered' },
  pending: { health: 'neutral', label: 'Sending' },
  failed: { health: 'failed', label: 'Not delivered' },
};

/** "A deploy failed" → "a deploy failed"; "AI" stays "AI". */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

type Kind = NotificationChannelView['config']['kind'];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'email', label: 'Email' },
  { kind: 'slack', label: 'Slack' },
  { kind: 'discord', label: 'Discord' },
  { kind: 'telegram', label: 'Telegram' },
  { kind: 'webhook', label: 'Webhook' },
];

/** Where a channel sends, in words; a chat's address is sealed, so it is not shown. */
function target(channel: NotificationChannelView): string {
  const { config } = channel;
  switch (config.kind) {
    case 'email':
      return `Email to ${config.to.join(', ')}`;
    case 'webhook':
      return `Webhook to ${new URL(config.url).host}`;
    case 'telegram':
      return `Telegram chat ${config.chatId}`;
    case 'slack':
      return 'A Slack channel';
    case 'discord':
      return 'A Discord channel';
  }
}

/** The channel as the form describes it. */
function configFrom(kind: Kind, form: FormData): Record<string, unknown> {
  switch (kind) {
    case 'email':
      return {
        kind,
        to: formText(form, 'to')
          .split(/[,\s]+/)
          .filter(Boolean),
      };
    case 'webhook':
      return { kind, url: formText(form, 'url').trim() };
    case 'slack':
    case 'discord':
      return { kind, webhookUrl: formText(form, 'webhookUrl').trim() };
    case 'telegram':
      return {
        kind,
        botToken: formText(form, 'botToken').trim(),
        chatId: formText(form, 'chatId').trim(),
      };
  }
}

/** Where failures are told: email, chats and signed webhooks (§18, ADR 0009). */
export function Channels() {
  const stepUp = useStepUp();
  const [channels, setChannels] = useState<NotificationChannelView[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [kind, setKind] = useState<Kind>('email');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = () => {
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    void Promise.all([
      query<NotificationChannelView[]>('notification.channels'),
      query<Delivery[]>('notification.deliveries').catch(() => []),
    ]).then(
      ([list, recent]) => {
        setChannels(list);
        setDeliveries(recent);
      },
      () => {
        setChannels([]);
      },
    );
  }, [version]);

  async function run(name: string, input: Record<string, unknown>, done: string) {
    try {
      await stepUp(() => runOperation(name, input));
      toast.success(done);
      reload();
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  async function add(form: FormData) {
    setError(null);
    const triggers = NotificationTrigger.options.filter((t) => form.get(`t-${t}`) === 'on');
    const config = configFrom(kind, form);
    try {
      const outcome = await stepUp(() =>
        runOperation<{ signingSecret: string | null }>('notification.channel_create', {
          name: formText(form, 'name'),
          config,
          triggers,
        }),
      );
      if (outcome.status === 'done') setSecret(outcome.result.signingSecret);
      toast.success('Channel added. Send it a test to see it arrive.');
      reload();
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'The channel could not be added.');
      }
    }
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Notifications</h1>
      {channels === null && <Skeleton className="h-32" />}
      {channels?.length === 0 && (
        <EmptyState icon={Bell} title="No one is told yet">
          Add an email list, a chat or a webhook to hear about failed deploys, crashes and servers
          that go offline — before your visitors do.
        </EmptyState>
      )}
      {channels?.map((c) => {
        const recent = deliveries.filter((d) => d.channelId === c.id).slice(0, 5);
        return (
          <Card key={c.id} className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">{c.name}</h2>
              <Status health={c.enabled ? 'healthy' : 'neutral'}>
                {c.enabled ? 'On' : 'Paused'}
              </Status>
              <span className="text-sm break-all text-muted-foreground">{target(c)}</span>
            </div>
            <p className="text-sm">
              Told when: {c.triggers.map((t) => lowerFirst(TRIGGER_LABELS[t])).join('; ')}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void run(
                    'notification.channel_test',
                    { channelId: c.id },
                    'Test sent; it arrives within a few seconds.',
                  )
                }
              >
                Send a test
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void run(
                    'notification.channel_update',
                    { channelId: c.id, enabled: !c.enabled },
                    c.enabled ? 'Paused' : 'Turned on',
                  )
                }
              >
                {c.enabled ? 'Pause' : 'Turn on'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run('notification.channel_delete', { channelId: c.id }, 'Removed')
                }
              >
                Remove
              </Button>
            </div>
            {recent.length > 0 && (
              <ul className="grid gap-1 text-sm">
                {recent.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2">
                    <Status health={DELIVERY_LOOK[d.status].health}>
                      {DELIVERY_LOOK[d.status].label}
                    </Status>
                    <span>{d.title}</span>
                    <span className="text-muted-foreground">{ago(d.createdAt)}</span>
                    {d.lastError && <span className="text-status-failed">{d.lastError}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}

      {secret && (
        <Card className="grid gap-2 border-status-warning">
          <h2 className="font-medium">The webhook&apos;s signing secret</h2>
          <p className="text-sm">
            Shown once. Your receiver checks the <code>x-vdeploy-signature</code> header with it to
            know a message really came from VDeploy.
          </p>
          <CopyCommand command={secret} label="Copy the secret" />
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() => {
              setSecret(null);
            }}
          >
            I saved it
          </Button>
        </Card>
      )}

      <Card className="grid gap-4">
        <h2 className="font-medium">Add a channel</h2>
        <form action={add} className="grid gap-4">
          <Field label="Name" name="name" required placeholder="Team email" />
          <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-4 text-sm">
            {KINDS.map(({ kind: k, label }) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {kind === 'email' && (
            <Field
              label="Send to"
              name="to"
              required
              placeholder="you@example.com, ops@example.com"
              hint="Up to 10 addresses, separated by commas."
            />
          )}
          {kind === 'webhook' && (
            <Field
              label="Webhook address"
              name="url"
              type="url"
              required
              placeholder="https://hooks.example.com/vdeploy"
              hint="Receives a signed JSON message. Only addresses on the internet are allowed."
            />
          )}
          {(kind === 'slack' || kind === 'discord') && (
            <Field
              label={`${kind === 'slack' ? 'Slack' : 'Discord'} webhook address`}
              name="webhookUrl"
              type="password"
              required
              autoComplete="off"
              placeholder={
                kind === 'slack'
                  ? 'https://hooks.slack.com/services/…'
                  : 'https://discord.com/api/webhooks/…'
              }
              hint={
                kind === 'slack'
                  ? 'In Slack: Apps → Incoming Webhooks → Add to a channel. Anyone with this address can post there, so it is stored sealed and never shown again.'
                  : 'In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy URL. It is stored sealed and never shown again.'
              }
            />
          )}
          {kind === 'telegram' && (
            <>
              <Field
                label="Bot token"
                name="botToken"
                type="password"
                required
                autoComplete="off"
                placeholder="123456789:AA…"
                hint="From @BotFather. It is stored sealed and never shown again."
              />
              <Field
                label="Chat"
                name="chatId"
                required
                placeholder="-1001234567890 or @yourchannel"
                hint="Add the bot to the group or channel first, or it cannot post there."
              />
            </>
          )}
          <fieldset className="grid gap-2 text-sm">
            <legend className="mb-1 font-medium">Tell it when</legend>
            {NotificationTrigger.options.map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={`t-${t}`}
                  defaultChecked={DEFAULT_TRIGGERS.includes(t)}
                  className="size-4"
                />
                {TRIGGER_LABELS[t]}
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <Button type="submit" className="justify-self-start">
            Add
          </Button>
        </form>
      </Card>
    </div>
  );
}
