export class AppError extends Error {
  constructor(public status: number, public code: string, public safeMessage: string) { super(code); }
}
export const unavailable = () => new AppError(503, 'NOT_CONFIGURED', 'La prueba todavía no está configurada.');
