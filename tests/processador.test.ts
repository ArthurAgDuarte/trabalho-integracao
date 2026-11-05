import { describe, expect, it } from 'vitest';

import { MaquinaAlerta } from '../src/alerta.js';
import { TelegramNotificador, type EventoNotificacao, type Notificador } from '../src/notificadores/index.js';
import { Processador, restaurarEstados } from '../src/processador.js';
import { criarLogMemoria } from './apoio/log-memoria.js';
import { payload } from './apoio/payloads.js';
import { INICIO, RelogioFalso } from './apoio/relogio-falso.js';
import { RepositorioMemoria } from './apoio/repositorio-memoria.js';

const TOPICO = 'casa/cozinha/gas';

class NotificadorQueFalha implements Notificador {
  chamadas = 0;
  async notificar(): Promise<void> {
    this.chamadas += 1;
    throw new Error('Telegram fora do ar');
  }
}

class NotificadorRegistra implements Notificador {
  readonly eventos: EventoNotificacao[] = [];
  async notificar(evento: EventoNotificacao): Promise<void> {
    this.eventos.push(evento);
  }
}

function montar(
  notificador: Notificador = new NotificadorRegistra(),
  { repositorio = new RepositorioMemoria(), relogio = new RelogioFalso(), maquina = new MaquinaAlerta(300), tempoMaxNotificacaoMs = 30_000 } = {},
) {
  const { log, linhas, comAcao } = criarLogMemoria();
  const processador = new Processador({ repositorio, maquina, notificador, log, relogio: relogio.relogio, tempoMaxNotificacaoMs });
  return { processador, repositorio, relogio, maquina, linhas, comAcao };
}

describe('Processador: gravação das leituras', () => {
  it('grava a leitura com o cômodo do tópico e o horário do servidor', async () => {
    const { processador, repositorio, comAcao } = montar();
    await processador.processarMensagem(TOPICO, payload('NORMAL', 321, 'esp32-cozinha', { ts: '2026-09-13T13:59:58Z' }));
    expect(repositorio.leituras).toEqual([
      {
        id: 1,
        dispositivo: 'esp32-cozinha',
        comodo: 'cozinha',
        leitura: 321,
        status: 'NORMAL',
        ts_dispositivo: new Date('2026-09-13T13:59:58Z'),
        recebido_em: INICIO,
      },
    ]);
    expect(comAcao('recebido')).toMatchObject([{ nivel: 'INFO', dispositivo: 'esp32-cozinha', comodo: 'cozinha', status: 'NORMAL', leitura: 321 }]);
    expect(comAcao('gravado')).toHaveLength(1);
  });

  it('payloads e tópicos inválidos não gravam nada, são logados como WARNING e o consumidor segue', async () => {
    const notificador = new NotificadorRegistra();
    const { processador, repositorio, comAcao } = montar(notificador);
    await processador.processarMensagem(TOPICO, Buffer.from('{"dispositivo": "esp32", "leitura": 9999, "status": "VAZAMENTO"}'));
    await processador.processarMensagem('casa/cozinha/temperatura', payload('VAZAMENTO'));
    await processador.processarMensagem(TOPICO, Buffer.from([0xff, 0xfe, 0x20, 0x6c, 0x69, 0x78, 0x6f]));
    expect(repositorio.leituras).toEqual([]);

    await processador.processarMensagem(TOPICO, payload('VAZAMENTO'));
    await processador.encerrar();
    expect(repositorio.leituras).toHaveLength(1);
    expect(notificador.eventos.map((e) => e.tipo)).toEqual(['INICIO_VAZAMENTO']);

    const invalidos = comAcao('invalido');
    expect(invalidos).toHaveLength(3);
    expect(invalidos.every((linha) => linha.nivel === 'WARNING')).toBe(true);
    expect(invalidos[0]).toMatchObject({
      topico: TOPICO,
      comodo: 'cozinha',
      bruto: '{"dispositivo": "esp32", "leitura": 9999, "status": "VAZAMENTO"}',
      erro: [{ campo: 'leitura', erro: 'deve ser um número inteiro de 0 a 4095' }],
    });
    expect(invalidos[1]).toMatchObject({ topico: 'casa/cozinha/temperatura' });
    expect(invalidos[2]).toMatchObject({ bruto: '�� lixo', erro: [{ campo: '', erro: 'o conteúdo não é UTF-8 válido' }] });
  });

  it('o conteúdo bruto do log é truncado em 1000 caracteres', async () => {
    const { processador, comAcao } = montar();
    await processador.processarMensagem(TOPICO, Buffer.from('x'.repeat(5000)));
    expect(comAcao('invalido')[0]?.bruto).toHaveLength(1000);
  });

  it('processa uma mensagem por vez, na ordem, mesmo sem esperar a anterior', async () => {
    const { processador, repositorio } = montar();
    await Promise.all([1, 2, 3, 4, 5].map((i) => processador.processarMensagem(TOPICO, payload('NORMAL', i))));
    expect(repositorio.leituras.map((l) => l.leitura)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Processador: alertas e isolamento de falhas', () => {
  it('notificador que rejeita: as leituras ficam gravadas e o evento fica com notificado=false e o erro', async () => {
    const notificador = new NotificadorQueFalha();
    const { processador, repositorio, relogio } = montar(notificador);
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800));
    relogio.avancar(10);
    await processador.processarMensagem(TOPICO, payload('NORMAL', 200));
    await processador.encerrar();

    expect(repositorio.leituras.map((l) => [l.status, l.leitura, l.comodo])).toEqual([
      ['VAZAMENTO', 800, 'cozinha'],
      ['NORMAL', 200, 'cozinha'],
    ]);
    expect(repositorio.eventos.map((e) => [e.tipo, e.notificado, e.erro_notificacao])).toEqual([
      ['INICIO_VAZAMENTO', false, 'Error: Telegram fora do ar'],
      ['NORMALIZADO', false, 'Error: Telegram fora do ar'],
    ]);
    expect(notificador.chamadas).toBe(2);
  });

  it('a falha de notificação aparece no log como notificacao_falhou (ERROR), depois de recebido/gravado/alerta_disparado', async () => {
    const { processador, linhas, comAcao } = montar(new NotificadorQueFalha());
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800));
    await processador.encerrar();
    expect(comAcao('notificacao_falhou')).toMatchObject([
      { nivel: 'ERROR', dispositivo: 'esp32-cozinha', tipo: 'INICIO_VAZAMENTO', evento_id: 1, erro: 'Error: Telegram fora do ar' },
    ]);
    expect(linhas.map((l) => l.acao)).toEqual(['recebido', 'gravado', 'alerta_disparado', 'notificacao_falhou']);
  });

  it('notificador ok: notificado=true, e ele recebe o evento como objeto simples', async () => {
    const notificador = new NotificadorRegistra();
    const { processador, repositorio, comAcao } = montar(notificador);
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 900));
    await processador.encerrar();

    expect(repositorio.eventos).toMatchObject([{ notificado: true, erro_notificacao: null }]);
    expect(notificador.eventos).toEqual([
      { id: 1, dispositivo: 'esp32-cozinha', comodo: 'cozinha', tipo: 'INICIO_VAZAMENTO', leitura: 900, criadoEm: INICIO },
    ]);
    expect(comAcao('notificacao_enviada')).toMatchObject([{ nivel: 'INFO', evento_id: 1 }]);
  });

  it('12 leituras de vazamento a cada 60 s geram exatamente INICIO + 2 LEMBRETEs', async () => {
    const notificador = new NotificadorRegistra();
    const { processador, repositorio, relogio } = montar(notificador);
    for (let i = 0; i < 12; i++) {
      await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800));
      relogio.avancar(60);
    }
    await processador.encerrar();
    expect(repositorio.leituras).toHaveLength(12);
    expect(notificador.eventos.map((e) => e.tipo)).toEqual(['INICIO_VAZAMENTO', 'LEMBRETE', 'LEMBRETE']);
    expect(repositorio.eventos.map((e) => e.criado_em)).toEqual([INICIO, new Date(INICIO.getTime() + 300_000), new Date(INICIO.getTime() + 600_000)]);
  });

  it('leitura normal não gera evento nem notificação', async () => {
    const notificador = new NotificadorRegistra();
    const { processador, repositorio } = montar(notificador);
    await processador.processarMensagem(TOPICO, payload('NORMAL', 100));
    await processador.encerrar();
    expect(repositorio.leituras).toHaveLength(1);
    expect(repositorio.eventos).toEqual([]);
    expect(notificador.eventos).toEqual([]);
  });

  it('alerta_disparado é WARNING para início e lembrete, INFO para normalizado', async () => {
    const { processador, relogio, comAcao } = montar();
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO'));
    relogio.avancar(300);
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO'));
    relogio.avancar(1);
    await processador.processarMensagem(TOPICO, payload('NORMAL'));
    expect(comAcao('alerta_disparado').map((l) => [l.tipo, l.nivel])).toEqual([
      ['INICIO_VAZAMENTO', 'WARNING'],
      ['LEMBRETE', 'WARNING'],
      ['NORMALIZADO', 'INFO'],
    ]);
  });

  it('falha do banco não lança exceção e não perde o INICIO na leitura seguinte', async () => {
    const notificador = new NotificadorRegistra();
    const { processador, repositorio, comAcao } = montar(notificador);
    repositorio.falharGravacoes = true;
    await expect(processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800))).resolves.toBeUndefined();
    expect(comAcao('erro_gravacao')).toMatchObject([{ nivel: 'ERROR', erro: 'Error: banco fora do ar (simulado)', dispositivo: 'esp32-cozinha' }]);

    repositorio.falharGravacoes = false; // o banco voltou
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 810));
    await processador.encerrar();
    expect(repositorio.eventos.map((e) => [e.tipo, e.leitura])).toEqual([['INICIO_VAZAMENTO', 810]]);
    expect(notificador.eventos).toHaveLength(1);
  });

  it('restaurar os estados evita alerta duplicado depois de um restart', async () => {
    const repositorio = new RepositorioMemoria();
    const relogio = new RelogioFalso();
    const antes = montar(new NotificadorRegistra(), { repositorio, relogio });
    await antes.processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800));
    await antes.processador.encerrar();

    // "Reinicia" a API: máquina nova, estado carregado do banco.
    const maquina = new MaquinaAlerta(300);
    expect(await restaurarEstados(repositorio, maquina)).toBe(1);
    const notificador = new NotificadorRegistra();
    const depois = montar(notificador, { repositorio, relogio, maquina });
    relogio.avancar(60);
    await depois.processador.processarMensagem(TOPICO, payload('VAZAMENTO', 820));
    relogio.avancar(240); // 300 s desde o INICIO gravado antes do restart: o cooldown foi mantido
    await depois.processador.processarMensagem(TOPICO, payload('VAZAMENTO', 830));
    relogio.avancar(10);
    await depois.processador.processarMensagem(TOPICO, payload('NORMAL', 200));
    await depois.processador.encerrar();
    expect(notificador.eventos.map((e) => e.tipo)).toEqual(['LEMBRETE', 'NORMALIZADO']);
  });

  it('o stub do Telegram registra o erro sem perder a leitura (e sem vazar o token)', async () => {
    const { processador, repositorio } = montar(new TelegramNotificador({ token: '123:token-secreto', chatId: '42' }));
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800));
    await processador.encerrar();
    expect(repositorio.leituras).toHaveLength(1);
    const [evento] = repositorio.eventos;
    expect(evento?.notificado).toBe(false);
    expect(evento?.erro_notificacao).toMatch(/^NaoImplementadoError: TelegramNotificador ainda não implementado/);
    expect(evento?.erro_notificacao).not.toContain('token-secreto');
  });

  it('um notificador lento não segura o recebimento de leituras', async () => {
    let liberar: () => void = () => {};
    const lento: Notificador = { notificar: () => new Promise<void>((resolve) => (liberar = resolve)) };
    const { processador, repositorio, relogio } = montar(lento);
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 800));
    for (let i = 0; i < 3; i++) {
      relogio.avancar(1);
      await processador.processarMensagem(TOPICO, payload('VAZAMENTO', 801 + i));
    }
    expect(repositorio.leituras).toHaveLength(4); // gravadas enquanto a notificação está pendente
    expect(repositorio.eventos[0]?.notificado).toBe(false);
    liberar();
    await processador.encerrar();
    expect(repositorio.eventos[0]?.notificado).toBe(true);
  });

  it('as notificações saem uma de cada vez, na ordem dos eventos', async () => {
    const registro: string[] = [];
    let emAndamento = 0;
    const notificador: Notificador = {
      async notificar(evento) {
        emAndamento += 1;
        registro.push(`${evento.tipo}:${emAndamento}`);
        await new Promise((resolve) => setTimeout(resolve, evento.tipo === 'INICIO_VAZAMENTO' ? 20 : 1));
        emAndamento -= 1;
      },
    };
    const { processador, relogio } = montar(notificador);
    for (const status of ['VAZAMENTO', 'NORMAL', 'VAZAMENTO', 'NORMAL'] as const) {
      await processador.processarMensagem(TOPICO, payload(status));
      relogio.avancar(1);
    }
    await processador.encerrar();
    expect(registro).toEqual(['INICIO_VAZAMENTO:1', 'NORMALIZADO:1', 'INICIO_VAZAMENTO:1', 'NORMALIZADO:1']);
  });

  it('um notificador que nunca responde é abandonado depois do prazo, e a fila segue', async () => {
    let chamada = 0;
    const notificador: Notificador = {
      notificar: () => (++chamada === 1 ? new Promise<void>(() => {}) : Promise.resolve()),
    };
    const { processador, repositorio, relogio } = montar(notificador, { tempoMaxNotificacaoMs: 50 });
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO'));
    relogio.avancar(1);
    await processador.processarMensagem(TOPICO, payload('NORMAL'));
    await processador.encerrar();
    expect(repositorio.eventos.map((e) => [e.tipo, e.notificado, e.erro_notificacao])).toEqual([
      ['INICIO_VAZAMENTO', false, 'TimeoutError: o notificador não respondeu em 0.05 s'],
      ['NORMALIZADO', true, null],
    ]);
  });

  it('notificador que lança de forma síncrona também é tratado, e o erro é truncado em 1000 caracteres', async () => {
    const notificador = {
      notificar(): Promise<void> {
        throw new Error('x'.repeat(5000));
      },
    };
    const { processador, repositorio } = montar(notificador);
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO'));
    await processador.encerrar();
    expect(repositorio.eventos[0]?.erro_notificacao).toHaveLength(1000);
  });

  it('falha ao registrar o resultado da notificação é logada e não derruba nada', async () => {
    const { processador, repositorio, comAcao } = montar();
    repositorio.registrarNotificacao = async () => {
      throw new Error('banco caiu');
    };
    await processador.processarMensagem(TOPICO, payload('VAZAMENTO'));
    await expect(processador.encerrar()).resolves.toBeUndefined();
    expect(comAcao('erro_gravacao')).toMatchObject([{ nivel: 'ERROR', evento_id: 1, erro: 'Error: banco caiu' }]);
    expect(repositorio.leituras).toHaveLength(1);
  });
});
