import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Собирает javascript:-ссылку закладки из public/bookmarklet/<name>.js:
 * подставляет адрес LeadOS, убирает блочные комментарии и отступы, кодирует в URL.
 */
export async function buildBookmarklet(name: "kwork" | "maps" | "page", origin: string) {
  const file = path.join(process.cwd(), "public", "bookmarklet", `${name}.js`);
  const source = await readFile(file, "utf8");

  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .replaceAll("__LEADOS_ORIGIN__", origin);

  return {
    href: `javascript:${encodeURIComponent(code)}`,
    version: createHash("sha256").update(code).digest("hex").slice(0, 8),
    size: code.length,
  };
}

export function resolveOrigin(h: Headers): string {
  const fromEnv = process.env.APP_URL?.replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
