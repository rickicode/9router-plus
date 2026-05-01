import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.env.WORKER_PROJECT_ROOT || process.cwd();

function resolveProjectPath(...segments) {
  const rawPath = path.join(projectRoot, ...segments);
  const resolvedPath = path.extname(rawPath)
    ? rawPath
    : existsSync(`${rawPath}.js`)
      ? `${rawPath}.js`
      : existsSync(`${rawPath}.mjs`)
        ? `${rawPath}.mjs`
        : existsSync(path.join(rawPath, "index.js"))
          ? path.join(rawPath, "index.js")
          : rawPath;

  return pathToFileURL(resolvedPath).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(resolveProjectPath("src", specifier.slice(2)), context);
  }

  if (specifier === "open-sse") {
    return nextResolve(resolveProjectPath("open-sse", "index.js"), context);
  }

  if (specifier.startsWith("open-sse/")) {
    return nextResolve(resolveProjectPath("open-sse", specifier.slice("open-sse/".length)), context);
  }

  return nextResolve(specifier, context);
}
