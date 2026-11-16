import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  rm,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";

test("release packaging replaces old archives and excludes local credentials", async () => {
  const workspace = await mkdtemp(
    join(
      fileURLToPath(new URL("../", import.meta.url)),
      ".package-test-workspace-",
    ),
  );
  const root = await mkdtemp(join(workspace, "neon-package-test-"));
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ private: true, packageManager: "pnpm@10.30.3" }),
  );
  await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
  try {
    for (const dir of [
      "scripts",
      "dist",
      "locales",
      "ui/dist",
      "node_modules",
      "assets",
      "screenshots",
    ])
      await mkdir(join(root, dir), { recursive: true });
    await copyFile(
      new URL("../scripts/package.mjs", import.meta.url),
      join(root, "scripts/package.mjs"),
    );
    await writeFile(
      join(root, ".tabularium"),
      JSON.stringify({ id: "neon", version: "0.2.0" }),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", packageManager: "pnpm@10.30.3" }),
    );
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
    );
    for (const file of [
      "dist/driver.js",
      "ui/dist/index.js",
      "README.md",
      "NOTICE",
      "CORE_INTEGRATION.json",
      "LICENSE",
      "assets/icon.svg",
    ])
      await writeFile(join(root, file), "public release fixture");
    await writeFile(join(root, ".env.local"), "DO_NOT_PUBLISH=secret");
    await writeFile(join(root, "obsolete-secret.txt"), "obsolete");
    await writeFile(join(root, "dist/native-tool"), "native fixture", {
      mode: 0o755,
    });
    const name = `neon-0.2.0-${process.platform === "win32" ? "win" : process.platform}-${process.arch}.zip`;
    await writeFile(
      join(root, name),
      zipSync({ "obsolete-secret.txt": strToU8("obsolete") }),
    );
    const archiveTempRoot = workspace;
    const packaged = spawnSync(
      process.execPath,
      [join(root, "scripts/package.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: archiveTempRoot,
          TMP: archiveTempRoot,
          TEMP: archiveTempRoot,
        },
      },
    );
    assert.equal(packaged.status, 0, packaged.stderr);
    const bytes = await readFile(join(root, name));
    const files = unzipSync(bytes);
    assert(
      !files["obsolete-secret.txt"],
      "Old archive members must not survive",
    );
    assert(!files[".env.local"], "Local credentials must not be packaged");
    assert(files["dist/driver.js"]);
    assert(files["ui/dist/index.js"]);
    assert.equal(strFromU8(files["LICENSE"]), "public release fixture");
    if (process.platform !== "win32") {
      let mode;
      for (let offset = 0; offset < bytes.length - 46; offset++) {
        if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
        const length = bytes.readUInt16LE(offset + 28);
        if (
          bytes.subarray(offset + 46, offset + 46 + length).toString() ===
          "dist/native-tool"
        )
          mode = bytes.readUInt32LE(offset + 38) >>> 16;
      }
      assert.equal(
        mode & 0o777,
        0o755,
        "ZIP must preserve executable permission bits",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
