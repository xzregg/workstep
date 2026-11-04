export interface DiagnosticPrivacyContext {
  secrets?: Iterable<string>
  identities?: Iterable<string>
  homeDirectory?: string
}
export function redactDiagnosticText(value: unknown, context?: DiagnosticPrivacyContext): string
export function diagnosticRoute(value: string): string
