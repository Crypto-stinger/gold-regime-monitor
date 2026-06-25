import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Download, FileText, FileSpreadsheet, FileJson } from "lucide-react";
import type { BacktestResult } from "@shared/schema";

function openDownload(id: string, format: "csv" | "json" | "txt") {
  window.open(`/api/backtest/${id}/export/${format}`, "_blank");
}

export function ExportMenu({ result }: { result: BacktestResult }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-export-results">
          <Download className="w-4 h-4 mr-1.5" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs">Download Results</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => openDownload(result.id, "txt")}
          data-testid="button-export-txt"
        >
          <FileText className="w-4 h-4 mr-2 text-muted-foreground" />
          <div>
            <div className="text-sm">Summary Report</div>
            <div className="text-xs text-muted-foreground">.txt — stats & config</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => openDownload(result.id, "csv")}
          data-testid="button-export-csv"
        >
          <FileSpreadsheet className="w-4 h-4 mr-2 text-muted-foreground" />
          <div>
            <div className="text-sm">Trade Log (CSV)</div>
            <div className="text-xs text-muted-foreground">.csv — all trades</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => openDownload(result.id, "json")}
          data-testid="button-export-json"
        >
          <FileJson className="w-4 h-4 mr-2 text-muted-foreground" />
          <div>
            <div className="text-sm">Full Results (JSON)</div>
            <div className="text-xs text-muted-foreground">.json — everything</div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
