import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

const core = process.env.TABULARIS_CORE_ROOT
  ? resolve(process.env.TABULARIS_CORE_ROOT)
  : fileURLToPath(new URL("../../tabularis/", import.meta.url));
if (!existsSync(join(core, "packages/web-ui/src")))
  throw new Error(
    "Set TABULARIS_CORE_ROOT to a compatible Core checkout to run host-component integration tests.",
  );
export default defineConfig({
  resolve: {
    alias: {
      react: join(core, "node_modules/react"),
      "react-dom": join(core, "node_modules/react-dom"),
      "@testing-library/react": join(
        core,
        "node_modules/@testing-library/react",
      ),
      "@testing-library/dom": join(core, "node_modules/@testing-library/dom"),
      "@testing-library/user-event": join(
        core,
        "node_modules/@testing-library/user-event",
      ),
      "@": join(core, "packages/web-ui/src"),
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
