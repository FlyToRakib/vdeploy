import Link from 'next/link';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function NotFound() {
  return (
    <main className="mx-auto grid max-w-md gap-3 p-8 text-center">
      <h1 className="text-xl font-semibold">That page does not exist</h1>
      <p className="text-sm text-muted-foreground">It may have moved, or the link is incomplete.</p>
      <Link href="/" className="text-sm text-accent underline">
        Go to the overview
      </Link>
    </main>
  );
}
