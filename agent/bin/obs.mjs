#!/usr/bin/env node
// The obs command: runs src/cli.ts through the repo's own tsx, from anywhere.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(join(root, "node_modules", ".bin", "tsx"), [join(root, "src", "cli.ts"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
