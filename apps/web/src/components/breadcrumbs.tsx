'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { activeItem } from '@/lib/nav';

type Names = Record<string, string>;
const CrumbNames = createContext<{ names: Names; setNames: Dispatch<SetStateAction<Names>> }>({
  names: {},
  setNames: () => undefined,
});

/** Holds the readable names pages give to ids in the address (srv_01… → "web-1"). */
export function CrumbNamesProvider({ children }: { children: ReactNode }) {
  const [names, setNames] = useState<Names>({});
  const value = useMemo(() => ({ names, setNames }), [names]);
  return <CrumbNames.Provider value={value}>{children}</CrumbNames.Provider>;
}

/** Shows `name` instead of `id` wherever the id appears in the breadcrumb. */
export function useCrumbName(id: string, name: string | undefined) {
  const { setNames } = useContext(CrumbNames);
  useEffect(() => {
    if (name) setNames((n) => (n[id] === name ? n : { ...n, [id]: name }));
  }, [id, name, setNames]);
}

function titleCase(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const { names } = useContext(CrumbNames);
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
              {names[segment] ?? titleCase(decodeURIComponent(segment))}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
