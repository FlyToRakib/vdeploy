import { Skeleton } from '@/components/ui/skeleton';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function Loading() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
