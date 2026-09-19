import { FolderPlus, Server } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Status } from '@/components/ui/status';

export const metadata: Metadata = { title: 'Overview' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function OverviewPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <section aria-labelledby="health" className="flex flex-wrap items-center gap-3">
        <h1 id="health" className="text-2xl font-semibold">
          Overview
        </h1>
        <Status health="neutral">Nothing deployed yet</Status>
      </section>
      <Card className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <h2 className="font-medium">Get your first site live</h2>
          <p className="text-sm text-muted-foreground">
            Connect a server you own, then bring your app — a GitHub repository, or just a folder
            dragged in here. You get a working https:// link in minutes, no DNS needed.
          </p>
        </div>
        <ol className="grid gap-2 text-sm">
          <li>
            <Link
              href="/servers"
              className="flex items-center gap-2 rounded-md border border-border p-3 hover:bg-surface"
            >
              <Server aria-hidden className="size-4 text-accent" />
              <span>
                <span className="font-medium">1. Connect a server</span> — paste one command into
                your VPS console
              </span>
            </Link>
          </li>
          <li>
            <Link
              href="/projects"
              className="flex items-center gap-2 rounded-md border border-border p-3 hover:bg-surface"
            >
              <FolderPlus aria-hidden className="size-4 text-accent" />
              <span>
                <span className="font-medium">2. Add a project</span> — from GitHub or a folder
              </span>
            </Link>
          </li>
        </ol>
      </Card>
    </div>
  );
}
