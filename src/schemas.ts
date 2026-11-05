import { z } from 'zod';

/** Tamanho máximo de dispositivo e de cômodo (varchar(64) no banco). */
export const TAMANHO_MAX_NOME = 64;

export const STATUS = ['NORMAL', 'VAZAMENTO'] as const;
export type Status = (typeof STATUS)[number];

// ---------------------------------------------------------------------------
// Datas ISO 8601
// ---------------------------------------------------------------------------

// Os mesmos formatos que a versão Python (Pydantic) aceita: só a data (meia-noite), hora com ou
// sem segundos, "T", "t" ou espaço como separador, fração com "." ou "," e fuso "Z", "+03:00" ou
// "+0300". Ficam de fora "+03", "24:00", segundo 60, ano 0 e formatos sem hífen (20260913T...).
const DATA_ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Converte texto ISO 8601 em Date. Sem fuso, assume UTC. Retorna null se não for uma data válida.
 *
 * Não usa Date.parse: ele trata "2026-09-13T14:22:07" (sem fuso) como horário LOCAL.
 */
export function interpretarDataIso(texto: string): Date | null {
  const partes = DATA_ISO.exec(texto);
  if (partes === null) return null;
  const [, ano, mes, dia, hora = '0', minuto = '0', segundo = '0', fracao = '', fuso = 'Z'] = partes;
  const [a, me, d, h, mi, s] = [ano, mes, dia, hora, minuto, segundo].map(Number) as [number, number, number, number, number, number];
  if (a < 1 || me < 1 || me > 12 || d < 1 || d > diasNoMes(a, me) || h > 23 || mi > 59 || s > 59) return null;

  let deslocamentoMinutos = 0;
  if (fuso !== 'Z' && fuso !== 'z') {
    const horasFuso = Number(fuso.slice(1, 3));
    const minutosFuso = Number(fuso.slice(-2));
    if (horasFuso > 23 || minutosFuso > 59) return null;
    deslocamentoMinutos = (fuso.startsWith('-') ? -1 : 1) * (horasFuso * 60 + minutosFuso);
  }

  // O Date do JS guarda milissegundos: o resto da fração é descartado (o Python descarta abaixo do microssegundo).
  const milissegundos = Number(fracao.slice(0, 3).padEnd(3, '0'));
  const data = new Date(0);
  data.setUTCFullYear(a, me - 1, d); // e não Date.UTC, que trataria os anos 0 a 99 como 1900 a 1999
  data.setUTCHours(h, mi, s, milissegundos);
  return new Date(data.getTime() - deslocamentoMinutos * 60_000);
}

function diasNoMes(ano: number, mes: number): number {
  if (mes === 2) return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mes) ? 30 : 31;
}

/** Tamanho em caracteres (code points), como o len() do Python e o varchar do Postgres. */
function tamanho(texto: string): number {
  return [...texto].length;
}

// Os espaços que o str.strip() do Python remove. O trim() do JS difere: remove U+FEFF e mantém
// U+0085 e U+001C a U+001F. O dispositivo é a chave do estado de alerta, então as duas versões
// precisam normalizar exatamente igual.
const ESPACOS_PYTHON = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const ESPACOS_NAS_PONTAS = new RegExp(`^[${ESPACOS_PYTHON}]+|[${ESPACOS_PYTHON}]+$`, 'g');

function removerEspacosDasPontas(texto: string): string {
  return texto.replace(ESPACOS_NAS_PONTAS, '');
}

// ---------------------------------------------------------------------------
// Contrato MQTT: tópico casa/<comodo>/gas + payload JSON
// ---------------------------------------------------------------------------

/** Retorna o cômodo de "casa/<comodo>/gas", ou null se o tópico não seguir o formato. */
export function extrairComodo(topico: string): string | null {
  const partes = topico.split('/');
  if (partes.length !== 3 || partes[0] !== 'casa' || partes[2] !== 'gas') return null;
  const comodo = partes[1] ?? '';
  if (comodo === '' || tamanho(comodo) > TAMANHO_MAX_NOME) return null;
  return comodo;
}

const MSG_DISPOSITIVO = `deve ser um texto de 1 a ${TAMANHO_MAX_NOME} caracteres`;
const MSG_LEITURA = 'deve ser um número inteiro de 0 a 4095';
const MSG_STATUS = 'deve ser exatamente "NORMAL" ou "VAZAMENTO"';
const MSG_TS = 'deve ser um texto ISO 8601 (ex.: "2026-09-13T14:22:07Z") ou ser omitido';

// Mensagem de erro de um campo; se o campo nem veio, diz que ele é obrigatório.
const mensagem = (texto: string) => (problema: { input: unknown }) =>
  problema.input === undefined ? 'campo obrigatório ausente' : texto;

const esquemaPayload = z.strictObject(
  {
    dispositivo: z
      .string({ error: mensagem(MSG_DISPOSITIVO) })
      .overwrite(removerEspacosDasPontas)
      .min(1, { error: 'não pode ser vazio' })
      .refine((valor) => tamanho(valor) <= TAMANHO_MAX_NOME, { error: `deve ter no máximo ${TAMANHO_MAX_NOME} caracteres` })
      // O Postgres não aceita o caractere nulo em texto: melhor rejeitar aqui do que falhar na gravação.
      .refine((valor) => !valor.includes('\u0000'), { error: 'não pode conter o caractere nulo (\\u0000)' }),
    leitura: z
      .int({ error: mensagem(MSG_LEITURA) })
      .min(0, { error: MSG_LEITURA })
      .max(4095, { error: MSG_LEITURA }),
    status: z.enum(STATUS, { error: mensagem(MSG_STATUS) }),
    ts: z
      .string({ error: MSG_TS })
      .nullish()
      .transform((valor, ctx) => {
        if (valor === undefined || valor === null) return null;
        const data = interpretarDataIso(valor);
        if (data === null) {
          ctx.addIssue({ code: 'custom', message: MSG_TS });
          return z.NEVER;
        }
        return data;
      }),
  },
  { error: (problema) => (problema.code === 'unrecognized_keys' ? 'campo não previsto no contrato' : 'o conteúdo deve ser um objeto JSON') },
);

/** Payload já validado: dispositivo sem espaços nas pontas e ts convertido para Date (UTC) ou null. */
export type PayloadGas = z.output<typeof esquemaPayload>;

/** Um erro de validação. `campo` vazio = o payload inteiro (ex.: não é JSON). */
export interface ErroCampo {
  campo: string;
  erro: string;
}

export type ResultadoValidacao = { ok: true; payload: PayloadGas } | { ok: false; erros: ErroCampo[] };

// fatal: bytes que não são UTF-8 válido viram erro. ignoreBOM: mantém o BOM, que o JSON.parse rejeita (como o Python).
const DECODIFICADOR_ESTRITO = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DECODIFICADOR_TOLERANTE = new TextDecoder('utf-8');
const LITERAL_INTEIRO = /^-?\d+$/;

/** Valida o payload bruto publicado pelo ESP32 contra o contrato. */
export function validarPayload(bruto: Uint8Array): ResultadoValidacao {
  let texto: string;
  try {
    texto = DECODIFICADOR_ESTRITO.decode(bruto);
  } catch {
    return falha('o conteúdo não é UTF-8 válido');
  }
  if (texto.trim() === '') return falha('payload vazio');

  // Depois do JSON.parse, 742.0 e 1e3 viram 742 e 1000. O reviver recebe o texto original de cada
  // número (context.source, Node 21+), e assim dá para rejeitá-los como a versão Python faz.
  const naoInteiros = new WeakMap<object, Set<string>>();
  let dados: unknown;
  try {
    dados = JSON.parse(texto, function (this: object, chave: string, valor: unknown, contexto?: { source?: string }) {
      if (typeof valor === 'number' && contexto?.source !== undefined && !LITERAL_INTEIRO.test(contexto.source)) {
        const chaves = naoInteiros.get(this) ?? new Set<string>();
        chaves.add(chave);
        naoInteiros.set(this, chaves);
      }
      return valor;
    });
  } catch (erro) {
    return falha(`não é JSON válido (${(erro as Error).message})`);
  }

  const resultado = esquemaPayload.safeParse(dados);
  const erros = resultado.success ? [] : resultado.error.issues.flatMap(converterProblema);
  const leituraNaoInteira = typeof dados === 'object' && dados !== null && naoInteiros.get(dados)?.has('leitura');
  if (leituraNaoInteira && !erros.some((erro) => erro.campo === 'leitura')) {
    erros.push({ campo: 'leitura', erro: MSG_LEITURA });
  }
  if (erros.length > 0 || !resultado.success) return { ok: false, erros };
  return { ok: true, payload: resultado.data };
}

function converterProblema(problema: z.core.$ZodIssue): ErroCampo[] {
  if (problema.code === 'unrecognized_keys') {
    return problema.keys.map((chave) => ({ campo: chave, erro: 'campo não previsto no contrato' }));
  }
  return [{ campo: problema.path.map(String).join('.'), erro: problema.message }];
}

function falha(erro: string): ResultadoValidacao {
  return { ok: false, erros: [{ campo: '', erro }] };
}

/** Conteúdo bruto para o log: bytes inválidos viram "�" e o texto é truncado em `limite` caracteres. */
export function textoBruto(bruto: Uint8Array, limite = 1000): string {
  return DECODIFICADOR_TOLERANTE.decode(bruto.subarray(0, limite * 4)).slice(0, limite);
}
