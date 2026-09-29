import {
  Cloud,
  Puzzle,
  Building2,
  Activity,
  Bell,
  Database,
  ClipboardCheck,
  FolderKanban,
  GitBranch,
  Globe,
  HardDriveDownload,
  LayoutDashboard,
  Package,
  Server,
  ShieldCheck,
  Snowflake,
  Sparkles,
  UserCog,
  type LucideIcon,
} from 'lucide-react';

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
    href: '/databases',
    label: 'Databases',
    icon: Database,
    keywords: ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'data'],
  },
  {
    href: '/approvals',
    label: 'Approvals',
    icon: ClipboardCheck,
    keywords: ['approve', 'confirm', 'waiting', 'plans'],
  },
  {
    href: '/settings/backups',
    label: 'Backups',
    icon: HardDriveDownload,
    keywords: ['offsite', 'restic', 's3', 'copies', 'restore', 'storage'],
  },
  {
    href: '/settings/status',
    label: 'Status page',
    icon: Activity,
    keywords: ['uptime', 'public', 'incidents', 'outage', 'visitors'],
  },
  {
    href: '/settings/members',
    label: 'Members',
    icon: UserCog,
    keywords: ['people', 'invite', 'roles', 'teams', 'users', 'permissions'],
  },
  {
    href: '/settings/notifications',
    label: 'Notifications',
    icon: Bell,
    keywords: ['email', 'webhook', 'alerts', 'slack', 'discord', 'telegram'],
  },
  {
    href: '/settings/freezes',
    label: 'Deploy freezes',
    icon: Snowflake,
    keywords: ['freeze', 'lock', 'holiday', 'launch', 'hold deploys', 'window'],
  },
  {
    href: '/settings/github',
    label: 'Git',
    icon: GitBranch,
    keywords: ['github', 'gitlab', 'bitbucket', 'repository', 'connect', 'push'],
  },
  {
    href: '/settings/domains',
    label: 'Domains & certificates',
    icon: Globe,
    keywords: ['instant url', 'wildcard', 'https', 'ssl', 'tls', 'cloudflare', 'dns', 'route53'],
  },
  {
    href: '/settings/registries',
    label: 'Registries',
    icon: Package,
    keywords: ['docker', 'private image', 'ghcr', 'gitlab', 'container registry', 'pull'],
  },
  {
    href: '/settings/clouds',
    label: 'Cloud accounts',
    icon: Cloud,
    keywords: ['hetzner', 'digitalocean', 'vultr', 'provision', 'vps', 'server'],
  },
  {
    href: '/settings/plugins',
    label: 'Integrations',
    icon: Puzzle,
    keywords: ['plugin', 'integration', 'api key', 'webhook', 'extend'],
  },
  {
    href: '/settings/sso',
    label: 'Company sign-in',
    icon: Building2,
    keywords: ['sso', 'saml', 'oidc', 'identity', 'okta', 'entra', 'login'],
  },
  {
    href: '/settings/ai',
    label: 'AI',
    icon: Sparkles,
    keywords: ['assistant', 'grants', 'propose', 'autopilot', 'kill switch', 'spend'],
  },
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
