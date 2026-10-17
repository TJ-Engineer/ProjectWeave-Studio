import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const webRoot = join(process.cwd(), "apps/web");
const standaloneWebRoot = join(webRoot, ".next/standalone/apps/web");

await mkdir(join(standaloneWebRoot, ".next"), { recursive: true });
await cp(
  join(webRoot, ".next/static"),
  join(standaloneWebRoot, ".next/static"),
  {
    recursive: true,
  },
);
