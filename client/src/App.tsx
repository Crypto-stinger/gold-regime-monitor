import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import DashboardPage from "@/pages/dashboard-page";
import BacktestPage from "@/pages/backtest-page";
import TradesPage from "@/pages/trades-page";
import AdvisorPage from "@/pages/advisor-page";
import StrategyPage from "@/pages/strategy-page";
import LiveTradingPage from "@/pages/live-trading-page";
import StrategyMindPage from "@/pages/strategy-mind-page";
import StrategyCataloguePage from "@/pages/strategy-catalogue-page";
import AdminSyncPage from "@/pages/admin-sync-page";
import SettingsPage from "@/pages/settings-page";
import LogsPage from "@/pages/logs-page";
import AuthPage from "@/pages/auth-page";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={DashboardPage} />
      <Route path="/backtest" component={BacktestPage} />
      <Route path="/trades" component={TradesPage} />
      <Route path="/advisor" component={AdvisorPage} />
      <Route path="/strategy" component={StrategyPage} />
      <Route path="/live-trading" component={LiveTradingPage} />
      <Route path="/strategy-mind" component={StrategyMindPage} />
      <Route path="/catalogue" component={StrategyCataloguePage} />
      <Route path="/admin-sync" component={AdminSyncPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/logs" component={LogsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppLayout() {
  const style = {
    "--sidebar-width": "15rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center px-4 py-2 border-b shrink-0 bg-background/95 backdrop-blur-sm">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
          </header>
          <main className="flex-1 overflow-hidden">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AuthGate() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return <AppLayout />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
