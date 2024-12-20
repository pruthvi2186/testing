import mkdirp from "mkdirp";
import { promises as fs } from "fs";
import mime from "mime-types";
import { posix as path } from "path";
import c from "picocolors";
import got from "got";
import { createServer } from "vite";
import { ViteNodeServer } from "vite-node/server";
import { ViteNodeRunner } from "vite-node/client";
import log from "consola";
import {
  filenameWithExtension,
  isValidExtension,
  resolveExtension,
  urlToFilename,
  urlToFilenameWithoutHash,
} from "./file";
import { Extension, Meta, Vendor } from "./types";
import { moduleToVendorPath } from "./module";
import { fileURLToPath } from "mlly";
import { validateArgs } from "./args";

const { importMap, isVendor, script } = validateArgs();

const currentDir = fileURLToPath(process.cwd());
let errorCode = 0;
(async () => {
  const handledModules = new Map<string, string>();
  const dest = path.join(currentDir, "node_modules");
  let vendor: Vendor = { imports: {} };
  try {
    vendor = JSON.parse(await fs.readFile(importMap, "utf8"));
    log.success(`Reading modules from vendor/import_map.json`);
  } catch {}
  const vendorDir = path.join(currentDir, "vendor");

  const server = await createServer({
    plugins: [
      {
        enforce: "pre",
        name: "venode:vendor:resolve",
        resolveId(id) {
          if (!importMap) return null;
          if (vendor.imports[id]) {
            return path.join(vendorDir, vendor.imports[id]);
          }
          return null;
        },
      },
      {
        enforce: "pre",
        name: "venode:vendor",
        async resolveId(id, importer) {
          if (
            !isVendor ||
            importMap ||
            id.startsWith(".") ||
            id.startsWith("/")
          )
            return null;
          const originalId = id;

          const plugins = server.config.plugins.filter(
            (p) => !p.name.includes(":vendor")
          );
          for (const plugin of plugins) {
            const result = await plugin.resolveId?.call(this, id, importer, {});
            if (!result) {
              continue;
            } else if (typeof result === "object") {
              id = result.id;
            } else if (typeof result === "string") {
              id = result;
            }
          }
          if (originalId.startsWith("http")) {
            const vendorPath = path.join(
              vendorDir,
              urlToFilenameWithoutHash(new URL(originalId))
            );
            await copyVendor(originalId, id, vendorPath);
            vendor.imports[originalId] = path.relative(vendorDir, vendorPath);
          } else {
            const vendorPath = path.join(vendorDir, moduleToVendorPath(id));
            await copyVendor(originalId, id, vendorPath);
            vendor.imports[originalId] = path.relative(vendorDir, vendorPath);
          }
          return null;
        },
      },
      {
        enforce: "pre",
        name: "venode:pre",
        async resolveId(id, importer) {
          if (!id.startsWith(".")) return null;
          const module = [...handledModules.entries()].find(
            (item) => item[1] === importer
          );
          if (!module) {
            return null;
          }
          const { pathname, href } = new URL(module[0]);

          const newId = path.join(path.dirname(pathname), id);

          return href.replace(pathname, newId);
        },
      },
      {
        enforce: "pre",
        name: "venode",
        async resolveId(id) {
          if (!id.startsWith("http")) {
            return null;
          }
          if (handledModules.has(id)) {
            return { id: handledModules.get(id) as string, external: false };
          }

          const url = new URL(id);
          const meta = path.join(dest, urlToFilename(url) + ".meta");

          let metaContent: Meta | undefined;
          try {
            metaContent = JSON.parse(await fs.readFile(meta, "utf8"));
          } catch {}
          if (metaContent) {
            handledModules.set(id, metaContent.path);
            return { id: metaContent.path, external: false };
          }

          log.info(c.green(`Download ${c.reset(id)}`));
          try {
            const res = await got.get(id);
            const mimeExtension = mime.extension(
              res.headers["content-type"] || ""
            );
            const ext = resolveExtension(url.href) || "." + mimeExtension;

            if (!isValidExtension(ext)) {
              throw new Error(`Unknown extension for ${id}`);
            }
            const filename = filenameWithExtension(url, ext as Extension);
            const text = res.body;

            const destFilename = path.join(dest, filename);

            await mkdirp(path.dirname(destFilename));
            await fs.writeFile(destFilename, text);
            await fs.writeFile(
              meta,
              JSON.stringify({
                path: destFilename,
                hash: path.basename(urlToFilename(url)),
              })
            );
            handledModules.set(id, destFilename);
            return { id: destFilename, external: false };
          } catch (e) {
            log.error(c.red("Failed"), id, e);
            process.exit(1);
          }
        },
      },
    ],
  });
  await server.pluginContainer.buildStart({});

  const node = new ViteNodeServer(server as any);

  const runner = new ViteNodeRunner({
    root: server.config.root,
    base: server.config.base,
    async fetchModule(id) {
      return node.fetchModule(id);
    },
    async resolveId(id, importer) {
      return node.resolveId(id, importer);
    },
  });

  try {
    // server
    if (isVendor) {
      const { deps } = (await node.transformRequest(script)) || {};
      if (!deps || !deps.length) {
        log.info(c.red("No dependencies found"));
        process.exit(1);
      }
      for (const dep of deps) {
        await transformDep(dep, node);
      }
    } else {
      await runner.executeFile(script);
    }
  } catch (e) {
    console.error(e);
    errorCode = 1;
  }

  await node.server.close();
  if (isVendor) {
    await fs.writeFile(
      path.join(vendorDir, "import_map.json"),
      JSON.stringify(vendor, null, 2)
    );
    log.success(
      "To use vendored modules, specify the `--import-map` flag: `venode --import-map=vendor/import_map.json`"
    );
  }
})().finally(() => process.exit(errorCode));

async function transformDep(dep: string, node: ViteNodeServer): Promise<void> {
  const deps = (await node.transformRequest(dep))?.deps;
  if (!deps || !deps.length) {
    return;
  }
  for (const dep of deps) {
    await transformDep(dep, node);
  }
}

async function copyVendor(originalId: string, id: string, vendorPath: string) {
  try {
    await mkdirp(path.dirname(vendorPath));
    await fs.copyFile(id, vendorPath);
  } catch (e) {
    log.error(`Could not create vendor file for ${originalId}`, e);
    process.exit(1);
  }
}
