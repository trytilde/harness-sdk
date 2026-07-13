import type { JsonValue } from "./tools";

export class ApiError extends Error {
  readonly status: number;
  readonly response: Response;
  readonly body: JsonValue | string;

  constructor(message: string, response: Response, body: JsonValue | string) {
    super(message);
    this.name = "ApiError";
    this.status = response.status;
    this.response = response;
    this.body = body;
  }
}

export async function errorFromResponse(response: Response): Promise<ApiError> {
  const contentType = response.headers.get("content-type") ?? "";
  let body: JsonValue | string;
  try {
    body = contentType.includes("application/json")
      ? ((await response.json()) as JsonValue)
      : await response.text();
  } catch {
    body = null;
  }

  const message =
    typeof body === "object" &&
    body !== null &&
    "msg" in body &&
    typeof body.msg === "string"
      ? body.msg
      : `Tilde API request failed with status ${response.status}`;
  return new ApiError(message, response, body);
}
