import { z } from 'zod';

import { NIVEIS_LOG, type NivelLog } from './log.js';

/** Configuração inválida: a API não sobe. `problemas` traz "VARIAVEL: motivo", nunca o valor. */
export class ErroConfig extends Error {
  readonly problemas: string[];

  constructor(problemas: string[]) {
    super(`Configuração inválida: ${problemas.join('; ')}`);
    this.name = 'ErroConfig';
    this.problemas = problemas;
  }
}

const obrigatoria = z.string({ error: 'variável obrigatória não definida' });
const NIVEIS = Object.keys(NIVEIS_LOG) as [NivelLog, ...NivelLog[]];

const esquema = z.object({
  DATABASE_URL: obrigatoria.transform((url, ctx) => {
    // A versão Python usa o formato do SQLAlchemy (postgresql+psycopg://); o pg só entende postgresql://.
    const normalizada = url.replace(/^postgres(?:ql)?(?:\+\w+)?:\/\//i, 'postgresql://');
    if (!normalizada.startsWith('postgresql://')) {
      ctx.addIssue({
        code: 'custom',
        message: 'deve começar com postgresql:// ou postgresql+psycopg:// (SQLite não é suportado nesta versão)',
      });
      return z.NEVER;
    }
    return normalizada;
  }),
  MQTT_HOST: obrigatoria,
  MQTT_PORT: z.coerce
    .number({ error: 'deve ser um número' })
    .int({ error: 'deve ser um número inteiro' })
    .min(1, { error: 'deve estar entre 1 e 65535' })
    .max(65535, { error: 'deve estar entre 1 e 65535' })
    .default(1883),
  MQTT_USER: obrigatoria,
  MQTT_PASSWORD: obrigatoria,
  MQTT_TOPICO: z.string().default('casa/+/gas'),
  // Fixo de propósito: com clean=false, o broker guarda a sessão (e as mensagens QoS 1) por client id.
  MQTT_CLIENT_ID: z.string().default('api-gas'),
  ALERTA_COOLDOWN_SEGUNDOS: z.coerce
    .number({ error: 'deve ser um número' })
    .int({ error: 'deve ser um número inteiro de segundos' })
    .min(0, { error: 'não pode ser negativo' })
    .default(300),
  NOTIFICADOR: z.enum(['log', 'telegram'], { error: 'use "log" ou "telegram"' }).default('log'),
  // Exigidas pelo TelegramNotificador quando NOTIFICADOR=telegram.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  LOG_LEVEL: z
    .string()
    .transform((nivel) => nivel.toUpperCase())
    .pipe(z.enum(NIVEIS, { error: 'use DEBUG, INFO, WARNING ou ERROR' }))
    .default('INFO'),
  // Opcional, só desta versão: interface onde a API escuta.
  API_HOST: z.string().default('0.0.0.0'),
});

export type Config = z.output<typeof esquema>;

/** Valida as variáveis de ambiente. Lança ErroConfig listando todas as que estiverem faltando ou inválidas. */
export function carregarConfig(ambiente: Record<string, string | undefined> = process.env): Config {
  // Variável vazia no .env (ex.: TELEGRAM_BOT_TOKEN=) conta como não definida.
  const valores = Object.fromEntries(
    Object.keys(esquema.shape).map((chave) => {
      const valor = ambiente[chave];
      return [chave, valor === undefined || valor.trim() === '' ? undefined : valor];
    }),
  );
  const resultado = esquema.safeParse(valores);
  if (!resultado.success) {
    throw new ErroConfig(resultado.error.issues.map((problema) => `${problema.path.join('.')}: ${problema.message}`));
  }
  return resultado.data;
}

/** Lê o .env (padrão: do diretório atual) sem sobrescrever variáveis já definidas. Retorna false se não existir. */
export function lerArquivoEnv(caminho = '.env'): boolean {
  try {
    process.loadEnvFile(caminho);
    return true;
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw erro;
  }
}
