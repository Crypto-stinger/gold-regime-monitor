import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, TrendingUp, Brain, Activity } from "lucide-react";

export default function AuthPage() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user) {
      setLocation("/");
    }
  }, [user, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-background" data-testid="auth-page">
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-amber-950/40 via-background to-background flex-col justify-between p-12">
        <div>
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-amber-500" />
            </div>
            <span className="text-xl font-bold text-amber-100">Gold Regime Lab</span>
          </div>

          <h1 className="text-4xl font-bold text-amber-50 leading-tight mb-6">
            Algorithmic Gold Trading
            <br />
            <span className="text-amber-400">Powered by AI</span>
          </h1>

          <p className="text-lg text-muted-foreground max-w-md mb-12">
            Advanced XAUUSD trading platform with regime detection, backtesting,
            live cTrader integration, and AI-driven strategy optimization.
          </p>

          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                <Brain className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold text-amber-100">AI Strategy Advisor</h3>
                <p className="text-sm text-muted-foreground">GPT-4o powered analysis with autonomous optimization and continuous learning</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                <Activity className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold text-amber-100">Live Cloud Trading</h3>
                <p className="text-sm text-muted-foreground">Direct cTrader API integration with 15 server-side trading safeguards</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                <ShieldCheck className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold text-amber-100">Risk Management</h3>
                <p className="text-sm text-muted-foreground">Comprehensive safeguards: max drawdown, daily loss limits, spread anomaly detection</p>
              </div>
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground/50">&copy; 2026 Gold Regime Lab. For authorized use only.</p>
      </div>

      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-8">
          <div className="lg:hidden flex items-center gap-3 justify-center mb-4">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-amber-500" />
            </div>
            <span className="text-xl font-bold text-amber-100">Gold Regime Lab</span>
          </div>

          <div className="text-center">
            <h2 className="text-2xl font-bold text-foreground mb-2">Welcome back</h2>
            <p className="text-muted-foreground">Sign in to access your trading platform</p>
          </div>

          <Button
            data-testid="button-login"
            className="w-full h-12 text-base bg-amber-600 hover:bg-amber-500 text-white"
            onClick={() => { window.location.href = "/api/login"; }}
          >
            Sign in with Replit
          </Button>

          <p className="text-xs text-center text-muted-foreground/60">
            Access is restricted to authorized users only.
            <br />
            This platform trades real capital via cTrader.
          </p>
        </div>
      </div>
    </div>
  );
}
