import * as esbuild from "esbuild";

const production = process.argv.includes("production");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Use Obsidian's CM instances. Bundling a second copy can break state identity.
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  platform: "browser",
  target: "es2018",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: "main.js",
  logLevel: "info",
});

if (production) {
  try {
    await context.rebuild();
  } finally {
    await context.dispose();
  }
} else {
  await context.watch();
}
