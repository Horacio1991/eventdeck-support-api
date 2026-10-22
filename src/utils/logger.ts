// Lista cerrada de campos. No aceptar requests, errores crudos o respuestas de MP.
export type LogFields = { operationId?: string; paymentId?: string; preferenceId?: string; status?: string; code?: string };
export type Logger = (event: string, fields?: LogFields) => void;
export const logger: Logger = (event, fields = {}) => {
  const { operationId, paymentId, preferenceId, status, code } = fields;
  console.log(JSON.stringify({ time: new Date().toISOString(), event, operationId, paymentId, preferenceId, status, code }));
};
