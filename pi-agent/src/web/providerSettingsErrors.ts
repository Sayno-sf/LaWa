// Shared errors without loading model runtime or personal settings.
export type ProviderSettingsErrorCode =
  | "INVALID_PROVIDER"
  | "INVALID_MODEL"
  | "INVALID_BASE_URL"
  | "INVALID_THINKING_LEVEL"
  | "INVALID_MAX_OUTPUT_TOKENS"
  | "INVALID_PROFILE_NAME"
  | "PROFILE_NOT_FOUND"
  | "ACTIVE_PROFILE_DELETE_FORBIDDEN"
  | "MISSING_API_KEY"
  | "AUTHENTICATION_FAILED"
  | "MODEL_NOT_FOUND"
  | "NETWORK_ERROR"
  | "PROVIDER_TIMEOUT"
  | "UNSUPPORTED_THINKING_LEVEL"
  | "PROVIDER_ERROR";

export class ProviderSettingsError extends Error {
  constructor(
    readonly code: ProviderSettingsErrorCode,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
