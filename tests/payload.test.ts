import { describe, expect, it } from 'vitest';

import { extrairComodo, interpretarDataIso, textoBruto, validarPayload, type ErroCampo, type PayloadGas } from '../src/schemas.js';

const BASE = { dispositivo: 'esp32-cozinha', leitura: 742, status: 'VAZAMENTO' };

const bytes = (texto: string): Buffer => Buffer.from(texto, 'utf8');
const json = (dados: unknown): Buffer => bytes(JSON.stringify(dados));
const comCampos = (campos: Record<string, unknown>): Buffer => json({ ...BASE, ...campos });

function valido(bruto: Uint8Array): PayloadGas {
  const resultado = validarPayload(bruto);
  if (!resultado.ok) throw new Error(`esperava válido, veio: ${JSON.stringify(resultado.erros)}`);
  return resultado.payload;
}

function erros(bruto: Uint8Array): ErroCampo[] {
  const resultado = validarPayload(bruto);
  if (resultado.ok) throw new Error(`esperava inválido, veio: ${JSON.stringify(resultado.payload)}`);
  return resultado.erros;
}

describe('payload válido', () => {
  it('aceita o exemplo do contrato', () => {
    const p = valido(bytes('{ "dispositivo": "esp32-cozinha", "leitura": 742, "status": "VAZAMENTO", "ts": "2026-09-13T14:22:07Z" }'));
    expect(p).toEqual({ dispositivo: 'esp32-cozinha', leitura: 742, status: 'VAZAMENTO', ts: new Date('2026-09-13T14:22:07Z') });
  });

  it('ts é opcional: ausente ou null viram null', () => {
    expect(valido(json(BASE)).ts).toBeNull();
    expect(valido(comCampos({ ts: null })).ts).toBeNull();
  });

  it('ts com fuso é convertido para UTC', () => {
    expect(valido(comCampos({ ts: '2026-09-13T11:22:07-03:00' })).ts).toEqual(new Date('2026-09-13T14:22:07Z'));
  });

  it('ts sem fuso é assumido UTC (e não horário local)', () => {
    expect(valido(comCampos({ ts: '2026-09-13T14:22:07' })).ts).toEqual(new Date('2026-09-13T14:22:07Z'));
  });

  it.each([0, 4095])('aceita os limites da leitura (%i)', (leitura) => {
    expect(valido(comCampos({ leitura })).leitura).toBe(leitura);
  });

  it.each(['NORMAL', 'VAZAMENTO'])('aceita o status %s', (status) => {
    expect(valido(comCampos({ status })).status).toBe(status);
  });

  it('remove os espaços das pontas do dispositivo', () => {
    expect(valido(comCampos({ dispositivo: '  esp32-sala ' })).dispositivo).toBe('esp32-sala');
  });

  it('remove exatamente os espaços que o strip() do Python remove', () => {
    expect(valido(comCampos({ dispositivo: '\t \u0085\u001fesp　\n' })).dispositivo).toBe('esp');
    expect(valido(comCampos({ dispositivo: '﻿esp​' })).dispositivo).toBe('﻿esp​'); // não são espaço no Python
  });

  it('conta o tamanho em caracteres, não em unidades UTF-16 (64 emojis cabem no varchar(64))', () => {
    expect(valido(comCampos({ dispositivo: '🔥'.repeat(64) })).dispositivo).toHaveLength(128);
    expect(erros(comCampos({ dispositivo: '🔥'.repeat(65) }))[0]?.campo).toBe('dispositivo');
  });

  it('aceita espaços em volta do JSON', () => {
    expect(valido(bytes(`  ${JSON.stringify(BASE)}  \n`)).leitura).toBe(742);
  });
});

describe('payload inválido', () => {
  it.each([
    ['leitura', -1],
    ['leitura', 4096],
    ['leitura', 742.5],
    ['leitura', '742'],
    ['leitura', true],
    ['leitura', null],
    ['status', 'normal'],
    ['status', 'ALERTA'],
    ['status', ''],
    ['dispositivo', ''],
    ['dispositivo', '   '],
    ['dispositivo', 123],
    ['dispositivo', 'x'.repeat(65)],
    ['dispositivo', 'esp32\u0000cozinha'],
    ['ts', 'ontem'],
    ['ts', 1757773327],
    ['ts', ''],
    ['ts', '1757773327'], // a versão Python aceita (Unix time em texto); o contrato pede ISO 8601
  ])('rejeita %s = %j', (campo, valor) => {
    expect(erros(comCampos({ [campo]: valor })).map((e) => e.campo)).toEqual([campo]);
  });

  it.each(['742.0', '1e3', '7.42e2', '742.00'])('rejeita leitura escrita como número não inteiro (%s), como a versão Python', (literal) => {
    expect(erros(bytes(`{"dispositivo": "esp32-cozinha", "leitura": ${literal}, "status": "NORMAL"}`))).toEqual([
      { campo: 'leitura', erro: 'deve ser um número inteiro de 0 a 4095' },
    ]);
  });

  it('não confunde número não inteiro em outro campo com a leitura', () => {
    expect(erros(bytes('{"dispositivo": "esp32-cozinha", "leitura": 742, "status": "NORMAL", "ts": 1.0}')).map((e) => e.campo)).toEqual(['ts']);
  });

  it('rejeita campo extra, apontando o nome do campo', () => {
    expect(erros(comCampos({ rssi: -60 }))).toEqual([{ campo: 'rssi', erro: 'campo não previsto no contrato' }]);
  });

  it.each(['dispositivo', 'leitura', 'status'])('rejeita payload sem o campo obrigatório %s', (ausente) => {
    const dados: Record<string, unknown> = { ...BASE };
    delete dados[ausente];
    expect(erros(json(dados))).toEqual([{ campo: ausente, erro: 'campo obrigatório ausente' }]);
  });

  it.each([
    ['vazio', Buffer.alloc(0)],
    ['só espaços', bytes('   ')],
    ['texto que não é JSON', bytes('lixo')],
    ['array', bytes('[1, 2]')],
    ['string JSON', bytes('"texto"')],
    ['número JSON', bytes('742')],
    ['null', bytes('null')],
    ['bytes que não são UTF-8', Buffer.from([0xff, 0xfe])],
    ['JSON truncado', bytes('{"dispositivo": "a",')],
    ['JSON com BOM (a versão Python também rejeita)', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(BASE)])],
  ])('rejeita conteúdo que não é um objeto JSON: %s', (_descricao, bruto) => {
    const lista = erros(bruto);
    expect(lista).toHaveLength(1);
    expect(lista[0]?.campo).toBe('');
  });

  it('lista todos os campos com problema de uma vez', () => {
    expect(erros(json({ dispositivo: '', leitura: 9999, status: 'x' })).map((e) => e.campo)).toEqual([
      'dispositivo',
      'leitura',
      'status',
    ]);
  });
});

describe('interpretarDataIso: mesmos formatos aceitos pela versão Python', () => {
  it.each([
    ['2026-09-13T14:22:07Z', '2026-09-13T14:22:07.000Z'],
    ['2026-09-13', '2026-09-13T00:00:00.000Z'],
    ['2026-09-13T14:22', '2026-09-13T14:22:00.000Z'],
    ['2026-09-13 14:22:07', '2026-09-13T14:22:07.000Z'],
    ['2026-09-13t14:22:07z', '2026-09-13T14:22:07.000Z'],
    ['2026-09-13T14:22:07.123456789Z', '2026-09-13T14:22:07.123Z'],
    ['2026-09-13T14:22:07,5Z', '2026-09-13T14:22:07.500Z'],
    ['2026-09-13T14:22:07+0300', '2026-09-13T11:22:07.000Z'],
    ['2026-09-13T23:30:00-03:00', '2026-09-14T02:30:00.000Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['0050-01-01T00:00:00Z', '0050-01-01T00:00:00.000Z'],
  ])('aceita %s', (texto, esperado) => {
    expect(interpretarDataIso(texto)?.toISOString()).toBe(esperado);
  });

  it.each([
    '2026-09-13T14:22:07+03',
    '20260913T142207Z',
    '2026-02-30T00:00:00Z',
    '2027-02-29T00:00:00Z',
    '2026-13-01',
    '2026-09-13T24:00:00Z',
    '2026-09-13T23:59:60Z',
    '2026-09-13T23:60:00Z',
    ' 2026-09-13T14:22:07Z',
    '2026-09-13T14:22:07Z ',
    '2026-W37-7',
    '0000-01-01T00:00:00Z',
    '1757773327',
    'ontem',
    '',
  ])('rejeita %j', (texto) => {
    expect(interpretarDataIso(texto)).toBeNull();
  });
});

describe('extrairComodo', () => {
  it.each([
    ['casa/cozinha/gas', 'cozinha'],
    ['casa/area-servico/gas', 'area-servico'],
    ['casa//gas', null],
    ['casa/cozinha/temperatura', null],
    ['casa/a/b/gas', null],
    ['outra/cozinha/gas', null],
    [`casa/${'x'.repeat(64)}/gas`, 'x'.repeat(64)],
    [`casa/${'x'.repeat(65)}/gas`, null],
  ])('%s -> %s', (topico, esperado) => {
    expect(extrairComodo(topico)).toBe(esperado);
  });
});

describe('textoBruto', () => {
  it('trunca em 1000 caracteres e troca bytes inválidos por \\uFFFD', () => {
    expect(textoBruto(bytes('x'.repeat(5000)))).toHaveLength(1000);
    expect(textoBruto(Buffer.from([0x61, 0xff, 0x62]))).toBe('a�b');
  });
});
