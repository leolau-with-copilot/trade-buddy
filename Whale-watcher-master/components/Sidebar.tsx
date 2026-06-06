"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, TrendingUp, Wallet, Fish, Star, BarChart2, Calendar, UserCheck, Briefcase, Activity, Database, Zap } from "lucide-react";

const nav = [
  { href: "/dashboard",  label: "Dashboard",     icon: LayoutDashboard },
  { href: "/congress",   label: "Congress",       icon: Users },
  { href: "/members",    label: "Members",        icon: UserCheck },
  { href: "/insiders",   label: "Insiders",       icon: Briefcase },
  { href: "/options",    label: "Options Flow",   icon: Activity },
  { href: "/darkpool",   label: "Dark Pool",      icon: Database },
  { href: "/signals",    label: "Signal Engine",  icon: Zap },
  { href: "/investors",  label: "Investors",      icon: TrendingUp },
  { href: "/whales",     label: "Crypto Whales",  icon: Wallet },
  { href: "/watchlist",  label: "Watchlist",      icon: Star },
  { href: "/heatmap",    label: "Heatmap",        icon: BarChart2 },
  { href: "/events",     label: "Calendar",       icon: Calendar },
];

export default function Sidebar() {
  const path = usePathname();
  return (
    <aside
      className="flex flex-col w-56 h-full shrink-0 border-r"
      style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-5 py-5 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ background: "rgba(16,217,160,0.15)" }}>
          <Fish size={16} style={{ color: "var(--green)" }} />
        </div>
        <div>
          <p className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>WhaleWatcher</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Smart Money Tracker</p>
        </div>
      </div>

      {/* Live indicator */}
      <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="pulse-dot" />
        <span className="text-xs font-medium" style={{ color: "var(--green)" }}>LIVE DATA</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 p-3 flex-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = path === href || path.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all"
              style={{
                background: active ? "rgba(16,217,160,0.1)" : "transparent",
                color: active ? "var(--green)" : "var(--text-secondary)",
                borderLeft: active ? "2px solid var(--green)" : "2px solid transparent",
              }}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t" style={{ borderColor: "var(--border)" }}>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Data from public disclosures.<br />Not financial advice.
        </p>
      </div>
    </aside>
  );
}
