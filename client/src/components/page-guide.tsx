import { useState } from "react";
import { HelpCircle, ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";

type GuideStep = {
  title: string;
  description: string;
};

type PageGuideProps = {
  title: string;
  summary: string;
  steps: GuideStep[];
  tips?: string[];
};

export function PageGuide({ title, summary, steps, tips }: PageGuideProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-6 mt-3" data-testid="page-guide">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground gap-1.5"
        onClick={() => setOpen(!open)}
        data-testid="button-toggle-guide"
      >
        <HelpCircle className="w-3.5 h-3.5" />
        {open ? "Hide" : "How this page works"}
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </Button>

      {open && (
        <div className="mt-2 p-4 rounded-lg border border-primary/20 bg-primary/5 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{summary}</p>
          </div>

          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold shrink-0 mt-0.5">
                  {i + 1}
                </div>
                <div>
                  <div className="text-xs font-medium text-foreground">{step.title}</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">{step.description}</div>
                </div>
              </div>
            ))}
          </div>

          {tips && tips.length > 0 && (
            <div className="border-t border-primary/10 pt-2 space-y-1">
              {tips.map((tip, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <Lightbulb className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                  <span>{tip}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
