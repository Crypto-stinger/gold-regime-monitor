import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const COMPILER_DIR = path.join(process.cwd(), "ctrader-compiler", "CTraderBot");

export function compileCTraderBot(csCode: string, botName: string): Buffer {
  const safeName = botName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const srcFile = path.join(COMPILER_DIR, `${safeName}.cs`);
  const algoOut = path.join(COMPILER_DIR, "cAlgo", "Sources", "Robots");
  const binOut = path.join(COMPILER_DIR, "bin", "Release", "net6.0");

  try {
    const existingCs = fs.readdirSync(COMPILER_DIR).filter(f => f.endsWith(".cs"));
    existingCs.forEach(f => fs.unlinkSync(path.join(COMPILER_DIR, f)));

    if (fs.existsSync(algoOut)) {
      fs.readdirSync(algoOut).filter(f => f.endsWith(".algo")).forEach(f => fs.unlinkSync(path.join(algoOut, f)));
    }
    if (fs.existsSync(binOut)) {
      fs.readdirSync(binOut).filter(f => f.endsWith(".algo")).forEach(f => fs.unlinkSync(path.join(binOut, f)));
    }

    fs.writeFileSync(srcFile, csCode, "utf-8");

    const csproj = path.join(COMPILER_DIR, "CTraderBot.csproj");
    const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net6.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <AssemblyName>${safeName}</AssemblyName>
    <NoWarn>CS0618;CS8618</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="cTrader.Automate" Version="1.0.16" />
  </ItemGroup>
</Project>`;
    fs.writeFileSync(csproj, csprojContent, "utf-8");

    execSync("dotnet build --configuration Release 2>&1", {
      cwd: COMPILER_DIR,
      timeout: 60000,
      stdio: "pipe",
    });

    if (fs.existsSync(algoOut)) {
      const algoFiles = fs.readdirSync(algoOut).filter(f => f.endsWith(".algo"));
      if (algoFiles.length > 0) {
        return fs.readFileSync(path.join(algoOut, algoFiles[0]));
      }
    }

    if (fs.existsSync(binOut)) {
      const binFiles = fs.readdirSync(binOut).filter(f => f.endsWith(".algo"));
      if (binFiles.length > 0) {
        return fs.readFileSync(path.join(binOut, binFiles[0]));
      }
    }

    throw new Error("Compilation succeeded but no .algo file was produced");
  } finally {
    try { fs.unlinkSync(srcFile); } catch {}
  }
}

export function isCompilerAvailable(): boolean {
  try {
    if (!fs.existsSync(COMPILER_DIR)) return false;
    if (!fs.existsSync(path.join(COMPILER_DIR, "CTraderBot.csproj"))) return false;
    execSync("dotnet --version", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
