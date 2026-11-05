import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** Valores aceitos em LOG_LEVEL (os mesmos do logging do Python) e o nível equivalente no pino. */
export const NIVEIS_LOG = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warn',
  WARN: 'warn',
  ERROR: 'error',
  CRITICAL: 'fatal',
} as const;

export type NivelLog = keyof typeof NIVEIS_LOG;

// Nível do pino -> texto do campo "nivel" (como o levelname do Python).
const NIVEL_TEXTO: Record<string, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Logger JSON em stdout, um objeto por linha.
 *
 * Uso: log.info({ acao: 'gravado', dispositivo: 'esp32-cozinha' }, 'Leitura gravada')
 * Saída: {"nivel":"INFO","ts":"2026-09-13T14:22:07.120Z","acao":"gravado","dispositivo":"esp32-cozinha","msg":"Leitura gravada"}
 */
export function criarLogger(nivel: NivelLog = 'INFO', destino?: DestinationStream): Logger {
  return pino(
    {
      level: NIVEIS_LOG[nivel],
      base: undefined, // sem pid e hostname
      messageKey: 'msg',
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level: (rotulo) => ({ nivel: NIVEL_TEXTO[rotulo] ?? rotulo.toUpperCase() }),
      },
      // Defesa extra: se alguém logar um objeto com estes campos, o valor não aparece.
      redact: {
        paths: ['senha', 'password', 'token', '*.senha', '*.password', '*.token', 'MQTT_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'DATABASE_URL'],
        censor: '[oculto]',
      },
    },
    destino ?? pino.destination({ dest: 1, sync: true }),
  );
}

/** Texto de um erro para o campo "erro" do log e do banco: "Nome: mensagem". */
export function descreverErro(erro: unknown): string {
  return erro instanceof Error ? `${erro.name}: ${mensagemErro(erro)}` : String(erro);
}

/** Só a mensagem do erro, nunca vazia. */
export function mensagemErro(erro: unknown): string {
  if (!(erro instanceof Error)) return String(erro);
  if (erro.message) return erro.message;
  // "localhost" resolve para ::1 e 127.0.0.1; se as duas tentativas falham, o Node lança um
  // AggregateError de mensagem vazia, com o erro de cada endereço em `errors`.
  if (erro instanceof AggregateError && erro.errors.length > 0) return erro.errors.map(mensagemErro).join('; ');
  return String((erro as NodeJS.ErrnoException).code ?? erro.name);
}
