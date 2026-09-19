import { FolderKanban, LayoutDashboard, Server, ShieldCheck, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra words the command palette matches on. */
  keywords: string[];
}

/** The sections that exist. A section appears here only when its screen does. */
export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, keywords: ['home', 'status', 'health'] },
  {
    href: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    keywords: ['apps', 'sites', 'deploy'],
  },
  { href: '/servers', label: 'Servers', icon: Server, keywords: ['vps', 'machines', 'agent'] },
  {
    href: '/settings/security',
    label: 'Security',
    icon: ShieldCheck,
    keywords: ['password', 'sessions', 'devices', '2fa', 'passkey', 'sign out'],
  },
];

export function activeItem(pathname: string): NavItem | undefined {
  return [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)));
}
