import { spawnSync } from "node:child_process";
import safeRegex from "safe-regex2";

export type ChatSlurperRedactionConfiguration = {
  customPatterns?: Record<string, string>;
  pii?: {
    email?: boolean;
    phone?: boolean;
    address?: boolean;
  };
  openaiPrivacyFilter?: {
    enabled: boolean;
    command?: string;
    timeoutSeconds?: number;
    categories?: string[];
  };
};

const REDACTED = "[REDACTED]";
const MAX_OPF_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OPF_OUTPUT_BYTES = 1024 * 1024;
const OPF_SEPARATOR = "\u001e";
const KNOWN_OPF_CATEGORIES = new Set([
  "private_person",
  "private_email",
  "private_phone",
  "private_address",
  "private_url",
  "private_date",
  "account_number",
  "secret",
]);

const secretRules: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, REDACTED],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/gu,
    REDACTED,
  ],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/gu, REDACTED],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,255}\b/gu, REDACTED],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,255}\b/gu, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,60}\b/gu, REDACTED],
  [/\b(?:glpat|gldt|glrt)-[A-Za-z0-9_-]{16,255}\b/gu, REDACTED],
  [/\bnpm_[A-Za-z0-9]{20,255}\b/gu, REDACTED],
  [/\bpypi-[A-Za-z0-9_-]{20,255}\b/gu, REDACTED],
  [/\b(?:dop_v1|dopr_v1)_[A-Fa-f0-9]{32,255}\b/gu, REDACTED],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu, REDACTED],
  [/\b(?:shpat|shpca|shppa|shpss)_[A-Fa-f0-9]{24,255}\b/gu, REDACTED],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,255}\b/gu, REDACTED],
  [/\b(?:dapi|hf_|lin_api_|PMAK-|pul-)[A-Za-z0-9_-]{20,255}\b/gu, REDACTED],
  [/\b(?:glc_|sntrys_|hvs\.)[A-Za-z0-9._-]{20,255}\b/gu, REDACTED],
  [/\bAGE-SECRET-KEY-1[0-9A-Z]{20,255}\b/gu, REDACTED],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    REDACTED,
  ],
];

const credentialedUri =
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@"'`<>:]*:[^\s/?#@"'`<>]+@[^\s"'`<>]+/giu;
const databaseUrl =
  /\b(?:jdbc:[^\s"'<>`]+|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>`]+)/giu;
const keywordDsn =
  /\b[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']+)(?:\s+[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']+)){2,}/giu;
const semicolonConnection =
  /\b[a-z][a-z0-9 _-]*=(?:\{[^}]*\}|"[^"]*"|'[^']*'|[^=;"'\s]+)(?:;[a-z][a-z0-9 _-]*=(?:\{[^}]*\}|"[^"]*"|'[^']*'|[^=;"'\s]+)){2,}/giu;
const credentialAssignment =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret)\b(\s*[=:]\s*|["']\s*:\s*["'])([^\s,"'};&]+)/giu;
const entropyCandidate = /[A-Za-z0-9+_=-]{20,}/gu;

/** Validate a persisted redaction configuration before processing transcripts. */
export function validateRedactionConfiguration(config: unknown): void {
  if (config === undefined) return;
  if (!isRecord(config))
    throw new Error("Chat Slurper redaction configuration must be an object.");
  const typed = config as ChatSlurperRedactionConfiguration;
  if (typed.customPatterns !== undefined && !isRecord(typed.customPatterns)) {
    throw new Error("customPatterns must be an object of regular expressions.");
  }
  for (const [name, pattern] of Object.entries(typed.customPatterns ?? {})) {
    if (typeof pattern !== "string")
      throw new Error(`Custom redaction rule ${name} must be a string.`);
    if (!name.trim() || !pattern)
      throw new Error("Custom redaction rules require a name and pattern.");
    try {
      new RegExp(pattern, "gu");
    } catch (error) {
      throw new Error(
        `Invalid custom redaction rule ${name}: ${String(error)}`,
      );
    }
    if (!safeRegex(pattern)) {
      throw new Error(
        `Unsafe custom redaction rule ${name}; nested or excessive repetition is not allowed.`,
      );
    }
  }
  if (typed.pii !== undefined) {
    if (!isRecord(typed.pii)) throw new Error("pii must be an object.");
    for (const [name, enabled] of Object.entries(typed.pii)) {
      if (typeof enabled !== "boolean")
        throw new Error(`PII option ${name} must be boolean.`);
    }
  }
  const opf = typed.openaiPrivacyFilter;
  if (opf !== undefined && !isRecord(opf))
    throw new Error("openaiPrivacyFilter must be an object.");
  if (opf && typeof opf.enabled !== "boolean") {
    throw new Error("openaiPrivacyFilter.enabled must be boolean.");
  }
  if (!opf?.enabled) return;
  if (opf.command !== undefined && typeof opf.command !== "string") {
    throw new Error("OpenAI Privacy Filter command must be a string.");
  }
  if (
    opf.timeoutSeconds !== undefined &&
    typeof opf.timeoutSeconds !== "number"
  ) {
    throw new Error("OpenAI Privacy Filter timeoutSeconds must be a number.");
  }
  if (
    opf.timeoutSeconds !== undefined &&
    (opf.timeoutSeconds < 1 || opf.timeoutSeconds > 300)
  ) {
    throw new Error(
      "OpenAI Privacy Filter timeoutSeconds must be between 1 and 300.",
    );
  }
  if (opf.categories !== undefined && !Array.isArray(opf.categories)) {
    throw new Error("OpenAI Privacy Filter categories must be an array.");
  }
  for (const category of opf.categories ?? []) {
    if (typeof category !== "string")
      throw new Error("OpenAI Privacy Filter categories must be strings.");
    if (!KNOWN_OPF_CATEGORIES.has(category)) {
      throw new Error(`Unknown OpenAI Privacy Filter category ${category}.`);
    }
  }
}

/** Redact secret, connection-string, custom, entropy, and optional PII patterns. */
export function redactText(
  input: string,
  config: ChatSlurperRedactionConfiguration | undefined,
): string {
  let output = input;
  for (const [pattern, replacement] of secretRules)
    output = output.replace(pattern, replacement);
  output = output
    .replace(credentialedUri, "[REDACTED_CONNECTION_STRING]")
    .replace(databaseUrl, "[REDACTED_CONNECTION_STRING]")
    .replace(keywordDsn, (value) =>
      /(?:password|passwd|pwd)=/iu.test(value)
        ? "[REDACTED_CONNECTION_STRING]"
        : value,
    )
    .replace(semicolonConnection, (value) =>
      /(?:password|passwd|pwd)=/iu.test(value)
        ? "[REDACTED_CONNECTION_STRING]"
        : value,
    )
    .replace(
      credentialAssignment,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    )
    .replace(entropyCandidate, (candidate) =>
      shouldRedactEntropy(candidate) ? REDACTED : candidate,
    );

  for (const [name, pattern] of Object.entries(config?.customPatterns ?? {})) {
    output = output.replace(
      new RegExp(pattern, "gu"),
      `[REDACTED_${label(name)}]`,
    );
  }
  if (config?.pii?.email) {
    output = output.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[REDACTED_EMAIL]",
    );
  }
  if (config?.pii?.phone) {
    output = output.replace(
      /(?<!\w)(?:\+?\d[\d .()-]{7,}\d)(?!\w)/gu,
      "[REDACTED_PHONE]",
    );
  }
  if (config?.pii?.address) {
    output = output.replace(
      /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|way)\b\.?/giu,
      "[REDACTED_ADDRESS]",
    );
  }
  return output;
}

/** Redact all string leaves in JSON values and optionally run OPF in one bounded batch. */
export function redactJsonValues(
  values: Record<string, unknown>[],
  config: ChatSlurperRedactionConfiguration | undefined,
): Record<string, unknown>[] {
  validateRedactionConfiguration(config);
  const regexRedacted = values.map((value) =>
    mapStrings(value, (text) => redactText(text, config)),
  );
  const opf = config?.openaiPrivacyFilter;
  if (!opf?.enabled) return regexRedacted;

  const strings: string[] = [];
  for (const value of regexRedacted)
    mapStrings(value, (text) => {
      strings.push(text);
      return text;
    });
  const redacted = redactWithOpf(strings, opf);
  let index = 0;
  return regexRedacted.map((value) =>
    mapStrings(value, () => redacted[index++] ?? ""),
  );
}

function redactWithOpf(
  inputs: string[],
  config: NonNullable<ChatSlurperRedactionConfiguration["openaiPrivacyFilter"]>,
): string[] {
  if (inputs.length === 0) return [];
  const sanitized = inputs.map((input) =>
    input
      .replaceAll("\n", " ")
      .replaceAll("\r", " ")
      .replaceAll(OPF_SEPARATOR, " "),
  );
  const starts: number[] = [];
  let offset = 0;
  for (const input of sanitized) {
    starts.push(offset);
    offset +=
      Buffer.byteLength(input, "utf8") +
      Buffer.byteLength(OPF_SEPARATOR, "utf8");
  }
  const joined = sanitized.join(OPF_SEPARATOR);
  if (Buffer.byteLength(joined, "utf8") > MAX_OPF_INPUT_BYTES) {
    throw new Error(
      `OpenAI Privacy Filter input exceeds ${MAX_OPF_INPUT_BYTES} bytes.`,
    );
  }
  const command = config.command?.trim() || "opf";
  const result = spawnSync(
    command,
    [
      "--device",
      "cpu",
      "--output-mode",
      "typed",
      "--format",
      "json",
      "--no-print-color-coded-text",
    ],
    {
      input: joined,
      encoding: "utf8",
      timeout: (config.timeoutSeconds ?? 30) * 1000,
      maxBuffer: MAX_OPF_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `OpenAI Privacy Filter failed closed (${command}): ${result.error?.message ?? `exit ${result.status ?? "unknown"}`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "OpenAI Privacy Filter returned invalid JSON; transcript was not uploaded.",
    );
  }
  const spans = Array.isArray(
    (parsed as { detected_spans?: unknown }).detected_spans,
  )
    ? (parsed as { detected_spans: unknown[] }).detected_spans
    : [];
  const output = [...sanitized];
  for (let inputIndex = 0; inputIndex < output.length; inputIndex += 1) {
    const start = starts[inputIndex] ?? 0;
    const end = start + Buffer.byteLength(output[inputIndex] ?? "", "utf8");
    const local = spans
      .map(
        (span) => span as { label?: unknown; start?: unknown; end?: unknown },
      )
      .filter(
        (span) =>
          typeof span.label === "string" &&
          (config.categories ?? [...KNOWN_OPF_CATEGORIES]).includes(
            span.label,
          ) &&
          typeof span.start === "number" &&
          typeof span.end === "number" &&
          span.start >= start &&
          span.end <= end &&
          span.start < span.end,
      )
      .map((span) => ({
        start: (span.start as number) - start,
        end: (span.end as number) - start,
        replacement: opfReplacement(span.label as string),
      }));
    output[inputIndex] = applyByteSpans(output[inputIndex] ?? "", local);
  }
  return output;
}

function mapStrings<T>(value: T, transform: (value: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value))
    return value.map((item) => mapStrings(item, transform)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      mapStrings(child, transform),
    ]),
  ) as T;
}

function applyByteSpans(
  input: string,
  spans: Array<{ start: number; end: number; replacement: string }>,
): string {
  const buffer = Buffer.from(input, "utf8");
  const sorted = spans.sort((left, right) => right.start - left.start);
  let output = buffer;
  for (const span of sorted) {
    output = Buffer.concat([
      output.subarray(0, span.start),
      Buffer.from(span.replacement),
      output.subarray(span.end),
    ]);
  }
  return output.toString("utf8");
}

function shouldRedactEntropy(candidate: string): boolean {
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(candidate)) return false;
  if (/^(?:REDACTED|[A-Z_]{20,}|[a-z_-]{20,})$/u.test(candidate)) return false;
  const counts = new Map<string, number>();
  for (const character of candidate)
    counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / candidate.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy > 4.5;
}

function opfReplacement(category: string): string {
  const labels: Record<string, string> = {
    private_person: "PERSON",
    private_email: "EMAIL",
    private_phone: "PHONE",
    private_address: "ADDRESS",
    private_url: "URL",
    private_date: "DATE",
    account_number: "ACCOUNT_NUMBER",
  };
  return labels[category] ? `[REDACTED_${labels[category]}]` : REDACTED;
}

function label(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .toUpperCase() || "CUSTOM"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
