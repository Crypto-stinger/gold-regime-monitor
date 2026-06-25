import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { BarChart3, FlaskConical, List, BookOpen, TrendingUp, Brain, Radio, ExternalLink, Eye, DatabaseBackup, Settings, ScrollText, LogOut, Library } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const navItems = [
  { title: "Dashboard", url: "/", icon: BarChart3 },
  { title: "Run Backtest", url: "/backtest", icon: FlaskConical },
  { title: "Test Log", url: "/trades", icon: List },
  { title: "AI Advisor", url: "/advisor", icon: Brain },
  { title: "Strategy", url: "/strategy", icon: BookOpen },
  { title: "Live Trading", url: "/live-trading", icon: Radio },
  { title: "Strategy Mind", url: "/strategy-mind", icon: Eye },
  { title: "Catalogue", url: "/catalogue", icon: Library },
  { title: "Activity Log", url: "/logs", icon: ScrollText },
  { title: "Settings", url: "/settings", icon: Settings },
  { title: "Data Sync", url: "/admin-sync", icon: DatabaseBackup },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center shrink-0">
            <TrendingUp className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <div className="font-semibold text-sm leading-tight">Gold Regime Lab</div>
            <div className="text-xs leading-tight text-muted-foreground">XAUUSD Strategy</div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = location === item.url || (item.url !== "/" && location.startsWith(item.url));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild data-active={isActive}>
                      <Link href={item.url}>
                        <item.icon className="w-4 h-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-4 py-3 space-y-3">
        <a
          href="https://app.ctrader.com/symbols/XAUUSD"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors group"
          data-testid="link-ctrader-web"
        >
          <TrendingUp className="w-4 h-4 text-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-primary">Open cTrader</div>
            <div className="text-[10px] text-muted-foreground">Live charts & trades</div>
          </div>
          <ExternalLink className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
        </a>
        <div className="text-xs text-muted-foreground">
          <div className="font-medium mb-0.5 text-foreground/70">Strategy Params</div>
          <div className="space-y-0.5">
            <div>Timeframe: H4 regime / H1 exec</div>
            <div>Default R:R = 4:1</div>
            <div>ATR period = 14</div>
          </div>
        </div>
        {user && (
          <div className="flex items-center gap-2 pt-2 border-t border-border/50">
            <Avatar className="w-7 h-7">
              <AvatarImage src={user.profileImageUrl || undefined} />
              <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                {(user.firstName?.[0] || user.email?.[0] || "U").toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{user.firstName || user.email || "User"}</div>
            </div>
            <a
              href="/api/logout"
              className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              data-testid="button-logout"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
