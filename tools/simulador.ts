/**
 * Simula o ESP32 publicando leituras de gás no broker MQTT (teste sem hardware).
 *
 * Exemplos:
 *   npm run simulador -- normal
 *   npm run simulador -- vazamento --comodo sala --quantidade 10
 *   npm run simulador -- sequencia --host 192.168.1.10 --intervalo 2
 *   npm run simulador -- invalido
 *   npm run simulador -- sequencia --dry-run        (só imprime, não conecta)
 *
 * Usuário e senha vêm de --usuario/--senha ou de MQTT_USER/MQTT_PASSWORD (ambiente ou .env).
 */
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { connectAsync, type MqttClient } from 'mqtt';

import { lerArquivoEnv } from '../src/config.js';
import { mensagemErro } from '../src/log.js';

const MODOS = ['normal', 'vazamento', 'sequencia', 'invalido'] as const;
type Modo = (typeof MODOS)[number];

const PAYLOADS_INVALIDOS: Array<[descricao: string, bruto: string | Buffer]> = [
  ['leitura > 4095', '{"dispositivo": "esp32-sim", "leitura": 5000, "status": "VAZAMENTO"}'],
  ['leitura negativa', '{"dispositivo": "esp32-sim", "leitura": -3, "status": "NORMAL"}'],
  ['leitura não inteira', '{"dispositivo": "esp32-sim", "leitura": 742.5, "status": "NORMAL"}'],
  ['leitura 742.0', '{"dispositivo": "esp32-sim", "leitura": 742.0, "status": "NORMAL"}'],
  ['leitura como texto', '{"dispositivo": "esp32-sim", "leitura": "742", "status": "NORMAL"}'],
  ['status desconhecido', '{"dispositivo": "esp32-sim", "leitura": 742, "status": "ALERTA"}'],
  ['status minúsculo', '{"dispositivo": "esp32-sim", "leitura": 742, "status": "vazamento"}'],
  ['dispositivo vazio', '{"dispositivo": "", "leitura": 742, "status": "NORMAL"}'],
  ['dispositivo ausente', '{"leitura": 742, "status": "NORMAL"}'],
  ['ts inválido', '{"dispositivo": "esp32-sim", "leitura": 742, "status": "NORMAL", "ts": "ontem"}'],
  ['ts numérico', '{"dispositivo": "esp32-sim", "leitura": 742, "status": "NORMAL", "ts": 1757773327}'],
  ['campo extra', '{"dispositivo": "esp32-sim", "leitura": 742, "status": "NORMAL", "rssi": -60}'],
  ['array', '[1, 2, 3]'],
  ['não é JSON', 'isto nao e json'],
  ['bytes que não são UTF-8', Buffer.from([0xff, 0xfe, 0x7b])],
  ['vazio', ''],
];

const AJUDA = `Uso: npm run simulador -- <${MODOS.join('|')}> [opções]

  --host <ip>          broker (padrão: SIMULADOR_HOST do .env ou localhost)
  --porta <n>          porta do broker (padrão: MQTT_PORT do .env ou 1883)
  --usuario <nome>     padrão: MQTT_USER do .env
  --senha <senha>      padrão: MQTT_PASSWORD do .env
  --comodo <nome>      publica em casa/<comodo>/gas (padrão: cozinha)
  --dispositivo <id>   padrão: esp32-<comodo>
  --quantidade <n>     mensagens por etapa (padrão: 5)
  --intervalo <s>      segundos entre mensagens (padrão: 1)
  --sem-ts             omite o campo ts (ESP32 sem NTP)
  --dry-run            só imprime as mensagens, sem conectar`;

function montarPayload(dispositivo: string, status: 'NORMAL' | 'VAZAMENTO', comTs: boolean): string {
  const [minimo, maximo] = status === 'NORMAL' ? [150, 400] : [700, 1800];
  const dados: Record<string, unknown> = { dispositivo, leitura: randomInt(minimo, maximo + 1), status };
  if (comTs) dados.ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return JSON.stringify(dados);
}

/** Gera os payloads do modo escolhido (gerador: o ts sai na hora do envio). */
function* gerarMensagens(modo: Modo, dispositivo: string, quantidade: number, comTs: boolean): Generator<[string | Buffer, string?]> {
  if (modo === 'invalido') {
    for (const [descricao, bruto] of PAYLOADS_INVALIDOS) yield [bruto, descricao];
    return;
  }
  const etapas: Array<'NORMAL' | 'VAZAMENTO'> =
    modo === 'sequencia'
      ? [...Array(quantidade).fill('NORMAL'), ...Array(quantidade).fill('VAZAMENTO'), ...Array(quantidade).fill('NORMAL')]
      : Array(quantidade).fill(modo === 'normal' ? 'NORMAL' : 'VAZAMENTO');
  for (const status of etapas) yield [montarPayload(dispositivo, status, comTs)];
}

function numero(texto: string | undefined, nome: string, { inteiro = false, minimo = 0 } = {}): number {
  const valor = Number(texto);
  if (texto === undefined || !Number.isFinite(valor) || (inteiro && !Number.isInteger(valor)) || valor < minimo) {
    throw new Error(`--${nome} inválido: ${texto}`);
  }
  return valor;
}

async function publicar(cliente: MqttClient, topico: string, payload: string | Buffer): Promise<void> {
  // Espera o PUBACK (QoS 1). Sem resposta em 10 s, considera que o broker não confirmou.
  const limite = esperar(10_000, 'tempo esgotado', { ref: false });
  const resultado = await Promise.race([cliente.publishAsync(topico, payload, { qos: 1 }).then(() => 'ok'), limite]);
  if (resultado !== 'ok') throw new Error('mensagem não confirmada pelo broker em 10 s');
}

async function main(argv: string[]): Promise<number> {
  lerArquivoEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));

  let opcoes;
  try {
    opcoes = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        host: { type: 'string', default: process.env.SIMULADOR_HOST || 'localhost' },
        porta: { type: 'string', default: process.env.MQTT_PORT || '1883' },
        usuario: { type: 'string', default: process.env.MQTT_USER ?? '' },
        senha: { type: 'string', default: process.env.MQTT_PASSWORD ?? '' },
        comodo: { type: 'string', default: 'cozinha' },
        dispositivo: { type: 'string' },
        quantidade: { type: 'string', default: '5' },
        intervalo: { type: 'string', default: '1' },
        'sem-ts': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (erro) {
    console.error(`ERRO: ${(erro as Error).message}\n\n${AJUDA}`);
    return 2;
  }
  const { values: v, positionals } = opcoes;
  if (v.help) {
    console.log(AJUDA);
    return 0;
  }
  const modo = positionals[0] as Modo | undefined;
  if (modo === undefined || !MODOS.includes(modo) || positionals.length > 1) {
    console.error(`ERRO: informe um modo (${MODOS.join(', ')}).\n\n${AJUDA}`);
    return 2;
  }

  let porta: number, quantidade: number, intervalo: number;
  try {
    porta = numero(v.porta, 'porta', { inteiro: true, minimo: 1 });
    quantidade = numero(v.quantidade, 'quantidade', { inteiro: true, minimo: 1 });
    intervalo = numero(v.intervalo, 'intervalo');
  } catch (erro) {
    console.error(`ERRO: ${(erro as Error).message}`);
    return 2;
  }

  const dispositivo = v.dispositivo ?? `esp32-${v.comodo}`;
  const topico = `casa/${v.comodo}/gas`;

  let cliente: MqttClient | null = null;
  if (!v['dry-run']) {
    const host = v.host.includes(':') ? `[${v.host}]` : v.host; // IPv6 vai entre colchetes na URL
    try {
      cliente = await connectAsync(
        `mqtt://${host}:${porta}`,
        {
          username: v.usuario || undefined,
          password: v.senha || undefined,
          clientId: `simulador-${randomInt(100_000)}`,
          connectTimeout: 10_000,
          reconnectPeriod: 0,
        },
        false,
      );
    } catch (erro) {
      const motivo = mensagemErro(erro);
      if (/not authori[sz]ed|bad user ?name or password/i.test(motivo)) {
        console.error(`ERRO: o broker ${v.host}:${porta} recusou as credenciais (${motivo}). Confira --usuario/--senha ou MQTT_USER/MQTT_PASSWORD no .env.`);
      } else {
        console.error(`ERRO: não foi possível conectar ao broker ${v.host}:${porta} (${motivo}).`);
      }
      return 1;
    }
    console.log(`Conectado a ${v.host}:${porta}, publicando em ${topico}`);
  }

  try {
    let primeira = true;
    for (const [payload, descricao] of gerarMensagens(modo, dispositivo, quantidade, !v['sem-ts'])) {
      if (!primeira && intervalo > 0) await esperar(intervalo * 1000);
      primeira = false;
      if (cliente !== null) await publicar(cliente, topico, payload);
      const texto = typeof payload === 'string' ? payload : payload.toString('utf8');
      console.log(`${topico} <- ${texto || '(vazio)'}${descricao ? `   # ${descricao}` : ''}`);
    }
  } catch (erro) {
    console.error(`ERRO: ${(erro as Error).message}`);
    return 1;
  } finally {
    // force: cada publicação já foi confirmada; se alguma falhou, não espera um PUBACK que não vem.
    await cliente?.endAsync(true);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
