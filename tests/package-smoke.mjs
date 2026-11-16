import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, ".tabularium"), "utf8"));
const platform = process.platform === "win32" ? "win" : process.platform;
const archive = join(
  root,
  `neon-${manifest.version}-${platform}-${process.arch}.zip`,
);
const directory = await mkdtemp(join(tmpdir(), "neon packaged smoke "));
try {
  for (const [name, bytes] of Object.entries(
    unzipSync(await readFile(archive)),
  )) {
    assert(
      !name.includes("\\") &&
        !name.split("/").includes("..") &&
        !isAbsolute(name) &&
        !/^[a-z]:/i.test(name),
    );
    const target = resolve(directory, name);
    await mkdir(dirname(target), { recursive: true });
    if (name.endsWith("/")) await mkdir(target, { recursive: true });
    else await writeFile(target, bytes);
  }
  const binary = join(
    directory,
    "node_modules",
    "@esbuild",
    `${process.platform}-${process.arch}`,
    ...(process.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]),
  );
  await readFile(binary);
  // fflate extraction does not restore ZIP attributes; the archive regression checks them.
  if (process.platform !== "win32") await chmod(binary, 0o755);
  const guard = join(directory, "offline.cjs");
  await writeFile(
    guard,
    "globalThis.fetch = async () => { throw new Error('Packaged smoke forbids provider network'); };\n",
  );
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
  };
  const options = { cwd: directory, env, encoding: "utf8", timeout: 60000 };
  const rpc = spawnSync(
    process.execPath,
    ["--require", guard, join(directory, "dist", "driver.js")],
    {
      ...options,
      input: [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]
        .map((request) => JSON.stringify(request) + "\n")
        .join(""),
    },
  );
  assert.equal(rpc.status, 0, rpc.error?.message ?? rpc.stderr);
  const responses = rpc.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  for (const id of [1, 2])
    assert.deepEqual(
      responses.find((response) => response.id === id),
      { jsonrpc: "2.0", id, result: null },
    );
  const compiled = spawnSync(
    process.execPath,
    [
      "--require",
      guard,
      "--input-type=module",
      "--eval",
      `
            import assert from 'node:assert/strict';
            const {compileFunction} = await import('./dist/functionCompiler.js');
            for (const [language, source] of [
                ['javascript', 'export default {fetch() { return Response.json({ok:true}); }};'],
                ['typescript', 'export default {fetch(request: Request): Response { return Response.json({url:request.url}); }};'],
            ]) {
                const result = await compileFunction(source, language);
                assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
                assert(result.bundleBytes > 0);
            }
        `,
    ],
    options,
  );
  assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr);
  console.log(
    `PASS packaged ${platform}-${process.arch}: driver RPC and native JavaScript/TypeScript compilation`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
