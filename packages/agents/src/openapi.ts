import { parse as parseYaml } from "yaml";

/** One HTTP operation from a seller's API description. Every string here is seller-controlled. */
export interface Operation {
  /** "METHOD /path", the key used everywhere (gate config, proposals). */
  key: string;
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  tags: string[];
  /** Media types the operation accepts / returns — hints like "image/png" or "text/event-stream". */
  requestTypes: string[];
  responseTypes: string[];
}

export interface ApiDescription {
  version: "2.0" | "3.0" | "3.1";
  title: string;
  description: string | null;
  /** Absolute base URL from `servers` (3.x) or host/basePath/schemes (2.0), when the spec has one. */
  baseUrl: string | null;
  operations: Operation[];
}

export class SpecError extends Error {
  override name = "SpecError";
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
const MAX_OPERATIONS = 200;
const MAX_TEXT = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** Parse JSON or YAML text. Specs over 2 MB are refused. */
export function parseSpecText(text: string): unknown {
  if (text.length > 2_000_000) throw new SpecError("Spec is larger than 2 MB.");
  const trimmed = text.trim();
  if (!trimmed) throw new SpecError("Spec is empty.");
  try {
    return trimmed.startsWith("{")
      ? JSON.parse(trimmed)
      : parseYaml(trimmed, { maxAliasCount: 100 });
  } catch (err) {
    throw new SpecError(`Not valid JSON or YAML: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** Swagger 2.0 base URL: first scheme (https preferred) + host + basePath. */
function swaggerBase(spec: Obj): string | null {
  const host = str(spec.host, 300);
  if (!host) return null;
  const schemes = Array.isArray(spec.schemes) ? spec.schemes : [];
  const scheme = schemes.includes("https") ? "https" : (str(schemes[0], 10) ?? "https");
  return `${scheme}://${host}${str(spec.basePath, 300) ?? ""}`.replace(/\/+$/, "");
}

/** OpenAPI 3.x base URL: first absolute server, with variables replaced by their defaults. */
function serversBase(spec: Obj): string | null {
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  for (const s of servers) {
    if (!isObj(s)) continue;
    let url = str(s.url, 300);
    if (!url) continue;
    const vars = isObj(s.variables) ? s.variables : {};
    url = url.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const v = vars[name];
      return isObj(v) && typeof v.default === "string" ? v.default : `{${name}}`;
    });
    if (/^https?:\/\//.test(url) && !url.includes("{")) return url.replace(/\/+$/, "");
  }
  return null;
}

const mediaTypes = (content: unknown): string[] => (isObj(content) ? Object.keys(content) : []);

/**
 * Normalise an OpenAPI 3.0 / 3.1 or Swagger 2.0 document into operations. Only what pricing needs:
 * paths, methods, text and media types — schemas are not resolved.
 */
export function describeApi(raw: unknown): ApiDescription {
  if (!isObj(raw)) throw new SpecError("Spec must be an object.");
  let version: ApiDescription["version"];
  if (raw.swagger === "2.0") version = "2.0";
  else if (typeof raw.openapi === "string" && raw.openapi.startsWith("3.0")) version = "3.0";
  else if (typeof raw.openapi === "string" && raw.openapi.startsWith("3.1")) version = "3.1";
  else throw new SpecError("Not an OpenAPI 3.0/3.1 or Swagger 2.0 document.");

  const info = isObj(raw.info) ? raw.info : {};
  const paths = isObj(raw.paths) ? raw.paths : {};
  const globalProduces = Array.isArray(raw.produces)
    ? raw.produces.filter((x) => typeof x === "string")
    : [];
  const globalConsumes = Array.isArray(raw.consumes)
    ? raw.consumes.filter((x) => typeof x === "string")
    : [];

  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith("/") || !isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      if (operations.length >= MAX_OPERATIONS)
        throw new SpecError(`More than ${MAX_OPERATIONS} operations; split the spec.`);
      const responses = isObj(op.responses) ? op.responses : {};
      const success = Object.entries(responses).filter(([code]) => /^2\d\d$|^2XX$/i.test(code));
      const requestTypes =
        version === "2.0"
          ? Array.isArray(op.consumes)
            ? op.consumes.filter((x): x is string => typeof x === "string")
            : globalConsumes
          : mediaTypes(isObj(op.requestBody) ? op.requestBody.content : undefined);
      const responseTypes =
        version === "2.0"
          ? Array.isArray(op.produces)
            ? op.produces.filter((x): x is string => typeof x === "string")
            : globalProduces
          : [...new Set(success.flatMap(([, r]) => mediaTypes(isObj(r) ? r.content : undefined)))];
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        operationId: str(op.operationId, 120),
        summary: str(op.summary, 200),
        description: str(op.description),
        tags: Array.isArray(op.tags)
          ? op.tags.map((t) => str(t, 60)).filter((t): t is string => !!t)
          : [],
        requestTypes: requestTypes.slice(0, 5),
        responseTypes: responseTypes.slice(0, 5),
      });
    }
  }
  if (operations.length === 0) throw new SpecError("The spec has no operations under `paths`.");
  return {
    version,
    title: str(info.title, 120) ?? "Untitled API",
    description: str(info.description, 1000),
    baseUrl: version === "2.0" ? swaggerBase(raw) : serversBase(raw),
    operations,
  };
}
