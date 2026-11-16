import {
  cp,
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  rename,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, ".tabularium"), "utf8"));
const temp = await mkdtemp(join(tmpdir(), "tabularis-neon-package-"));
// Stage on the destination filesystem so the final rename also works across mount points.
const archiveStage = await mkdtemp(join(root, ".package-"));
const pendingArchive = join(archiveStage, "bundle.zip");
try {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error("Run packaging through pnpm package");
  const pnpmScript = /\.[cm]?js$/i.test(pnpm);
  for (const file of [
    "dist",
    "locales",
    ".tabularium",
    "README.md",
    "NOTICE",
    "CORE_INTEGRATION.json",
    "screenshots",
    "LICENSE",
    "assets",
    "package.json",
    "pnpm-lock.yaml",
  ])
    await cp(join(root, file), join(temp, file), { recursive: true });
  await mkdir(join(temp, "ui"), { recursive: true });
  await cp(join(root, "ui/dist"), join(temp, "ui/dist"), { recursive: true });
  // A hoisted production tree preserves transitive resolution after ZIP extraction, without symlinks.
  const installed = spawnSync(
    pnpmScript ? process.execPath : pnpm,
    [
      ...(pnpmScript ? [pnpm] : []),
      "install",
      "--ignore-workspace",
      "--prod",
      "--prefer-offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--node-linker=hoisted",
    ],
    { cwd: temp, encoding: "utf8", env: { ...process.env, CI: "true" } },
  );
  if (installed.status !== 0)
    throw new Error(
      `Production dependency staging failed: ${installed.stderr || installed.stdout}`,
    );
  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({ type: "module" }) + "\n",
  );
  await rm(join(temp, "pnpm-lock.yaml"), { force: true });
  // Runtime imports resolve their binaries directly; package-manager CLI shims are unnecessary.
  await rm(join(temp, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
  const archive = join(
    root,
    `neon-${manifest.version}-${process.platform === "win32" ? "win" : process.platform}-${process.arch}.zip`,
  );
  const files = {};
  for (const name of await readdir(temp, { recursive: true })) {
    const path = join(temp, name);
    const info = await lstat(path);
    if (info.isDirectory()) continue;
    if (!info.isFile())
      throw new Error(`Package contains a nonregular file: ${name}`);
    files[name.replaceAll("\\", "/")] = [
      await readFile(path),
      { os: 3, attrs: ((info.mode & 0xffff) << 16) >>> 0 },
    ];
  }
  // ZIP Unix attributes retain the native esbuild executable bit after installation.
  await writeFile(pendingArchive, zipSync(files, { level: 6 }));
  await rename(pendingArchive, archive);
  console.log(
    `Plugin archive created: ${archive} (Node.js 22+ required on destination)`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(archiveStage, { recursive: true, force: true });
}
