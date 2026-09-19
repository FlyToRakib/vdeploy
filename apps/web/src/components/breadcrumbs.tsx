'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeItem } from '@/lib/nav';

function titleCase(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const section = activeItem(pathname);
  const rest = section && section.href !== '/' ? pathname.slice(section.href.length) : pathname;
  const extra = rest.split('/').filter(Boolean);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 truncate text-sm">
      <ol className="flex items-center gap-1.5 text-muted-foreground">
        <li>
          <Link href={section?.href ?? '/'} className="hover:text-foreground">
            {section?.label ?? 'Overview'}
          </Link>
        </li>
        {extra.map((segment, i) => (
          <li key={segment} className="flex items-center gap-1.5">
            <span aria-hidden>›</span>
            <span
              aria-current={i === extra.length - 1 ? 'page' : undefined}
              className="text-foreground"
            >
              {titleCase(decodeURIComponent(segment))}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
