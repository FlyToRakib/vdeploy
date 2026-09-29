'use client';

import { OBJECT_STORAGE_ENV } from '@vdeploy/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { secretNameFor } from '@/lib/config';
import { formText } from '@/lib/forms';
import { query } from '@/lib/operations';
import { useProject } from '../project-shell';
import { Section, useSpec } from './sections';

/** Where people keep buckets, and what each one's endpoint looks like. */
const PROVIDERS = {
  aws: { label: 'Amazon S3', endpoint: null, region: 'us-east-1' },
  r2: {
    label: 'Cloudflare R2',
    endpoint: 'https://ACCOUNT_ID.r2.cloudflarestorage.com',
    region: 'auto',
  },
  b2: {
    label: 'Backblaze B2',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
  },
  spaces: {
    label: 'DigitalOcean Spaces',
    endpoint: 'https://nyc3.digitaloceanspaces.com',
    region: 'nyc3',
  },
  other: { label: 'Another S3-compatible service', endpoint: 'https://', region: 'us-east-1' },
} as const;
type Provider = keyof typeof PROVIDERS;

const SELECT = 'h-10 rounded-md border border-border bg-surface-raised px-3 text-sm';

/**
 * Object storage (§17.1): files every copy of an app shares, which live
 * outside any one server. Either one VDeploy runs, or a bucket the person
 * already has — the app reads the same settings either way.
 */
export function ObjectStorageSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [provider, setProvider] = useState<Provider>('aws');
  const [problem, setProblem] = useState<string | null>(null);
  const env = spec.runtime.env;
  const bucket = env.find((e) => e.key === OBJECT_STORAGE_ENV.bucket);
  const endpoint = env.find((e) => e.key === OBJECT_STORAGE_ENV.endpoint);

  async function connect(form: FormData) {
    setProblem(null);
    const preset = PROVIDERS[provider];
    const url = preset.endpoint === null ? '' : formText(form, 'endpoint').trim();
    if (preset.endpoint !== null && !/^https?:\/\/[^\s/]+/.test(url)) {
      setProblem('The endpoint is an address like https://s3.example.com.');
      return;
    }
    const secretKey = formText(form, 'secretAccessKey');
    const name = secretNameFor(OBJECT_STORAGE_ENV.secretAccessKey);
    // The secret key is stored encrypted first; then every setting goes in
    // together, so the app deploys once.
    await act('secret.set', { projectId, name, value: secretKey }, 'Storing the secret key');
    const stored = await query<{ id: string; name: string }[]>('secret.list', { projectId });
    const secret = stored.find((s) => s.name === name);
    if (!secret) {
      setProblem('The secret key could not be stored, so nothing was changed.');
      return;
    }
    await act(
      'env.import',
      {
        projectId,
        entries: [
          ...(url ? [{ key: OBJECT_STORAGE_ENV.endpoint, value: url.replace(/\/+$/, '') }] : []),
          { key: OBJECT_STORAGE_ENV.region, value: formText(form, 'region').trim() },
          { key: OBJECT_STORAGE_ENV.bucket, value: formText(form, 'bucket').trim() },
          { key: OBJECT_STORAGE_ENV.accessKeyId, value: formText(form, 'accessKeyId').trim() },
          { key: OBJECT_STORAGE_ENV.secretAccessKey, secretRef: secret.id },
        ],
      },
      'Connecting the bucket',
    );
  }

  const preset = PROVIDERS[provider];
  return (
    <Section
      title="Object storage"
      hint="Files every copy of the app shares — uploads, media — kept outside any one server, through S3."
    >
      {bucket && (
        <p className="text-sm">
          Using the bucket{' '}
          <span className="font-mono">{'value' in bucket ? bucket.value : 'from a secret'}</span>
          {endpoint && 'value' in endpoint ? (
            <>
              {' '}
              at <span className="font-mono break-all">{endpoint.value}</span>
            </>
          ) : endpoint ? (
            ' that VDeploy runs'
          ) : (
            ' on Amazon S3'
          )}
          . The app reads {Object.values(OBJECT_STORAGE_ENV).join(', ')}.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        VDeploy can run one on a server, backed up like a database:{' '}
        <Link href="/databases" className="text-accent hover:underline">
          add object storage
        </Link>{' '}
        and give it to this app.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Use a bucket you already have</summary>
        <form action={(form) => void connect(form)} className="mt-3 grid gap-4">
          <label className="grid gap-1.5">
            <span className="font-medium">Where it is</span>
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as Provider);
              }}
              className={SELECT}
            >
              {Object.entries(PROVIDERS).map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset.endpoint !== null && (
            <Field
              key={`endpoint-${provider}`}
              label="Endpoint"
              name="endpoint"
              required
              defaultValue={preset.endpoint}
              hint="From the provider's S3 settings. Replace the placeholder parts with your own."
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              key={`region-${provider}`}
              label="Region"
              name="region"
              required
              defaultValue={preset.region}
            />
            <Field label="Bucket" name="bucket" required placeholder="my-app-uploads" />
          </div>
          <Field label="Access key ID" name="accessKeyId" required autoComplete="off" />
          <Field
            label="Secret access key"
            name="secretAccessKey"
            type="password"
            required
            autoComplete="off"
            hint="Stored encrypted and never shown again. A key limited to this one bucket is best."
          />
          {problem && (
            <p role="alert" className="text-status-failed">
              {problem}
            </p>
          )}
          <Button type="submit" className="justify-self-start">
            Connect
          </Button>
        </form>
      </details>
    </Section>
  );
}
